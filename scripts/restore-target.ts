import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { z } from "zod";
import { EXPECTED_MIGRATION_VERSIONS } from "../packages/migrations.ts";
import {
  ledgerManifestSha256,
  restoreTargetIdentity,
  schemaManifestSha256,
  sha256Hex,
  targetIdentitySha256,
  writeRestoreReceipt,
  type RestoreCompletionReceipt,
} from "../packages/restore-receipt.ts";
import {
  createMaintenanceDatabase,
  createMaintenanceObjectStore,
  type MaintenanceDatabase,
} from "./maintenance-adapters.ts";
import type { MaintenanceObjectStore } from "./maintenance-cleanup.ts";
import { runMaintenanceGuard } from "./maintenance-guard.ts";
import { createErasureLedgerS3Transport } from "./erasure-ledger-s3.ts";
import type { ErasureLedgerTransport } from "./erasure-ledger-adapter.ts";
import {
  loadErasureRestorePlan,
  requireBackupLedger,
  type ErasureRestorePlan,
} from "./erasure-restore.ts";
import { reconcileErasureRestore } from "./erasure-restore-reconcile.ts";
import {
  parseRestoreTargetConfig,
  type RestoreTargetConfig,
} from "./restore-target-config.ts";

const MAX_BACKUP_DESCRIPTOR_BYTES = 64 * 1024;
const backupSchema = z
  .object({
    formatVersion: z.literal(1),
    schemaMigrations: z.array(z.number().int().positive()),
    erasureLedgerId: z.string().uuid(),
    localMailSpool: z.literal("absent"),
  })
  .passthrough();

type RestoreTargetAdapters = {
  database: MaintenanceDatabase;
  content: MaintenanceObjectStore;
  ledger: ErasureLedgerTransport;
  close: () => void;
};

type RestoreIdentity = {
  databaseName: string;
  databaseOid: string;
  appliedVersions: number[];
};

async function readBoundedRegularFile(file: string) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("Backup descriptor must be a regular file");
    if (stat.size > MAX_BACKUP_DESCRIPTOR_BYTES)
      throw new Error("Backup descriptor exceeds its size limit");
    const bytes = Buffer.alloc(MAX_BACKUP_DESCRIPTOR_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BACKUP_DESCRIPTOR_BYTES)
      throw new Error("Backup descriptor exceeds its size limit");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function exactVersions(rows: Array<Record<string, unknown>> | undefined) {
  const versions = (rows ?? []).map(({ version }) => Number(version));
  if (
    versions.length !== EXPECTED_MIGRATION_VERSIONS.length ||
    versions.some(
      (version, index) => version !== EXPECTED_MIGRATION_VERSIONS[index],
    )
  )
    throw new Error("Restore target schema does not match this release");
  return versions;
}

async function inspectClosedTarget(
  database: Pick<MaintenanceDatabase, "query">,
  runtimeDatabaseUrl: string,
  expectedRestoreLogin: string,
): Promise<RestoreIdentity> {
  const result = await database.query(
    `SELECT current_user AS current_user, session_user AS session_user,
            current_database() AS database_name,
            (SELECT oid::text FROM pg_catalog.pg_database
              WHERE datname=current_database()) AS database_oid,
            (SELECT count(*)::text FROM pg_catalog.pg_stat_activity
              WHERE datid=(SELECT oid FROM pg_catalog.pg_database
                            WHERE datname=current_database())
                AND pid<>pg_backend_pid()) AS other_sessions`,
  );
  const row = result.rows?.[0];
  if (
    typeof row?.current_user !== "string" ||
    row.current_user !== row.session_user ||
    row.current_user !== expectedRestoreLogin ||
    typeof row.database_name !== "string" ||
    typeof row.database_oid !== "string" ||
    row.other_sessions !== "0"
  )
    throw new Error("Restore target is not a closed dedicated database");
  const expectedName = decodeURIComponent(
    new URL(runtimeDatabaseUrl).pathname.slice(1),
  );
  if (row.database_name !== expectedName)
    throw new Error("Restore target database identity mismatch");
  const migrations = await database.query(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return {
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    appliedVersions: exactVersions(migrations.rows),
  };
}

export function createRestoreTargetAdapters(
  config: RestoreTargetConfig,
): RestoreTargetAdapters {
  const ledgerClient = new S3Client({
    endpoint: config.ERASURE_LEDGER_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: config.ERASURE_LEDGER_ACCESS_KEY,
      secretAccessKey: config.ERASURE_LEDGER_SECRET_KEY,
    },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 1_000,
      requestTimeout: 3_000,
    }),
  });
  const content = createMaintenanceObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: "us-east-1",
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  });
  return {
    database: createMaintenanceDatabase(config.RESTORE_DATABASE_URL),
    content,
    ledger: createErasureLedgerS3Transport({
      client: ledgerClient,
      bucket: config.ERASURE_LEDGER_BUCKET,
      bodyTimeoutMs: 3_000,
    }),
    close() {
      content.close?.();
      ledgerClient.destroy();
    },
  };
}

