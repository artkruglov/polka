// Service accounts (docs/specs/DATA_MODELS.md §3, §4; off until
// SERVICE_ACCOUNTS=on): an agent for cron or CI on one shelf with a named
// person responsible for it. Its tokens are agent_connections rows of type
// 'service' whose account_id is that person, so the shelf's role checks
// apply to them as to the person. Leaving the shelf freezes the account
// (migration 058); an admin names another responsible person to thaw it.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { MCP_AUDIENCE, assertScopesFitRole, type ServiceActor } from "./service-auth.ts";
import { agentScopeSchema, type AgentScope } from "../../packages/contracts/index.ts";
import { audit } from "./artifacts.ts";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { atLeast, lockShelf } from "./shelves.ts";
import { sha256 } from "./storage.ts";

type Actor = { id: string; tenant: string };

export const MAX_SERVICE_PRINCIPALS = 20;
export const SERVICE_TOKEN_MAX_DAYS = 90;
export const MAX_LIVE_TASK_TOKENS = 20;
export const TASK_TOKEN_MIN_MINUTES = 5;
export const TASK_TOKEN_MAX_MINUTES = 60;
/** What an unattended agent may hold: no folder management, no sign-in links. */
const SERVICE_SCOPES: readonly AgentScope[] = ["context", "read", "source:read", "capture", "revise", "share"];

const enabled = () => {
  if (config.SERVICE_ACCOUNTS !== "on") throw missing();
};

const scopesSchema = z
  .array(agentScopeSchema)
  .min(1)
  .max(SERVICE_SCOPES.length)
  .transform((scopes) => [...new Set(scopes)].sort() as AgentScope[])
  .superRefine((scopes, ctx) => {
    if (scopes.some((scope) => !SERVICE_SCOPES.includes(scope)))
      ctx.addIssue({ code: "custom", message: "Сервисному доступу нельзя manage и sign_in." });
    if (scopes.includes("read") && scopes.includes("share"))
      ctx.addIssue({ code: "custom", message: "Права read и share вместе сервисному доступу не выдаются." });
  });

const createInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: scopesSchema.default(["capture", "context"]),
    ttlDays: z.number().int().min(1).max(SERVICE_TOKEN_MAX_DAYS).default(30),
  })
  .strict();
const rotateInput = z
  .object({ ttlDays: z.number().int().min(1).max(SERVICE_TOKEN_MAX_DAYS).default(30) })
  .strict();
const responsibleInput = z
  .object({
    accountId: z.string().uuid(),
    ttlDays: z.number().int().min(1).max(SERVICE_TOKEN_MAX_DAYS).default(30),
  })
  .strict();
