import { z } from "zod";
import { uuid } from "../../packages/contracts/index.ts";
import { agentFolderScope, inScopeSql } from "./agent-scope.ts";
import { countAgentRead } from "./agent-read-counter.ts";
import { db } from "./db.ts";
import { Problem } from "./errors.ts";
import { recheckServiceActor, type ServiceActor } from "./service-auth.ts";

export const shelfSnapshotInputSchema = z
  .object({
    /**
     * The moment to look at the shelf at: ISO 8601 with a zone, not in the
     * future. A «+» offset that arrived as a space in a query string is put back.
     */
    at: z
      .string()
      .transform((value) => value.replace(/ (\d\d:\d\d)$/, "+$1"))
      .pipe(z.string().datetime({ offset: true })),
    /** The id of the last work of the previous page. */
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/**
 * The shelf as it stood at a moment (docs/specs/SHELF_SNAPSHOT.md): the works
 * that existed and were not in the trash then, each with the version that was
 * latest then and the version accepted then. The title and folder are the
 * current ones (they are not versioned). Moves to and from the trash and
 * acceptances are read from the audit journal. A moment within the last minute
 * may still change: a long save is stamped with the time it began.
 */
export async function shelfSnapshotForAgent(
  actor: ServiceActor,
  raw: z.input<typeof shelfSnapshotInputSchema>,
) {
  const verified = await recheckServiceActor(actor, "read");
  const input = parseSnapshotInput(raw);
  const scope = await agentFolderScope(db, {
    id: verified.accountId,
    tenant: verified.tenantId,
    connectionId: verified.connectionId,
  });
  const page = await shelfSnapshot(verified.tenantId, scope, input);
  await countAgentRead(verified.tenantId, verified.principal);
  return page;
}

/**
 * «Полка на дату» on the web: the same answer for a member of the shelf the
 * page shows (identity has checked the membership), plus what is true of each
 * work now, so the screen can say what changed since.
 */
export async function shelfSnapshotForMember(
  actor: { tenant: string },
  raw: z.input<typeof shelfSnapshotInputSchema>,
) {
  const input = parseSnapshotInput(raw);
  const page = await shelfSnapshot(actor.tenant, null, input);
  const ids = page.items.map((item) => item.id);
  const accepted = page.items.flatMap((item) => (item.acceptedRevisionId ? [item.acceptedRevisionId] : []));
  const { rows: now } = await db.query(
    `SELECT artifact.id,artifact.trashed_at,latest.number
     FROM artifacts artifact
     LEFT JOIN revisions latest ON latest.id=artifact.latest_revision_id
     WHERE artifact.tenant_id=$1 AND artifact.id=ANY($2::uuid[])`,
    [actor.tenant, ids],
  );
  const { rows: numbers } = await db.query(
    "SELECT id,number FROM revisions WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
    [actor.tenant, accepted],
  );
  const current = new Map(now.map((row) => [row.id as string, row]));
  const acceptedNumber = new Map(numbers.map((row) => [row.id as string, Number(row.number)]));
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      acceptedRevisionNumber: item.acceptedRevisionId ? (acceptedNumber.get(item.acceptedRevisionId) ?? null) : null,
      now: {
        latestRevisionNumber: current.get(item.id)?.number == null ? null : Number(current.get(item.id)!.number),
        trashed: !!current.get(item.id)?.trashed_at,
      },
    })),
  };
}

function parseSnapshotInput(raw: z.input<typeof shelfSnapshotInputSchema>) {
  const input = shelfSnapshotInputSchema.parse(raw);
  if (new Date(input.at).getTime() > Date.now() + 1000)
    throw new Problem(400, "invalid", "Момент для снимка не может быть в будущем.");
  return input;
}

/** The snapshot of one shelf, limited to the folders in scope (null: all). */
async function shelfSnapshot(
  tenantId: string,
  scope: string[] | null,
  input: z.output<typeof shelfSnapshotInputSchema>,
) {
  // The original text goes to the database: it keeps the microseconds.
  const { rows } = await db.query(
    `SELECT artifact.id,artifact.title,artifact.folder_id,
            r.id AS revision_id,r.number,r.filename,r.mime,r.size,r.total_size,r.created_at,
            accepted.revision_id AS accepted_revision_id
     FROM artifacts artifact
     JOIN LATERAL (
       SELECT * FROM revisions rev
       WHERE rev.artifact_id=artifact.id AND rev.created_at<=$2::timestamptz
       ORDER BY rev.number DESC LIMIT 1) r ON true
     LEFT JOIN LATERAL (
       SELECT event.action FROM audit_outbox event
       WHERE event.tenant_id=artifact.tenant_id AND event.target_id=artifact.id
         AND event.action IN ('artifact.trashed','artifact.restored')
         AND event.created_at<=$2::timestamptz
       ORDER BY event.created_at DESC,event.id DESC LIMIT 1) trash ON true
     LEFT JOIN LATERAL (
       SELECT NULLIF(event.payload->>'revisionId','')::uuid AS revision_id
       FROM audit_outbox event
       WHERE event.tenant_id=artifact.tenant_id AND event.target_id=artifact.id
         AND event.action='revision.accepted' AND event.created_at<=$2::timestamptz
       ORDER BY event.created_at DESC,event.id DESC LIMIT 1) accepted ON true
     WHERE artifact.tenant_id=$1 AND artifact.purged_at IS NULL
       AND CASE trash.action
             WHEN 'artifact.trashed' THEN false
             WHEN 'artifact.restored' THEN true
             -- No move before then: on the shelf, unless it is in the trash now
             -- with nothing journaled (rows from before the journal was complete).
             ELSE artifact.trashed_at IS NULL OR artifact.trashed_at>$2::timestamptz
                  OR EXISTS (SELECT 1 FROM audit_outbox later
                             WHERE later.tenant_id=artifact.tenant_id AND later.target_id=artifact.id
                               AND later.action IN ('artifact.trashed','artifact.restored'))
           END
       AND ${inScopeSql("artifact", "$3")}
       AND ($4::uuid IS NULL OR artifact.id>$4)
     ORDER BY artifact.id LIMIT $5`,
    [tenantId, input.at, scope, input.cursor ?? null, input.limit + 1],
  );
  const more = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    at: input.at,
    items: page.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      folderId: (row.folder_id as string | null) ?? null,
      revision: {
        id: row.revision_id as string,
        number: Number(row.number),
        filename: row.filename as string,
        mime: row.mime as string,
        size: Number(row.size),
        totalSize: Number(row.total_size),
        createdAt: new Date(row.created_at).toISOString(),
      },
      // null: no version was accepted by then (or the mark was cleared).
      acceptedRevisionId: (row.accepted_revision_id as string | null) ?? null,
    })),
    nextCursor: more && page.length ? (page.at(-1)!.id as string) : null,
  };
}
