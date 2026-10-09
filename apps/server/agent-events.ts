import { z } from "zod";
import { agentFolderScope, inScopeSql } from "./agent-scope.ts";
import { countAgentRead } from "./agent-read-counter.ts";
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
  const [afterTx, afterId] = input.after === "0" ? ["0", "0"] : input.after.split(":");
  // The work an event is about: the target itself, or the version's work.
  const { rows } = await db.query(
    `SELECT e.id::text AS id,COALESCE(e.tx_id,'0'::xid8)::text AS tx,e.action,e.actor_type,e.created_at,e.payload,
            artifact.id AS artifact_id,
            CASE WHEN e.action='revision.saved' THEN e.target_id
                 WHEN e.action='revision.accepted' THEN (e.payload->>'revisionId')::uuid END AS revision_id
     FROM audit_outbox e
     LEFT JOIN revisions r ON e.action='revision.saved' AND r.id=e.target_id
     JOIN artifacts artifact
       ON artifact.id=CASE WHEN e.action='revision.saved' THEN r.artifact_id
                           ELSE e.target_id END
      AND artifact.tenant_id=e.tenant_id
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
    events: page.map((row) => ({
      id: `${row.tx}:${row.id}`,
      action: row.action as string,
      artifactId: row.artifact_id as string,
      ...(row.revision_id ? { revisionId: row.revision_id as string } : {}),
      actorType: row.actor_type as "human" | "agent",
      at: new Date(row.created_at).toISOString(),
    })),
    // On an empty page the cursor stays where it was: nothing is skipped.
    nextCursor: last ? `${last.tx}:${last.id}` : input.after,
    more,
  };
}
