import pg from "pg";
import { config } from "./config.ts";

/**
 * The app role's session limits, sent with every new connection:
 * - statement_timeout 15 s: no request of the web app or an agent needs a
 *   longer statement (maintenance and migrations run under their own roles
 *   and bounds); lock waits count too, so a stuck lock becomes a 503 «busy»
 *   (app.ts) instead of a hung request.
 * - idle_in_transaction_session_timeout 60 s: a transaction left open by a
 *   request that stalled between statements (see below) is ended by the
 *   server, releasing its locks and its connection.
 */
export const DATABASE_SESSION = {
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

/*
 * Uploads keep object storage out of their transactions: the S3 PUT of the
 * bytes and the reading back and inspection of staged files at finalize run
 * before the transaction (artifacts.ts: stageUploadBytes, stageBundleFile,
 * prepareUploadFinalize, prepareBundleFinalize), which then only rechecks
 * and records under the shelf lock. A slow object store therefore delays
 * that upload alone, not the shelf or the pool. A built page is stored the
 * same way (bundle-derivatives.ts): before its transaction, and deleted again
 * if the row did not become ready with it. One small write stays inside: the
 * link document of a saved link (saved-links.ts).
 */
export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  connectionTimeoutMillis: 5000,
  ...DATABASE_SESSION,
});
// An idle connection can disappear during a database restart. The pool replaces
// it on the next checkout; do not turn its error event into a process crash.
db.on("error", () => console.error(JSON.stringify({ event: "database.connection_lost" })));
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
  else inBackground(new Promise<void>((resolve) => setImmediate(resolve)).then(() => runLater(work)));
}

/** The error's kind for a log line: never its data, values or credentials. */
export function errorFacts(error: unknown) {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof e.name === "string" ? e.name.slice(0, 80) : typeof error,
    code: typeof e.code === "string" ? e.code.slice(0, 40) : undefined,
    message: typeof e.message === "string" ? e.message.slice(0, 300) : undefined,
  };
}

function runLater(work: () => unknown) {
  return inBackground(
    Promise.resolve()
      .then(work)
      .catch((error) => console.error(JSON.stringify({ event: "database.after_commit_failed", ...errorFacts(error) }))),
  );
}

// Work started after a response (letters, reviews of a save, deletions):
// tracked so tests and shutdown can wait for it instead of sleeping.
const pending = new Set<Promise<unknown>>();

/** Track a promise started without awaiting it; returns it unchanged. */
export function inBackground<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  const forget = () => pending.delete(promise);
  promise.then(forget, forget);
  return promise;
}

/**
 * Resolves once every tracked background promise has settled, including
 * those that the settling ones started (a letter queued by after-commit work).
 */
export async function settled() {
  // A request's after-commit work is queued a tick after its response.
  await new Promise((resolve) => setImmediate(resolve));
  while (pending.size) {
    await Promise.allSettled([...pending]);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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
