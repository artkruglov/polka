import { z } from "zod";
import { agentFolderScope, inScopeSql } from "./agent-scope.ts";
import { db } from "./db.ts";
import { recheckServiceActor, type ServiceActor } from "./service-auth.ts";

/**
 * The actions the feed shows: what happened to a work. Everything else in
 * audit_outbox (accounts, connections, libraries, editorial) stays out.
 */
export const EVENT_ACTIONS = [
  "revision.saved",
  "revision.accepted",
  "owner.changed",
  "artifact.metadata_updated",
  "artifact.moved",
  "artifact.trashed",
  "artifact.restored",
] as const;

/**
 * An event becomes visible to pollers after this long, so one committed
 * later with a lower id than its neighbours is not skipped by a cursor.
 */
export const EVENT_SETTLE_MS = 5000;

export const agentEventsInputSchema = z
  .object({
    /**
     * The id of the last event seen. Omitted: nothing is returned, and
     * nextCursor is the current end of the feed, to poll from. "0": from the
     * start of the shelf's history.
     */
    after: z.string().regex(/^\d{1,18}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function listEventsForAgent(
  actor: ServiceActor,
  raw: z.input<typeof agentEventsInputSchema>,
  settleMs = EVENT_SETTLE_MS,
) {
  const verified = await recheckServiceActor(actor, "read");
  const input = agentEventsInputSchema.parse(raw);
  const scope = await agentFolderScope(db, {
    id: verified.accountId,
    tenant: verified.tenantId,
    connectionId: verified.connectionId,
  });
  if (input.after === undefined) {
    const {
      rows: [end],
    } = await db.query(
      `SELECT COALESCE(max(id),0)::text AS id FROM audit_outbox
       WHERE tenant_id=$1 AND created_at<=now()-make_interval(secs=>$2)`,
      [verified.tenantId, settleMs / 1000],
    );
    return { events: [], nextCursor: end.id as string };
  }
  // The work an event is about: the target itself, or the version's work.
  const { rows } = await db.query(
    `SELECT e.id::text AS id,e.action,e.actor_type,e.created_at,e.payload,
            artifact.id AS artifact_id,
            CASE WHEN e.action='revision.saved' THEN e.target_id
                 WHEN e.action='revision.accepted' THEN (e.payload->>'revisionId')::uuid END AS revision_id
     FROM audit_outbox e
     LEFT JOIN revisions r ON e.action='revision.saved' AND r.id=e.target_id
     JOIN artifacts artifact
       ON artifact.id=CASE WHEN e.action='revision.saved' THEN r.artifact_id
                           ELSE e.target_id END
      AND artifact.tenant_id=e.tenant_id
     WHERE e.tenant_id=$1 AND e.action=ANY($2::text[]) AND e.id>$3::bigint
       AND e.created_at<=now()-make_interval(secs=>$4)
       AND ${inScopeSql("artifact", "$5")}
     ORDER BY e.id
     LIMIT $6`,
    [
      verified.tenantId,
      EVENT_ACTIONS,
      input.after,
      settleMs / 1000,
      scope,
      input.limit + 1,
    ],
  );
  const more = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      id: row.id as string,
      action: row.action as string,
      artifactId: row.artifact_id as string,
      ...(row.revision_id ? { revisionId: row.revision_id as string } : {}),
      actorType: row.actor_type as "human" | "agent",
      at: new Date(row.created_at).toISOString(),
    })),
    // On an empty page the cursor stays where it was: nothing is skipped.
    nextCursor: last ? (last.id as string) : input.after,
    more,
  };
}
