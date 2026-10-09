// A personal shelf moved to another installation (docs/specs/SHELF_TRANSFER.md):
// the inventory of every work with all its versions, page by page, and each
// version's file bytes, for scripts/polka-export.mjs. The trash goes too; a
// work its owner deleted (purged) does not. scripts/shelf-import.ts reads the
// result back on the other side.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PROJECT_MAX_FILES, uuid } from "../../packages/contracts/index.ts";
import { SHELF_EXPORT_FORMAT, type ShelfExportPage } from "../../packages/contracts/shelf-export.ts";
import { agentFolderScope } from "./agent-scope.ts";
import { countAgentRead } from "./agent-read-counter.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { recheckServiceActor, type ServiceActor } from "./service-auth.ts";
import { unavailableSql } from "./revision-availability.ts";
import { readStoredFile, storedRevisionFiles } from "./work-files.ts";

const POLKA_VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export const shelfExportInputSchema = z
  .object({
    /** The id of the last work of the previous page. */
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();

/** A page stops adding works past this many versions (a work always comes whole). */
export const EXPORT_PAGE_REVISIONS = 1000;

/**
 * The token may export: read and source:read, the whole personal shelf (not
 * a token limited to folders, not a department shelf).
 */
async function exporter(actor: ServiceActor) {
  const verified = await recheckServiceActor(actor, "source:read");
  if (!verified.scopes.includes("read"))
    throw new Problem(403, "forbidden", "Для переноса полки токену нужны права read и source:read.");
  const scope = await agentFolderScope(db, {
    id: verified.accountId,
    tenant: verified.tenantId,
    connectionId: verified.connectionId,
  });
  if (scope) throw new Problem(403, "forbidden", "Токен ограничен папками: для переноса нужна вся полка.");
  const {
    rows: [shelf],
  } = await db.query(
    `SELECT tenant.kind,tenant.card_md,owner.email
       FROM tenants tenant JOIN accounts owner ON owner.id=tenant.owner_id
      WHERE tenant.id=$1 AND tenant.owner_id=$2 AND owner.deletion_requested_at IS NULL`,
    [verified.tenantId, verified.accountId],
  );
  if (!shelf || shelf.kind !== "personal") throw new Problem(403, "forbidden", "Переносится только своя личная полка.");
  return { verified, shelf };
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

export async function shelfExportForAgent(
  actor: ServiceActor,
  raw: z.input<typeof shelfExportInputSchema>,
): Promise<ShelfExportPage> {
  const input = shelfExportInputSchema.parse(raw);
  const { verified, shelf } = await exporter(actor);
  const tenant = verified.tenantId;
  const { rows: works } = await db.query(
    `SELECT id,title,folder_id,updated_at,trashed_at,owner_account_id,accepted_revision_id
       FROM artifacts
      WHERE tenant_id=$1 AND purged_at IS NULL AND latest_revision_id IS NOT NULL
        AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,
    [tenant, input.cursor ?? null, input.limit + 1],
  );
  const more = works.length > input.limit;
  const candidates = works.slice(0, input.limit);
  const ids = candidates.map((work) => work.id);
  const { rows: revisions } = await db.query(
    `SELECT r.*,${unavailableSql("r")} AS unavailable
       FROM revisions r WHERE r.tenant_id=$1 AND r.artifact_id=ANY($2::uuid[])
      ORDER BY r.artifact_id,r.number`,
    [tenant, ids],
  );
  const { rows: accepted } = await db.query(
    `SELECT DISTINCT ON (target_id) target_id,created_at
       FROM audit_outbox
      WHERE tenant_id=$1 AND action='revision.accepted' AND target_id=ANY($2::uuid[])
      ORDER BY target_id,created_at DESC,id DESC`,
    [tenant, ids],
  );
  const acceptedAt = new Map(accepted.map((row) => [row.target_id as string, row.created_at]));
  const byWork = new Map<string, any[]>();
  for (const revision of revisions)
    byWork.set(revision.artifact_id, [...(byWork.get(revision.artifact_id) ?? []), revision]);

  const items: ShelfExportPage["items"] = [];
  let counted = 0;
  let cut = false;
  for (const work of candidates) {
    const versions = byWork.get(work.id) ?? [];
    if (items.length && counted + versions.length > EXPORT_PAGE_REVISIONS) {
      cut = true;
      break;
    }
    counted += versions.length;
    const out = [];
    for (const r of versions) {
      let files: Awaited<ReturnType<typeof storedRevisionFiles>>["files"] = [];
      try {
        files = (await storedRevisionFiles(db, r)).files;
      } catch (error) {
        if (!r.unavailable) throw error;
      }
      out.push({
        id: r.id,
        number: r.number,
        createdAt: iso(r.created_at)!,
        filename: r.filename,
        mime: r.mime,
        size: Number(r.size),
        sha256: r.sha256,
        totalSize: Number(r.total_size),
        storageKind: r.storage_kind,
        manifest: r.manifest ?? null,
        manifestSha256: r.manifest_sha256 ?? null,
        unavailable: r.unavailable ?? null,
        files: files.map(({ path, mime, size, sha256 }, index) => ({ index, path, mime, size, sha256 })),
      });
    }
    items.push({
      id: work.id,
      title: work.title,
      folderId: work.folder_id,
      updatedAt: iso(work.updated_at)!,
      trashedAt: iso(work.trashed_at),
      ownerIsSelf: work.owner_account_id === verified.accountId,
      acceptedRevisionId: work.accepted_revision_id,
      acceptedAt: work.accepted_revision_id ? iso(acceptedAt.get(work.id) ?? null) : null,
      revisions: out,
    });
  }
  const { rows: folders } = await db.query("SELECT id,name FROM folders WHERE tenant_id=$1 ORDER BY name,id", [tenant]);
  await countAgentRead(tenant, verified.principal);
  return {
    format: SHELF_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    source: {
      origin: config.APP_ORIGIN,
      shelfId: tenant,
      accountEmail: shelf.email ?? null,
      polkaVersion: POLKA_VERSION,
    },
    shelf: { cardMd: shelf.card_md ?? null, folders },
    items,
    nextCursor: more || cut ? (items.at(-1)?.id ?? null) : null,
  };
}

/** One file of any version of the shelf, the trash included; not one moderation holds. */
export async function exportFileForAgent(actor: ServiceActor, revisionId: string, index: number) {
  const { verified } = await exporter(actor);
  if (index < 0 || index >= PROJECT_MAX_FILES) throw missing();
  const {
    rows: [revision],
  } = await db.query(
    `SELECT r.*,${unavailableSql("r")} AS unavailable
       FROM revisions r JOIN artifacts a ON a.id=r.artifact_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND a.purged_at IS NULL`,
    [revisionId, verified.tenantId],
  );
  if (!revision) throw missing();
  if (revision.unavailable) throw new Problem(410, "expired", "Эта версия заблокирована модератором и не выгружается.");
  const file = (await storedRevisionFiles(db, revision)).files[index];
  if (!file) throw missing();
  return readStoredFile(file);
}
