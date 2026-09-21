import { randomUUID } from "node:crypto";
import { reportSchema } from "../../packages/contracts/index.ts";
import { transaction } from "./db.ts";
import { limitAttempts } from "./auth.ts";
import { sha256 } from "./storage.ts";
import { Problem, missing } from "./errors.ts";

// A recipient reports what the link currently shows, without an account.
// The response never echoes title, owner or tenant; closed links look missing.
export async function reportShare(body: unknown, ip: string) {
  const input = reportSchema.parse(body);
  await limitAttempts(`report:ip:${ip}`, 20);
  return transaction(async (c) => {
    const {
      rows: [s],
    } = await c.query(
      "SELECT id,tenant_id,revision_id FROM shares WHERE token_hash=$1 AND NOT revoked AND expires_at>now()",
      [sha256(input.token)],
    );
    if (!s) throw missing();
    const comment = input.comment || null;
    const {
      rows: [saved],
    } = await c.query(
      "INSERT INTO share_reports(id,idempotency_key,tenant_id,share_id,revision_id,reason,comment) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id",
      [
        randomUUID(),
        input.key,
        s.tenant_id,
        s.id,
        s.revision_id,
        input.reason,
        comment,
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
    }
    return { ok: true };
  });
}