function boundedClose(database: MaintenanceDatabase, timeoutMs = 1_000) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      database.forceClose?.();
      resolve();
    }, timeoutMs);
    Promise.resolve(database.end?.()).then(
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

export async function runRestoreTarget(input: {
  config: RestoreTargetConfig;
  adapters: RestoreTargetAdapters;
  signal: AbortSignal;
  readBackup?: (path: string) => Promise<Uint8Array>;
  loadPlan?: (
    ledger: ErasureLedgerTransport,
    ledgerId: string,
    signal: AbortSignal,
  ) => Promise<ErasureRestorePlan>;
  reconcile?: typeof reconcileErasureRestore;
  writeReceipt?: typeof writeRestoreReceipt;
}) {
  const readBackup = input.readBackup ?? readBoundedRegularFile;
  const backupBytes = await readBackup(input.config.RESTORE_BACKUP_DESCRIPTOR);
  if (sha256Hex(backupBytes) !== input.config.RESTORE_BACKUP_SHA256)
    throw new Error("Backup descriptor hash does not match restore authority");
  const backup = backupSchema.parse(
    JSON.parse(Buffer.from(backupBytes).toString("utf8")),
  );
  if (
    backup.schemaMigrations.length !== EXPECTED_MIGRATION_VERSIONS.length ||
    backup.schemaMigrations.some(
      (version, index) => version !== EXPECTED_MIGRATION_VERSIONS[index],
    )
  )
    throw new Error("Backup schema does not match this release");
  const loadPlan = input.loadPlan ?? loadErasureRestorePlan;
  const plan = await loadPlan(
    input.adapters.ledger,
    input.config.ERASURE_LEDGER_ID,
    input.signal,
  );
  requireBackupLedger(backup, plan);
  if (
    ledgerManifestSha256(plan.records) !==
    input.config.RESTORE_LEDGER_MANIFEST_SHA256
  )
    throw new Error("Erasure ledger manifest does not match restore authority");
  let guardStarted = false;
  try {
    await input.adapters.database.connect();
    const expectedRestoreLogin = decodeURIComponent(
      new URL(input.config.RESTORE_DATABASE_URL).username,
    );
    guardStarted = true;
    const guarded = await runMaintenanceGuard({
      client: input.adapters.database,
      signal: input.signal,
      run: async (scope) => {
        const identity = await scope.transaction((client) =>
          inspectClosedTarget(
            client,
            input.config.DATABASE_URL,
            expectedRestoreLogin,
          ),
        );
        const counters = await (input.reconcile ?? reconcileErasureRestore)({
          scope,
          content: input.adapters.content,
          ledger: input.adapters.ledger,
          plan,
          restoreRunId: input.config.RESTORE_RUN_ID,
        });
        return { identity, counters };
      },
    });
    if (guarded.state !== "completed")
      throw new Error(
        `Restore reconciliation did not complete: ${guarded.state}`,
      );
    if (input.signal.aborted)
      throw new Error("Restore stopped before completion receipt");
    const receipt: RestoreCompletionReceipt = {
      version: 1,
      restoreRunId: input.config.RESTORE_RUN_ID,
      backupSha256: input.config.RESTORE_BACKUP_SHA256,
      targetIdentitySha256: targetIdentitySha256(
        restoreTargetIdentity({
          databaseUrl: input.config.DATABASE_URL,
          databaseOid: guarded.value.identity.databaseOid,
          storageEndpoint: input.config.S3_ENDPOINT,
          storageBucket: input.config.S3_BUCKET,
        }),
      ),
      schemaVersion: EXPECTED_MIGRATION_VERSIONS.at(-1)!,
      schemaManifestSha256: schemaManifestSha256(
        guarded.value.identity.appliedVersions,
      ),
      ledgerId: plan.ledgerId,
      ledgerManifestSha256: input.config.RESTORE_LEDGER_MANIFEST_SHA256,
    };
    await (input.writeReceipt ?? writeRestoreReceipt)(
      input.config.RESTORE_RECEIPT_PATH,
      receipt,
      { signal: input.signal },
    );
    return { receipt, counters: guarded.value.counters };
  } finally {
    if (!guardStarted) await boundedClose(input.adapters.database);
  }
}

export async function runRestoreTargetCli(
  dependencies: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    createAdapters?: (config: RestoreTargetConfig) => RestoreTargetAdapters;
    emit?: (event: Record<string, unknown>) => void;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const emit =
    dependencies.emit ?? ((event) => console.log(JSON.stringify(event)));
  const safeEmit = (event: Record<string, unknown>) => {
    try {
      emit(event);
    } catch {
      /* operator output cannot alter restore state */
    }
  };
  const argv = dependencies.argv ?? process.argv.slice(2);
  if (!argv.includes("--confirm-closed-target")) {
    safeEmit({ event: "restore.failed", reason: "confirmation_required" });
    return 2;
  }
  const deadlineMs = dependencies.deadlineMs ?? 120_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 120_000)
    throw new Error("Invalid restore deadline");
  const controller = new AbortController();
  let stopReason: "deadline" | "stopping" | undefined;
  const stop = (reason: "deadline" | "stopping") => {
    stopReason ??= reason;
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
  let adapters: RestoreTargetAdapters | undefined;
  try {
    const config = parseRestoreTargetConfig(dependencies.env ?? process.env);
    adapters = (dependencies.createAdapters ?? createRestoreTargetAdapters)(
      config,
    );
    const result = await runRestoreTarget({
      config,
      adapters,
      signal: controller.signal,
    });
    safeEmit({
      event: "restore.completed",
      restoreRunId: result.receipt.restoreRunId,
      backupSha256: result.receipt.backupSha256,
      targetIdentitySha256: result.receipt.targetIdentitySha256,
      schemaManifestSha256: result.receipt.schemaManifestSha256,
      ledgerId: result.receipt.ledgerId,
      ledgerManifestSha256: result.receipt.ledgerManifestSha256,
    });
    return 0;
  } catch {
    safeEmit({ event: "restore.failed", reason: stopReason ?? "restore" });
    return 1;
  } finally {
    clearTimeout(deadline);
    dependencies.signal?.removeEventListener("abort", externalStop);
    if (!dependencies.signal) {
      process.removeListener("SIGINT", processStop);
      process.removeListener("SIGTERM", processStop);
    }
    try {
      adapters?.close();
    } catch {
      /* provider close is best effort */
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = await runRestoreTargetCli();
