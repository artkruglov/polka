// The installation's action journal for extensions (docs/specs/EXTENSIONS.md,
// context.auditFeed): what happened, in commit order, by a cursor an extension
// keeps in its own table. Durable where onEvent is not: a restart loses no
// row, and a transaction that commits late is never skipped (the same
// settled-rows rule as the agents' feed, apps/server/agent-events.ts).
import type { AuditCursor, AuditFeedItem } from "../../packages/extension-api/index.ts";
import { db } from "./db.ts";

/** Only rows no running transaction can still precede (migration 055). */
export const SETTLED_SQL = "COALESCE(e.tx_id,'0'::xid8)<pg_snapshot_xmin(pg_current_snapshot())";

const DIGITS = /^\d{1,20}$/;

/** The end of the settled journal now: a cursor that starts after everything so far. */
export async function auditFeedHead(): Promise<AuditCursor> {
  const {
    rows: [end],
  } = await db.query(
    `SELECT COALESCE(e.tx_id,'0'::xid8)::text AS tx,e.id::text AS id FROM audit_outbox e
      WHERE ${SETTLED_SQL}
      ORDER BY COALESCE(e.tx_id,'0'::xid8) DESC,e.id DESC LIMIT 1`,
  );
  return end ? { tx: end.tx, id: end.id } : { tx: "0", id: "0" };
}

/** Rows after the cursor with these actions, oldest first; next is the cursor to keep. */
export async function readAuditFeed(
  cursor: AuditCursor | null,
  options: { actions: string[]; limit: number },
): Promise<{ items: AuditFeedItem[]; next: AuditCursor | null }> {
  const from = cursor ?? { tx: "0", id: "0" };
  if (!DIGITS.test(from.tx) || !DIGITS.test(from.id)) throw new Error("Invalid audit cursor");
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.trunc(options.limit))) : 100;
  // The settled end first: every row up to it has finished, so the page below
  // sees all of them, and a short page may move the cursor to it.
  const head = await auditFeedHead();
  if (!after(head, from)) return { items: [], next: from };
  const { rows } = await db.query(
    `SELECT e.id::text AS id,COALESCE(e.tx_id,'0'::xid8)::text AS tx,e.tenant_id,e.actor_id,e.actor_type,
            e.action,e.target_id,e.payload,e.created_at
       FROM audit_outbox e
      WHERE e.action=ANY($1::text[]) AND (COALESCE(e.tx_id,'0'::xid8),e.id)>($2::xid8,$3::bigint)
        AND (COALESCE(e.tx_id,'0'::xid8),e.id)<=($4::xid8,$5::bigint)
      ORDER BY COALESCE(e.tx_id,'0'::xid8),e.id
      LIMIT $6`,
    [options.actions, from.tx, from.id, head.tx, head.id, limit],
  );
  const items = rows.map((row) => ({
    id: row.id as string,
    tx: row.tx as string,
    tenantId: row.tenant_id as string,
    actorId: row.actor_id as string,
    actorType: row.actor_type as string,
    action: row.action as string,
    targetId: row.target_id as string,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
  const last = items.at(-1);
  // A short page holds every row of these actions up to the settled end:
  // move past it, so the next poll does not walk other actions again.
  return { items, next: items.length === limit ? { tx: last!.tx, id: last!.id } : head };
}

/** a comes after b in journal order. */
function after(a: AuditCursor, b: AuditCursor) {
  const tx = BigInt(a.tx) - BigInt(b.tx);
  return tx > 0n || (tx === 0n && BigInt(a.id) > BigInt(b.id));
}
