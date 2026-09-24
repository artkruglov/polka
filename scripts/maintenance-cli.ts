import { config } from "../apps/server/config.ts";
import { PROVISIONAL_IDLE_DAYS } from "../apps/server/provisional.ts";
import { actorKey } from "../apps/server/analytics-keys.ts";
import {
  createMaintenanceDatabase,
  createMaintenanceObjectStore,
  type MaintenanceDatabase,
} from "./maintenance-adapters.ts";
import {
  MaintenanceStorageFailure,
  runMaintenanceCleanup,
  type MaintenanceCounters,
  type MaintenanceObjectStore,
} from "./maintenance-cleanup.ts";
import {
  runMaintenanceGuard,
  type MaintenanceRunResult,
} from "./maintenance-guard.ts";

type SafeReason =
  | "busy"
  | "deadline"
  | "stopping"
  | "guard_lost"
  | "database"
  | "storage"
  | "internal";

type SafeEvent = {
  event:
    | "maintenance.started"
    | "maintenance.completed"
    | "maintenance.failed"
    | "maintenance.skipped";
  reason?: SafeReason;
  durationMs?: number;
  expiredUploadsReconciled?: number;
  expiredDerivativesReconciled?: number;
  emailChallengesRemoved?: number;
};

const SETUP_CLOSE_TIMEOUT_MS = 1_000;

function boundedSetupClose(close: () => Promise<void> | void) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SETUP_CLOSE_TIMEOUT_MS);
    Promise.resolve()
      .then(close)
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
  });
}

export async function runMaintenanceOnce(options: {
  database: MaintenanceDatabase;
  storage: MaintenanceObjectStore;
  signal: AbortSignal;
}): Promise<MaintenanceRunResult<MaintenanceCounters>> {
  return runMaintenanceGuard({
    client: options.database,
    signal: options.signal,
    run: (scope) =>
      runMaintenanceCleanup(scope, options.storage, {
        analyticsActorKey: actorKey,
        // Idle provisional shelves go through the deletion pipeline, so only
        // where it is configured (apps/server/provisional-maintenance.ts).
        ...(config.ACCOUNT_DELETION_ENABLED
          ? {
              provisionalRetirement: {
                idleDays: PROVISIONAL_IDLE_DAYS,
                policyVersion: config.ACCOUNT_DELETION_POLICY_VERSION!,
                purgeMaxHours: config.ACCOUNT_PURGE_MAX_HOURS!,
                backupRetentionMaxDays: config.BACKUP_RETENTION_MAX_DAYS!,
              },
            }
          : {}),
      }),
  });
}

export async function runMaintenanceCli(
  dependencies: {
    createDatabase?: () => MaintenanceDatabase;
    createStorage?: () => MaintenanceObjectStore & { close: () => void };
    emit?: (event: SafeEvent) => void;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const startedAt = performance.now();
  const deadlineMs = Math.min(dependencies.deadlineMs ?? 60_000, 60_000);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new Error("Invalid maintenance deadline");
  const emit =
    dependencies.emit ??
    ((event: SafeEvent) => console.log(JSON.stringify(event)));
  const safeEmit = (event: SafeEvent) => {
    try {
      emit(event);
    } catch {
      // Operator logging must not alter cleanup or resource disposal.
    }
  };
  safeEmit({ event: "maintenance.started" });
  const controller = new AbortController();
  let stopReason: "deadline" | "stopping" | undefined;
  const stop = (reason: "deadline" | "stopping") => {
    stopReason ??= reason;
    if (!controller.signal.aborted) controller.abort();
  };
  const externalAbort = () => stop("stopping");
  dependencies.signal?.addEventListener("abort", externalAbort, { once: true });
  if (dependencies.signal?.aborted) externalAbort();
  const processStop = () => stop("stopping");
  if (!dependencies.signal) {
    process.once("SIGINT", processStop);
    process.once("SIGTERM", processStop);
  }
  const deadline = setTimeout(() => stop("deadline"), deadlineMs);
  let database: MaintenanceDatabase | undefined;
  let storage: (MaintenanceObjectStore & { close: () => void }) | undefined;
  let guardStarted = false;
  let phase: "database" | "storage" | "run" = "database";
  const beforeGuardError = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  let exitCode = 1;
  try {
    if (controller.signal.aborted)
      throw new Error("Maintenance stopped before setup");
    database =
      dependencies.createDatabase?.() ??
      createMaintenanceDatabase(config.DATABASE_URL);
    phase = "storage";
    storage =
      dependencies.createStorage?.() ??
      createMaintenanceObjectStore({
        endpoint: config.S3_ENDPOINT,
        region: "us-east-1",
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        bucket: config.S3_BUCKET,
      });
    phase = "database";
    database.on?.("error", beforeGuardError);
    database.on?.("end", beforeGuardError);
    await database.connect();
    if (controller.signal.aborted)
      throw new Error("Maintenance stopped before guard");
    phase = "run";
    const pending = runMaintenanceOnce({
      database,
      storage,
      signal: controller.signal,
    });
    guardStarted = true;
    database.off?.("error", beforeGuardError);
    database.off?.("end", beforeGuardError);
    const result = await pending;
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (result.state === "completed") {
      safeEmit({
        event: "maintenance.completed",
        durationMs,
        ...result.value,
      });
      exitCode = 0;
    } else if (result.state === "busy") {
      safeEmit({ event: "maintenance.skipped", reason: "busy", durationMs });
      exitCode = 0;
    } else {
      const reason: SafeReason =
        result.state === "guard_lost"
          ? "guard_lost"
          : result.state === "aborted"
            ? (stopReason ?? "internal")
            : result.error instanceof MaintenanceStorageFailure
              ? "storage"
              : "internal";
      safeEmit({ event: "maintenance.failed", reason, durationMs });
    }
  } catch {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    safeEmit({
      event: "maintenance.failed",
      reason:
        stopReason ??
        (phase === "storage"
          ? "storage"
          : phase === "run"
            ? "internal"
            : "database"),
      durationMs,
    });
  } finally {
    clearTimeout(deadline);
    dependencies.signal?.removeEventListener("abort", externalAbort);
    if (!dependencies.signal) {
      process.removeListener("SIGINT", processStop);
      process.removeListener("SIGTERM", processStop);
    }
    const databaseToClose = database;
    if (databaseToClose && !guardStarted)
      await boundedSetupClose(() => databaseToClose.end?.());
    try {
      storage?.close();
    } catch {
      // Cleanup is best effort after the run outcome is already durable.
    }
  }
  return exitCode;
}
