import { createHmac, randomUUID } from "node:crypto";
import { reportSchema } from "../../packages/contracts/index.ts";
import { transaction } from "./db.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { sha256 } from "./storage.ts";
import { Problem, missing } from "./errors.ts";
import { dispatchModerationNotices } from "./moderation-mail.ts";
import type { ModerationNotice } from "./share-moderation.ts";

/**
 * One reporter of one link, without keeping their address: the same IP
 * reporting the same link twice is one reporter; across links it cannot be
 * followed.
 */
export const reporterHash = (ip: string, shareId: string) =>
  createHmac("sha256", config.LINK_KEY)
    .update(`report-reporter:${ip}|${shareId}`)
    .digest("hex");

// A recipient reports what the link currently shows, without an account.
// The response never echoes title, owner or tenant; closed links look missing.
// Every new report is a letter to the operator; MODERATION_AUTOPAUSE_REPORTS
// distinct reporters within 7 days pause the link until the operator decides
// (editorial catalogue links are never paused automatically).
export async function reportShare(body: unknown, ip: string) {
  const input = reportSchema.parse(body);
  await limitAttempts(`report:ip:${ip}`, 20);
  const notices: ModerationNotice[] = [];
  const result = await transaction(async (c) => {
    const {
      rows: [s],
    } = await c.query(
      `SELECT id,tenant_id,revision_id FROM shares
       WHERE token_hash=$1 AND NOT revoked AND expires_at>now()`,
      [sha256(input.token)],
    );
    if (!s) throw missing();
    // Concurrent reports of one link take turns, so the distinct-reporter
    // count that pauses it is exact. An advisory lock, not the share row:
    // owner paths lock tenant → artifact → share, and this insert's foreign
    // keys wait on the tenant, so holding the share row here could deadlock
    // against a revoke.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `share-report:${s.id}`,
    ]);
    const comment = input.comment || null;
    const reportId = randomUUID();
    const {
      rows: [saved],
    } = await c.query(
      `INSERT INTO share_reports(
         id,idempotency_key,tenant_id,share_id,revision_id,reason,comment,reporter_hash
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
      [
        reportId,
        input.key,
        s.tenant_id,
        s.id,
        s.revision_id,
        input.reason,
        comment,
        reporterHash(ip, s.id),
      ],
    );
    if (!saved) {
      const {
        rows: [old],
      } = await c.query(
        "SELECT share_id,reason,comment FROM share_reports WHERE idempotency_key=$1",
        [input.key],
      );
      if (
        old.share_id !== s.id ||
        old.reason !== input.reason ||
        old.comment !== comment
      )
        throw new Problem(
          409,
          "conflict",
          "Этот повтор относится к другой жалобе. Отправьте её заново.",
        );
      return { ok: true };
    }
    let paused = false;
    const threshold = config.MODERATION_AUTOPAUSE_REPORTS;
    const {
      rows: [current],
    } = await c.query("SELECT moderation FROM shares WHERE id=$1", [s.id]);
    if (threshold && current.moderation === "none") {
      const {
        rows: [{ reporters, editorial }],
      } = await c.query(
        `SELECT count(DISTINCT reporter_hash)::int AS reporters,
           EXISTS(SELECT 1 FROM editorial_publications WHERE share_id=$1) AS editorial
         FROM share_reports
         WHERE share_id=$1 AND created_at>now()-interval '7 days'`,
        [s.id],
      );
      if (reporters >= threshold && !editorial) {
        const updated = await c.query(
          `UPDATE shares SET moderation='paused',moderation_reason='reports',
             moderated_at=now()
           WHERE id=$1 AND moderation='none' AND NOT revoked`,
          [s.id],
        );
        paused = !!updated.rowCount;
      }
    }
    notices.push({ kind: "report", shareId: s.id, reportId, paused });
    return { ok: true };
  });
  void dispatchModerationNotices(notices);
  return result;
}
