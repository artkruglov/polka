import type { MaintenanceDatabase } from "./maintenance-adapters.ts";
import type { MaintenanceObjectStore } from "./maintenance-cleanup.ts";
import type { ErasureLedgerTransport } from "./erasure-ledger-adapter.ts";
import { runMaintenanceGuard, type MaintenanceRunResult } from "./maintenance-guard.ts";
import { runAccountPurge, type AccountPurgeCounters } from "./account-purge.ts";
import { parseAccountPurgeConfig } from "./account-purge-config.ts";
import { createAccountPurgeAdapters } from "./account-purge-adapters.ts";

type PurgeEvent = {
  event:
    | "account_purge.started"
    | "account_purge.completed"
    | "account_purge.failed"
    | "account_purge.skipped";
  reason?: "busy" | "deadline" | "stopping" | "guard_lost" | "setup" | "run";
  durationMs?: number;
  counters?: AccountPurgeCounters;
};

type PurgeAdapters = {
  database: MaintenanceDatabase;
  content: MaintenanceObjectStore;
  ledger: ErasureLedgerTransport;
  close: () => void;
};

function boundedClose(close: () => Promise<void> | void, timeoutMs = 1_000) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    Promise.resolve()
      .then(close)
      .then(
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

export async function runAccountPurgeOnce(options: {
  database: MaintenanceDatabase;
  content: MaintenanceObjectStore;
  ledger: ErasureLedgerTransport;
  ledgerId: string;
  signal: AbortSignal;
}): Promise<MaintenanceRunResult<AccountPurgeCounters>> {
  return runMaintenanceGuard({
    client: options.database,
    signal: options.signal,
    run: (scope) =>
      runAccountPurge(scope, {
        content: options.content,
        ledger: options.ledger,
        ledgerId: options.ledgerId,
      }),
  });
}

export async function runAccountPurgeCli(
  dependencies: {
    env?: NodeJS.ProcessEnv;
    createAdapters?: () => PurgeAdapters;
    emit?: (event: PurgeEvent) => void;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const started = performance.now();
  const deadlineMs = Math.min(dependencies.deadlineMs ?? 60_000, 60_000);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new Error("Invalid purge deadline");
  const emit = dependencies.emit ?? ((event: PurgeEvent) => console.log(JSON.stringify(event)));
  const safeEmit = (event: PurgeEvent) => {
    try {
      emit(event);
    } catch {
      // Structured operator output cannot alter erasure state.
    }
  };
  safeEmit({ event: "account_purge.started" });
  const controller = new AbortController();
  let reason: "deadline" | "stopping" | undefined;
  const stop = (next: "deadline" | "stopping") => {
    reason ??= next;
    if (!controller.signal.aborted) controller.abort();
  };
  const externalStop = () => stop("stopping");
  dependencies.signal?.addEventListener("abort", externalStop, { once: true });
  if (dependencies.signal?.aborted) externalStop();
  const processStop = () => stop("stopping");
  if (!dependencies.signal) {
    process.once("SIGINT", processStop);
    process.once("SIGTERM", processStop);
  }
  const deadline = setTimeout(() => stop("deadline"), deadlineMs);
  let adapters: PurgeAdapters | undefined;
  let guardStarted = false;
  let exitCode = 1;
  try {
    const config = parseAccountPurgeConfig(dependencies.env ?? process.env);
    adapters = dependencies.createAdapters?.() ?? createAccountPurgeAdapters(config);
    await adapters.database.connect();
    const identity = await adapters.database.query(
      "SELECT current_user AS current_user,session_user AS session_user",
    );
    const expectedWorker = decodeURIComponent(
      new URL(config.MAINTENANCE_DATABASE_URL).username,
    );
    if (
      identity.rows?.[0]?.current_user !== expectedWorker ||
      identity.rows?.[0]?.session_user !== expectedWorker
    )
      throw new Error("Purge database identity mismatch");
    if (controller.signal.aborted) throw new Error("Purge stopped before guard");
    const pending = runAccountPurgeOnce({
      database: adapters.database,
      content: adapters.content,
      ledger: adapters.ledger,
      ledgerId: config.ERASURE_LEDGER_ID,
      signal: controller.signal,
    });
    guardStarted = true;
    const result = await pending;
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    if (result.state === "completed") {
      safeEmit({ event: "account_purge.completed", durationMs, counters: result.value });
      exitCode = 0;
    } else if (result.state === "busy") {
      safeEmit({ event: "account_purge.skipped", reason: "busy", durationMs });
      exitCode = 0;
    } else {
      safeEmit({
        event: "account_purge.failed",
        reason:
          result.state === "guard_lost"
            ? "guard_lost"
            : result.state === "aborted"
              ? (reason ?? "run")
              : "run",
        durationMs,
      });
    }
  } catch {
    safeEmit({
      event: "account_purge.failed",
      reason: reason ?? "setup",
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
  } finally {
    clearTimeout(deadline);
    dependencies.signal?.removeEventListener("abort", externalStop);
    if (!dependencies.signal) {
      process.removeListener("SIGINT", processStop);
      process.removeListener("SIGTERM", processStop);
    }
    if (adapters && !guardStarted) {
      const closed = await boundedClose(() => adapters!.database.end?.());
      if (!closed) adapters.database.forceClose?.();
    }
    try {
      adapters?.close();
    } catch {
      // Guard owns the DB lifecycle; provider teardown is best effort afterward.
    }
  }
  return exitCode;
}
