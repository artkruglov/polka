const ADVISORY_LOCK = 4388002;

export type MaintenanceQueryResult = {
  rows?: Array<Record<string, unknown>>;
};

export type MaintenanceClient = {
  query: (sql: string, values?: unknown[]) => Promise<MaintenanceQueryResult>;
  on?: (event: "error" | "end", listener: () => void) => void;
  off?: (event: "error" | "end", listener: () => void) => void;
  release?: (destroy?: boolean) => void;
  end?: () => Promise<void> | void;
};

export type MaintenanceRunResult<T> =
  | { state: "completed"; value: T }
  | { state: "busy" }
  | { state: "aborted" }
  | { state: "guard_lost" }
  | { state: "failed"; error: unknown };

class MaintenanceAborted extends Error {}
class MaintenanceGuardLost extends Error {}
const ROLLBACK_TIMEOUT_MS = 1000;

function boundedCleanup(promise: Promise<unknown>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function assertActive(signal: AbortSignal, guardLost: () => boolean) {
  if (signal.aborted) throw new MaintenanceAborted();
  if (guardLost()) throw new MaintenanceGuardLost();
}

function locked(result: MaintenanceQueryResult) {
  const value = result.rows?.[0]?.locked;
  return value === true || value === "t";
}

/** One dedicated session owns the advisory lock and every protected transaction. */
export async function runMaintenanceGuard<T>(options: {
  client: MaintenanceClient;
  signal: AbortSignal;
  run: (scope: {
    signal: AbortSignal;
    transaction: <R>(
      operation: (client: MaintenanceClient) => Promise<R>,
    ) => Promise<R>;
  }) => Promise<T>;
}): Promise<MaintenanceRunResult<T>> {
  const { client, signal } = options;
  const internal = new AbortController();
  let guardLost = false;
  let closed = false;
  let destroyed = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let transactionActive = false;
  const destroyConnection = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      if (client.release) client.release(true);
      else
        closePromise = Promise.resolve(client.end?.())
          .then(() => undefined)
          .catch(() => undefined);
    } catch {
      // The connection is already unusable; close remains best effort.
    }
  };
  const loseGuard = () => {
    guardLost = true;
    if (!internal.signal.aborted) internal.abort();
    destroyConnection();
  };
  const externalAbort = () => {
    if (!internal.signal.aborted) internal.abort();
    destroyConnection();
  };
  const connectionError = () => {
    if (closing) return;
    loseGuard();
  };
  signal.addEventListener("abort", externalAbort, { once: true });
  client.on?.("error", connectionError);
  client.on?.("end", connectionError);
  const query = async (sql: string, values?: unknown[]) => {
    try {
      return await client.query(sql, values);
    } catch (error) {
      if (!internal.signal.aborted) loseGuard();
      throw error;
    }
  };
  const activeQuery = async (sql: string, values?: unknown[]) => {
    assertActive(internal.signal, () => guardLost);
    const result = await query(sql, values);
    assertActive(internal.signal, () => guardLost);
    return result;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    closing = true;
    signal.removeEventListener("abort", externalAbort);
    if (!destroyed) destroyConnection();
    await boundedCleanup(
      closePromise ?? Promise.resolve(),
      ROLLBACK_TIMEOUT_MS,
    );
    // A forced/delayed close can emit after this bounded wait. Keep the
    // sanitized closing listener attached to the dedicated dying client so a
    // late `error` event cannot become an uncaught process exception.
  };
  const transaction = async <R>(
    operation: (tx: MaintenanceClient) => Promise<R>,
  ): Promise<R> => {
    assertActive(internal.signal, () => guardLost);
    if (transactionActive)
      throw new Error("Maintenance transactions must be sequential");
    transactionActive = true;
    let committed = false;
    try {
      await activeQuery("BEGIN");
      assertActive(internal.signal, () => guardLost);
      const value = await operation({ query: activeQuery });
      assertActive(internal.signal, () => guardLost);
      await activeQuery("COMMIT");
      committed = true;
      return value;
    } finally {
      if (!committed) {
        const rolledBack = await boundedCleanup(
          query("ROLLBACK"),
          ROLLBACK_TIMEOUT_MS,
        );
        if (!rolledBack) {
          if (!internal.signal.aborted) internal.abort();
          destroyConnection();
        }
      }
      transactionActive = false;
    }
  };

  try {
    if (signal.aborted) return { state: "aborted" };
    let lockResult: MaintenanceQueryResult;
    try {
      lockResult = await query("SELECT pg_try_advisory_lock($1) AS locked", [
        ADVISORY_LOCK,
      ]);
    } catch {
      return { state: "guard_lost" };
    }
    if (internal.signal.aborted)
      return guardLost ? { state: "guard_lost" } : { state: "aborted" };
    if (!locked(lockResult)) return { state: "busy" };
    try {
      const value = await options.run({ signal: internal.signal, transaction });
      if (internal.signal.aborted)
        return guardLost ? { state: "guard_lost" } : { state: "aborted" };
      if (guardLost) return { state: "guard_lost" };
      return { state: "completed", value };
    } catch (error) {
      if (error instanceof MaintenanceGuardLost || guardLost)
        return { state: "guard_lost" };
      if (error instanceof MaintenanceAborted || internal.signal.aborted)
        return { state: "aborted" };
      return { state: "failed", error };
    } finally {
      if (!guardLost && !internal.signal.aborted) {
        try {
          await query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]);
        } catch {
          // Closing the dedicated session releases the lock if unlock failed.
        }
      }
    }
  } finally {
    await close();
  }
}
