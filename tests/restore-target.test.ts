import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_MIGRATION_VERSIONS } from "../packages/migrations.ts";
import {
  ledgerManifestSha256,
  sha256Hex,
} from "../packages/restore-receipt.ts";
import type { ErasureRestorePlan } from "../scripts/erasure-restore.ts";
import { parseRestoreTargetConfig } from "../scripts/restore-target-config.ts";
import { runRestoreTarget } from "../scripts/restore-target.ts";

const runId = "00000000-0000-4000-8000-000000000001";
const ledgerId = "00000000-0000-4000-8000-000000000002";
const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL:
    "postgres://runtime:runtime-secret@localhost:5432/polka_restore",
  RESTORE_DATABASE_URL:
    "postgres://restore:restore-secret@localhost:5432/polka_restore",
  RESTORE_RUN_ID: runId,
  RESTORE_BACKUP_DESCRIPTOR: "/backup/restore-1/backup.json",
  RESTORE_RECEIPT_PATH: "/receipts/restore-1.json",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "content-key",
  S3_SECRET_KEY: "content-secret-000000",
  S3_BUCKET: "content-bucket",
  ERASURE_LEDGER_ID: ledgerId,
  ERASURE_LEDGER_ENDPOINT: "http://localhost:9000",
  ERASURE_LEDGER_ACCESS_KEY: "ledger-key",
  ERASURE_LEDGER_SECRET_KEY: "ledger-secret-0000000",
  ERASURE_LEDGER_BUCKET: "ledger-bucket",
};

const backupBytes = Buffer.from(
  JSON.stringify({
    formatVersion: 1,
    schemaMigrations: EXPECTED_MIGRATION_VERSIONS,
    erasureLedgerId: ledgerId,
    localMailSpool: "absent",
  }),
);
const plan: ErasureRestorePlan = Object.freeze({
  ledgerId,
  entries: Object.freeze([]),
  records: Object.freeze([]),
});
baseEnv.RESTORE_BACKUP_SHA256 = sha256Hex(backupBytes);
baseEnv.RESTORE_LEDGER_MANIFEST_SHA256 = ledgerManifestSha256(plan.records);

function adapters(
  events: string[],
  options: { connectFailure?: boolean } = {},
) {
  let ended = false;
  const database = {
    async connect() {
      events.push("connect");
      if (options.connectFailure) throw new Error("connect failed");
    },
    async query(sql: string) {
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: true }] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        events.push(sql.toLowerCase());
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_unlock"))
        return { rows: [{ pg_advisory_unlock: true }] };
      if (sql.includes("pg_stat_activity"))
        return {
          rows: [
            {
              current_user: "restore",
              session_user: "restore",
              database_name: "polka_restore",
              database_oid: "42",
              other_sessions: "0",
            },
          ],
        };
      if (sql.includes("schema_migrations"))
        return {
          rows: EXPECTED_MIGRATION_VERSIONS.map((version) => ({ version })),
        };
      throw new Error(`unexpected query: ${sql}`);
    },
    on() {},
    off() {},
    async end() {
      ended = true;
      events.push("end");
    },
    get ended() {
      return ended;
    },
  };
  return {
    database,
    content: {} as any,
    ledger: {} as any,
    close() {},
  };
}

function busyAdapters(events: string[]) {
  const value = adapters(events);
  const query = value.database.query.bind(value.database);
  value.database.query = async (sql: string) =>
    sql.includes("pg_try_advisory_lock")
      ? { rows: [{ locked: false }] }
      : query(sql);
  return value;
}

test("restore target config binds distinct identities and an outside receipt", () => {
  assert.equal(parseRestoreTargetConfig(baseEnv).RESTORE_RUN_ID, runId);
  assert.throws(
    () =>
      parseRestoreTargetConfig({
        ...baseEnv,
        RESTORE_RECEIPT_PATH: "/backup/restore-1/..receipt",
      }),
    /outside/,
  );
  assert.throws(
    () =>
      parseRestoreTargetConfig({
        ...baseEnv,
        RESTORE_RECEIPT_PATH: "/backup/restore-1",
      }),
    /outside/,
  );
  assert.throws(
    () =>
      parseRestoreTargetConfig({
        ...baseEnv,
        RESTORE_DATABASE_URL: baseEnv.DATABASE_URL,
      }),
    /distinct/,
  );
  assert.throws(
    () =>
      parseRestoreTargetConfig({
        ...baseEnv,
        DATABASE_URL:
          "postgres://restore:runtime-secret@localhost:5432/polka_restore",
        RESTORE_DATABASE_URL:
          "postgres://%72estore:restore-secret@localhost:5432/polka_restore",
      }),
    /distinct/,
  );
  assert.throws(
    () =>
      parseRestoreTargetConfig({
        ...baseEnv,
        RESTORE_DATABASE_URL: `${baseEnv.RESTORE_DATABASE_URL}?host=remote`,
      }),
    /routing parameters/,
  );
});

