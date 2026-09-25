import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { MAX_TITLE, uuid } from "../../../packages/contracts/index.ts";
import type { Actor } from "../artifacts.ts";
import { lockShelf } from "../shelves.ts";
import { Problem, missing } from "../errors.ts";
import { MCP_AUDIENCE } from "../service-auth.ts";
import { publicUrl, ImportFetchError } from "./public-fetch.ts";

export const importRequestSchema = z
  .object({
    key: uuid,
    url: z.string().trim().min(1).max(2048),
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
    folderId: uuid.optional(),
  })
  .strict();
export async function authorizeImport(c: PoolClient, actor: Actor) {
  // Saving on the shelf: an author or above (docs/specs/TEAM_SHELVES.md).
  await lockShelf(c, actor, "author");
  if (actor.connectionId) {
    const result = await c.query(
      `SELECT id FROM agent_connections WHERE id=$1 AND tenant_id=$2 AND account_id=$3 AND audience=$4 AND revoked_at IS NULL AND expires_at>now() AND 'capture'=ANY(scopes) FOR UPDATE`,
      [actor.connectionId, actor.tenant, actor.id, MCP_AUDIENCE],
    );
    if (!result.rowCount)
      throw new Problem(403, "forbidden", "Подключению недоступен импорт.");
  }
}
export function importJobView(row: any) {
  return {
    id: row.id,
    state: row.state,
    receipt: row.receipt ?? null,
    warnings: row.warnings ?? [],
    errorCode: row.error_code ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
/** All methods run within the caller's DB transaction. Never expose prepared bytes or raw URLs. */
export async function createImportJob(
  c: PoolClient,
  actor: Actor,
  body: unknown,
) {
  const input = importRequestSchema.parse(body);
  let url: string;
  try {
    url = publicUrl(input.url).href;
  } catch (error) {
    if (error instanceof ImportFetchError)
      throw new Problem(400, "invalid", error.message);
    throw error;
  }
  const request = {
    url,
    title: input.title ?? null,
    folderId: input.folderId ?? null,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  await authorizeImport(c, actor);
  const old = (
    await c.query(
      "SELECT * FROM url_import_jobs WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [actor.tenant, input.key],
    )
  ).rows[0];
  if (old) {
    if (
      old.account_id !== actor.id ||
      old.connection_id !== (actor.connectionId ?? null) ||
      old.request_hash !== hash
    )
      throw new Problem(409, "conflict", "Ключ относится к другому импорту.");
    return importJobView(old);
  }
  if (
    input.folderId &&
    !(
      await c.query("SELECT id FROM folders WHERE id=$1 AND tenant_id=$2", [
        input.folderId,
        actor.tenant,
      ])
    ).rowCount
  )
    throw missing();
  const pending = await c.query(
    "SELECT count(*)::integer n FROM url_import_jobs WHERE tenant_id=$1 AND state IN ('queued','fetching','rendering','prepared','saving','previewing') AND expires_at>now()",
    [actor.tenant],
  );
  if (pending.rows[0].n >= 5)
    throw new Problem(429, "quota", "Дождитесь завершения текущих импортов.");
  const row = (
    await c.query(
      "INSERT INTO url_import_jobs(id,tenant_id,account_id,connection_id,idempotency_key,request,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        randomUUID(),
        actor.tenant,
        actor.id,
        actor.connectionId ?? null,
        input.key,
        request,
        hash,
      ],
    )
  ).rows[0];
  return importJobView(row);
}
export async function getImportJob(c: PoolClient, actor: Actor, id: string) {
  await authorizeImport(c, actor);
  const row = (
    await c.query(
      "SELECT * FROM url_import_jobs WHERE id=$1 AND tenant_id=$2 AND account_id=$3 AND connection_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE",
      [uuid.parse(id), actor.tenant, actor.id, actor.connectionId ?? null],
    )
  ).rows[0];
  if (!row) throw missing();
  return row;
}
export async function cancelImportJob(c: PoolClient, actor: Actor, id: string) {
  const row = await getImportJob(c, actor, id);
  if (
    row.receipt ||
    ["ready", "partial", "failed", "cancelled"].includes(row.state)
  )
    return importJobView(row);
  const updated = (
    await c.query(
      "UPDATE url_import_jobs SET state='cancelled',prepared=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [row.id],
    )
  ).rows[0];
  return importJobView(updated);
}
/** Internal worker only. SKIP LOCKED assigns a lease; every worker write must call requireImportLease. */
export async function claimImportJob(c: PoolClient) {
  const row = (
    await c.query(
      `SELECT * FROM url_import_jobs WHERE state IN ('queued','fetching','rendering','prepared','saving','previewing') AND expires_at>now() AND (lease_until IS NULL OR lease_until<now()) AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
    )
  ).rows[0];
  if (!row) return null;
  const token = randomUUID();
  return (
    await c.query(
      "UPDATE url_import_jobs SET state=CASE WHEN receipt IS NOT NULL THEN 'previewing' WHEN prepared IS NULL THEN 'fetching' ELSE 'prepared' END,lease_token=$2,lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *",
      [row.id, token],
    )
  ).rows[0];
}
export async function requireImportLease(
  c: PoolClient,
  id: string,
  token: string,
) {
  const row = (
    await c.query(
      "SELECT * FROM url_import_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND expires_at>now() AND state IN ('fetching','rendering','prepared','saving','previewing') FOR UPDATE",
      [id, token],
    )
  ).rows[0];
  if (!row)
    throw new Problem(
      409,
      "conflict",
      "Задание отменено или передано другому исполнителю.",
    );
  return row;
}
