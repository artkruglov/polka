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
const committed = new WeakMap<pg.PoolClient, Array<() => unknown>>();

/**
 * Run `work` once the transaction of `c` commits (never if it rolls back):
 * letters and object deletion that must not happen for a change that did
 * not. Outside transaction() the work runs on the next tick. It is started,
 * not awaited, and its errors are logged.
 */
export function afterCommit(c: pg.PoolClient, work: () => unknown) {
  const queue = committed.get(c);
  if (queue) queue.push(work);
  else setImmediate(() => runLater(work));
}

function runLater(work: () => unknown) {
  Promise.resolve()
    .then(work)
    .catch(() =>
      console.error(JSON.stringify({ event: "database.after_commit_failed" })),
    );
}

export async function transaction<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  let broken = false;
  const queue: Array<() => unknown> = [];
  committed.set(c, queue);
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    committed.delete(c);
    for (const work of queue) runLater(work);
    return result;
  } catch (e) {
    // A failed ROLLBACK (the connection dropped) must not replace the real
    // error; the client is then discarded instead of returned to the pool.
    await c.query("ROLLBACK").catch(() => (broken = true));
    throw e;
  } finally {
    committed.delete(c);
    c.release(broken);
  }
}