test("restore target preloads the ledger, reconciles under the guard, then writes receipt", async () => {
  const events: string[] = [];
  let written: unknown;
  const result = await runRestoreTarget({
    config: parseRestoreTargetConfig(baseEnv),
    adapters: adapters(events),
    signal: new AbortController().signal,
    readBackup: async () => {
      events.push("backup");
      return backupBytes;
    },
    loadPlan: async () => {
      events.push("ledger");
      return plan;
    },
    reconcile: async () => {
      events.push("reconcile");
      return {
        entriesCompleted: 0,
        metadataTenantsCompleted: 0,
        absentTenantsCompleted: 0,
        sourceVersionsDeleted: 0,
        metadataPurged: 0,
      };
    },
    writeReceipt: async (_path, receipt) => {
      events.push("receipt");
      written = receipt;
      return receipt;
    },
  });
  assert.deepEqual(events, [
    "backup",
    "ledger",
    "connect",
    "begin",
    "commit",
    "reconcile",
    "end",
    "receipt",
  ]);
  assert.equal(result.receipt.targetIdentitySha256.length, 64);
  assert.equal(written, result.receipt);
});

test("ledger preload and guard failures never create completion authority", async () => {
  const preloadEvents: string[] = [];
  await assert.rejects(
    runRestoreTarget({
      config: parseRestoreTargetConfig(baseEnv),
      adapters: adapters(preloadEvents),
      signal: new AbortController().signal,
      readBackup: async () => backupBytes,
      loadPlan: async () => {
        throw new Error("ledger unavailable");
      },
      writeReceipt: async () => {
        throw new Error("must not write");
      },
    }),
    /ledger unavailable/,
  );
  assert.deepEqual(preloadEvents, []);

  const failedEvents: string[] = [];
  let receiptWrites = 0;
  await assert.rejects(
    runRestoreTarget({
      config: parseRestoreTargetConfig(baseEnv),
      adapters: adapters(failedEvents),
      signal: new AbortController().signal,
      readBackup: async () => backupBytes,
      loadPlan: async () => plan,
      reconcile: async () => {
        throw new Error("reconciliation failed");
      },
      writeReceipt: async (_path, receipt) => {
        receiptWrites++;
        return receipt;
      },
    }),
    /failed/,
  );
  assert.equal(receiptWrites, 0);
  assert.equal(failedEvents.at(-1), "end");

  const connectEvents: string[] = [];
  const connectAdapters = adapters(connectEvents, { connectFailure: true });
  await assert.rejects(
    runRestoreTarget({
      config: parseRestoreTargetConfig(baseEnv),
      adapters: connectAdapters,
      signal: new AbortController().signal,
      readBackup: async () => backupBytes,
      loadPlan: async () => plan,
    }),
    /connect failed/,
  );
  assert.equal(connectAdapters.database.ended, true);

  for (const [label, currentAdapters, signal] of [
    ["busy", busyAdapters([]), new AbortController()],
    [
      "aborted",
      adapters([]),
      (() => {
        const value = new AbortController();
        value.abort();
        return value;
      })(),
    ],
  ] as const) {
    let writes = 0;
    await assert.rejects(
      runRestoreTarget({
        config: parseRestoreTargetConfig(baseEnv),
        adapters: currentAdapters,
        signal: signal.signal,
        readBackup: async () => backupBytes,
        loadPlan: async () => plan,
        reconcile: async () => ({
          entriesCompleted: 0,
          metadataTenantsCompleted: 0,
          absentTenantsCompleted: 0,
          sourceVersionsDeleted: 0,
          metadataPurged: 0,
        }),
        writeReceipt: async (_path, receipt) => {
          writes++;
          return receipt;
        },
      }),
      label === "busy" ? /busy/ : /aborted/,
    );
    assert.equal(writes, 0);
  }
});
