import { z } from "zod";
import { agentFolderScope, inScopeSql } from "./agent-scope.ts";
import { countAgentRead } from "./agent-read-counter.ts";
import { db } from "./db.ts";
import { cursorAheadOfCluster } from "./extension-feed.ts";
import { recheckServiceActor, type ServiceActor } from "./service-auth.ts";

/**
 * The actions the feed shows: what happened to a work. Everything else in
 * audit_outbox (accounts, connections, libraries, editorial) stays out.
 * Webhooks send these and a few more (packages/contracts/webhooks.ts).
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
 * The work an event is about: the target itself, the version's work, the
 * link's or the comment's work. Shared with webhooks (webhooks.ts), whose
 * body is the same event. Events of a work deleted for good have no row.
 */
export const EVENT_COLUMNS_SQL = `e.id::text AS id,COALESCE(e.tx_id,'0'::xid8)::text AS tx,e.tenant_id,e.action,
  e.actor_type,e.created_at,artifact.id AS artifact_id,
  CASE WHEN e.action='revision.saved' THEN e.target_id
       WHEN e.action IN ('revision.accepted','comment.created') THEN (e.payload->>'revisionId')::uuid END AS revision_id`;
export const EVENT_FROM_SQL = `FROM audit_outbox e
  LEFT JOIN revisions r ON e.action='revision.saved' AND r.id=e.target_id
  LEFT JOIN shares s ON e.action IN ('share.enabled','share.revoked') AND s.id=e.target_id
  LEFT JOIN comments cm ON e.action='comment.created' AND cm.id=e.target_id
  JOIN artifacts artifact
    ON artifact.id=CASE WHEN e.action='revision.saved' THEN r.artifact_id
                        WHEN e.action IN ('share.enabled','share.revoked') THEN s.artifact_id
                        WHEN e.action='comment.created' THEN cm.artifact_id
                        ELSE e.target_id END
   AND artifact.tenant_id=e.tenant_id`;

export type FeedEvent = {
  id: string;
  action: string;
  artifactId: string;
  revisionId?: string;
  actorType: "human" | "agent";
  at: string;
};

export const eventDTO = (row: any): FeedEvent => ({
  id: `${row.tx}:${row.id}`,
  action: row.action as string,
  artifactId: row.artifact_id as string,
  ...(row.revision_id ? { revisionId: row.revision_id as string } : {}),
  actorType: row.actor_type as "human" | "agent",
  at: new Date(row.created_at).toISOString(),
});

export const agentEventsInputSchema = z
  .object({
    /**
     * The cursor of the last event seen. Omitted: nothing is returned, and
     * nextCursor is the current end of the feed, to poll from. "0": from the
     * start of the shelf's history.
     */
    after: z
      .string()
      .regex(/^(0|\d{1,20}:\d{1,18})$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function listEventsForAgent(actor: ServiceActor, raw: z.input<typeof agentEventsInputSchema>) {
  const verified = await recheckServiceActor(actor, "read");
  const input = agentEventsInputSchema.parse(raw);
  const scope = await agentFolderScope(db, {
    id: verified.accountId,
    tenant: verified.tenantId,
    connectionId: verified.connectionId,
  });
  // Only rows no running transaction can still precede (see migration 055).
  const settled = "COALESCE(e.tx_id,'0'::xid8)<pg_snapshot_xmin(pg_current_snapshot())";
  if (input.after === undefined) {
    const {
      rows: [end],
    } = await db.query(
      `SELECT e.tx_id::text AS tx,e.id::text AS id FROM audit_outbox e
       WHERE e.tenant_id=$1 AND ${settled}
       ORDER BY COALESCE(e.tx_id,'0'::xid8) DESC,e.id DESC LIMIT 1`,
      [verified.tenantId],
    );
    return { events: [], nextCursor: end ? `${end.tx ?? "0"}:${end.id}` : "0" };
  }
  let [afterTx, afterId] = input.after === "0" ? ["0", "0"] : input.after.split(":");
  // A cursor from before a restore (extension-feed.ts, cursorAheadOfCluster)
  // goes on from the same row with no transaction number, and that is the
  // cursor handed back, so it does not jump once the cluster catches up.
  let after = input.after;
  if (await cursorAheadOfCluster(afterTx!)) {
    afterTx = "0";
    after = `0:${afterId}`;
  }
  const { rows } = await db.query(
    `SELECT ${EVENT_COLUMNS_SQL}
     ${EVENT_FROM_SQL}
     WHERE e.tenant_id=$1 AND e.action=ANY($2::text[]) AND (COALESCE(e.tx_id,'0'::xid8),e.id)>($3::xid8,$4::bigint)
       AND ${settled}
       AND ${inScopeSql("artifact", "$5")}
     ORDER BY COALESCE(e.tx_id,'0'::xid8),e.id
     LIMIT $6`,
    [verified.tenantId, EVENT_ACTIONS, afterTx, afterId, scope, input.limit + 1],
  );
  const more = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  // A poll that found nothing, and the call that only starts the cursor, are not reads.
  if (page.length) await countAgentRead(verified.tenantId, verified.principal);
  return {
    events: page.map(eventDTO),
    // On an empty page the cursor stays where it was: nothing is skipped.
    nextCursor: last ? `${last.tx}:${last.id}` : after,
    more,
  };
}
