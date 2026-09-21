import { unlink } from "node:fs/promises";
type EmailMaintenanceClient = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, any>> }>;
};

export async function cleanupEmailChallengesInTransaction(
  c: EmailMaintenanceClient,
  limit = 100,
  assertActive: () => void = () => undefined,
  removeFile: (path: string) => Promise<void> = unlink,
) {
  assertActive();
  const { rows } = await c.query(
    `SELECT id,delivery FROM login_challenges WHERE expires_at<now() OR consumed_at IS NOT NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [Math.min(Math.max(limit, 1), 1000)],
  );
  assertActive();
  for (const row of rows) {
    assertActive();
    if (row.delivery === "local") {
      try {
        await removeFile(`.local/mail/${row.id}.json`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      assertActive();
    }
    assertActive();
    await c.query("DELETE FROM login_challenges WHERE id=$1", [row.id]);
    assertActive();
  }
  return rows.length;
}

/** Bounded cleanup. Lock rows so a verifier and maintenance cannot race. */
export async function cleanupEmailChallenges(limit = 100) {
  // Keep the in-transaction helper importable by offline maintenance/restore
  // without constructing the application pool and parsing application env.
  const { transaction } = await import("./db.ts");
  return transaction((c) => cleanupEmailChallengesInTransaction(c, limit));
}
