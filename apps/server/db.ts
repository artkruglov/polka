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
 * Known limitation, to be fixed after launch: an upload holds its
 * transaction — the shelf lock (lockShelf) and the upload row, and so one
 * pooled connection — for the whole S3 PUT of its bytes:
 *   artifacts.ts  uploadBytesInTransaction (putImmutable of a single file),
 *                 uploadBundleFileInTransaction (each file of a bundle),
 *                 finalizeBundleUploadInTransaction (reads the staged files
 *                 back from S3 under the same lock);
 *   project-upload.ts putProjectFile / finalizeProjectUpload (the same, for
 *                 projects from the CLI).
 * A slow object store therefore serialises writers on one shelf and can
 * drain the pool. Until the upload path stages bytes outside the
 * transaction, the pool is larger (DATABASE_POOL_MAX, default 20) and an
 * abandoned transaction is cut off by idle_in_transaction_session_timeout.
 */
export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  connectionTimeoutMillis: 5000,
  ...DATABASE_SESSION,
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
      .catch((error) =>
        console.error(
          JSON.stringify({ event: "database.after_commit_failed", ...errorFacts(error) }),
        ),
      ),
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
