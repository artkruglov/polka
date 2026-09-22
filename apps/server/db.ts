import pg from "pg";
import { config } from "./config.ts";
export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
// An idle connection can disappear during a database restart. The pool replaces
// it on the next checkout; do not turn its error event into a process crash.
db.on("error", () =>
  console.error(JSON.stringify({ event: "database.connection_lost" })),
);
export async function transaction<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  let broken = false;
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    // A failed ROLLBACK (the connection dropped) must not replace the real
    // error; the client is then discarded instead of returned to the pool.
    await c.query("ROLLBACK").catch(() => (broken = true));
    throw e;
  } finally {
    c.release(broken);
  }
}