const taskInput = z
  .object({
    scopes: scopesSchema.optional(),
    minutes: z.number().int().min(TASK_TOKEN_MIN_MINUTES).max(TASK_TOKEN_MAX_MINUTES).default(15),
    taskId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

async function issueToken(
  c: PoolClient,
  principal: { id: string; tenant_id: string; name: string },
  responsibleId: string,
  scopes: AgentScope[],
  ttlDays: number,
) {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  await c.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,
       principal_type,service_principal_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day','service',$9)`,
    [id, principal.tenant_id, responsibleId, sha256(token), principal.name, scopes, MCP_AUDIENCE, ttlDays, principal.id],
  );
  return { id, token };
}

/** A curator makes a service account on the open shelf and answers for it. */
export async function createServicePrincipal(actor: Actor, body: unknown) {
  enabled();
  const input = createInput.parse(body);
  return transaction(async (c) => {
    const { role, tenant } = await lockShelf(c, actor, "curator");
    // A personal shelf can be merged into another account, which would orphan the token.
    if (tenant.kind !== "team")
      throw new Problem(422, "invalid", "Сервисные доступы заводятся на полках отделов.");
    assertScopesFitRole(role, input.scopes);
    const {
      rows: [count],
    } = await c.query(
      "SELECT count(*)::int AS n FROM service_principals WHERE tenant_id=$1 AND status<>'disabled'",
      [actor.tenant],
    );
    if (count.n >= MAX_SERVICE_PRINCIPALS)
      throw new Problem(413, "quota", "Достигнут лимит сервисных доступов на полке.");
    let principal;
    try {
      ({
        rows: [principal],
      } = await c.query(
        `INSERT INTO service_principals(tenant_id,name,responsible_account_id,created_by)
         VALUES($1,$2,$3,$3) RETURNING *`,
        [actor.tenant, input.name, actor.id],
      ));
    } catch (error: any) {
      if (error?.code === "23505")
        throw new Problem(409, "conflict", "Сервисный доступ с таким названием уже есть.");
      throw error;
    }
    const { id, token } = await issueToken(c, principal, actor.id, input.scopes, input.ttlDays);
    await audit(c, actor, "service_account.created", principal.id, { connectionId: id });
    return { servicePrincipal: dto(principal, null), token, scopes: input.scopes, ttlDays: input.ttlDays };
  });
}

const dto = (row: any, connection: any) => ({
  id: row.id as string,
  name: row.name as string,
  status: row.status as "active" | "frozen" | "disabled",
  responsibleAccountId: row.responsible_account_id as string,
  ...(row.responsible_name ? { responsibleName: row.responsible_name as string } : {}),
  createdAt: new Date(row.created_at).toISOString(),
  frozenAt: row.frozen_at ? new Date(row.frozen_at).toISOString() : null,
  token: connection
    ? {
        scopes: connection.scopes as AgentScope[],
        expiresAt: new Date(connection.expires_at).toISOString(),
        lastSeenAt: connection.last_seen_at ? new Date(connection.last_seen_at).toISOString() : null,
      }
    : null,
});

/** The shelf's service accounts, for its curators. */
export async function listServicePrincipals(actor: Actor) {
  enabled();
  return transaction(async (c) => {
    await lockShelf(c, actor, "curator", "SHARE");
    const { rows } = await c.query(
      `SELECT principal.*,COALESCE(person.display_name,person.name) AS responsible_name,
              live.scopes,live.expires_at,live.last_seen_at
       FROM service_principals principal
       JOIN accounts person ON person.id=principal.responsible_account_id
       LEFT JOIN LATERAL (
         SELECT scopes,expires_at,last_seen_at FROM agent_connections
         WHERE service_principal_id=principal.id AND parent_id IS NULL
           AND revoked_at IS NULL AND expires_at>now()
         ORDER BY created_at DESC LIMIT 1) live ON true
       WHERE principal.tenant_id=$1 AND principal.status<>'disabled'
       ORDER BY lower(principal.name)`,
      [actor.tenant],
    );
    return { items: rows.map((row) => dto(row, row.scopes ? row : null)) };
  });
}

async function lockPrincipal(c: PoolClient, actor: Actor, id: string) {
  const {
    rows: [principal],
  } = await c.query(
    "SELECT * FROM service_principals WHERE id=$1 AND tenant_id=$2 AND status<>'disabled' FOR UPDATE",
    [id, actor.tenant],
  );
  if (!principal) throw missing();
  return principal;
}

/** A new token for the account; the old ones stop at once. */
export async function rotateServiceToken(actor: Actor, id: string, body: unknown) {
  enabled();
  const input = rotateInput.parse(body ?? {});
  return transaction(async (c) => {
    const { role } = await lockShelf(c, actor, "curator");
    const principal = await lockPrincipal(c, actor, id);
    // The token acts as the responsible person: they or an admin hand out a new one.
    if (principal.responsible_account_id !== actor.id && !atLeast(role, "admin"))
      throw new Problem(403, "forbidden", "Новый токен выдаёт ответственный или администратор полки.");
    if (principal.status !== "active")
      throw new Problem(409, "conflict", "Сервисный доступ заморожен: сначала назначьте ответственного.");
    const {
      rows: [last],
    } = await c.query(
      `SELECT scopes FROM agent_connections WHERE service_principal_id=$1 AND parent_id IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    await c.query(
      "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE service_principal_id=$1 AND revoked_at IS NULL",
      [id],
    );
    const { id: connectionId, token } = await issueToken(
      c,
      principal,
      principal.responsible_account_id,
      last?.scopes ?? ["capture", "context"],
      input.ttlDays,
    );
    await audit(c, actor, "service_account.rotated", id, { connectionId });
    return { servicePrincipalId: id, token, ttlDays: input.ttlDays };
  });
}

/** The account and all its tokens end. */
export async function disableServicePrincipal(actor: Actor, id: string) {
  enabled();
  return transaction(async (c) => {
    await lockShelf(c, actor, "curator");
    await lockPrincipal(c, actor, id);
    await c.query(
      "UPDATE service_principals SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    await c.query(
      "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE service_principal_id=$1 AND revoked_at IS NULL",
      [id],
    );
    await audit(c, actor, "service_account.disabled", id);
    return { ok: true };
  });
}

/** An admin names the person responsible; a frozen account thaws. */
export async function setServiceResponsible(actor: Actor, id: string, body: unknown) {
  enabled();
  const input = responsibleInput.parse(body);
  const { accountId } = input;
  return transaction(async (c) => {
    await lockShelf(c, actor, "admin");
    const principal = await lockPrincipal(c, actor, id);
    const {
      rows: [member],
    } = await c.query(
      `SELECT member.role FROM tenant_members member JOIN accounts person ON person.id=member.account_id
       WHERE member.tenant_id=$1 AND member.account_id=$2 AND member.state='active'
         AND NOT person.disabled AND person.deletion_requested_at IS NULL`,
      [actor.tenant, accountId],
    );
    if (!member || !atLeast(member.role, "curator"))
      throw new Problem(422, "invalid", "Ответственным может быть куратор или администратор этой полки.");
    const {
      rows: [last],
    } = await c.query(
      `SELECT scopes FROM agent_connections WHERE service_principal_id=$1 AND parent_id IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    // The old tokens may sit with the person who left (or with the previous
    // responsible one): they end, and the new person gets a fresh one.
    await c.query(
      "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE service_principal_id=$1 AND revoked_at IS NULL",
      [id],
    );
    await c.query(
      `UPDATE service_principals SET responsible_account_id=$2,status='active',frozen_at=NULL WHERE id=$1`,
      [id, accountId],
    );
    const { id: connectionId, token } = await issueToken(
      c,
      principal,
      accountId,
      last?.scopes ?? ["capture", "context"],
      input.ttlDays,
    );
    await audit(c, actor, "service_account.responsible_changed", id, { responsibleAccountId: accountId, connectionId });
    return { ok: true, responsibleAccountId: accountId, token, ttlDays: input.ttlDays };
  });
}

/**
 * A service account asks for a short token for one job: a child of its own
 * token (parent_id), a subset of its scopes, 5–60 minutes. It stops with the
 * parent, and a task token cannot mint another.
 */
export async function createTaskToken(actor: ServiceActor, body: unknown) {
  enabled();
  const input = taskInput.parse(body ?? {});
  if (actor.principal !== "service" || !actor.servicePrincipalId)
    throw new Problem(403, "forbidden", "Токен для задачи выдаёт сервисный доступ.");
  const parentId = actor.connectionId;
  return transaction(async (c) => {
    const {
      rows: [parent],
    } = await c.query(
      `SELECT * FROM agent_connections WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR SHARE`,
      [parentId],
    );
    if (!parent) throw new Problem(401, "unauthorized", "Подключение агента недействительно.");
    if (parent.parent_id)
      throw new Problem(403, "forbidden", "Токен для задачи не выдаёт другие токены.");
    const {
      rows: [live],
    } = await c.query(
      "SELECT count(*)::int AS n FROM agent_connections WHERE parent_id=$1 AND revoked_at IS NULL AND expires_at>now()",
      [parentId],
    );
    if (live.n >= MAX_LIVE_TASK_TOKENS)
      throw new Problem(413, "quota", "Слишком много действующих токенов для задач: дождитесь окончания прежних.");
    const scopes = (input.scopes ?? parent.scopes) as AgentScope[];
    if (scopes.some((scope) => !parent.scopes.includes(scope)))
      throw new Problem(403, "forbidden", "Токен для задачи не может иметь прав больше, чем у сервисного доступа.");
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    await c.query(
      `INSERT INTO agent_connections(
         id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,
         parent_id,principal_type,service_principal_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 minute',$9,'service',$10)`,
      [
        id,
        parent.tenant_id,
        parent.account_id,
        sha256(token),
        `task:${parent.name}`.slice(0, 80),
        scopes,
        parent.audience,
        input.minutes,
        parentId,
        parent.service_principal_id,
      ],
    );
    await audit(c, { id: parent.account_id, tenant: parent.tenant_id, connectionId: parentId }, "service_account.task_token", id, {
      servicePrincipalId: parent.service_principal_id,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      minutes: input.minutes,
    });
    return {
      token,
      expiresAt: new Date(Date.now() + input.minutes * 60_000).toISOString(), // the app's clock, within seconds of the database's
      scopes,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
  });
}

