import { CURRENT_SCHEMA_VERSION } from "../packages/migrations.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRestoreStartupGate,
  startAfterRestoreStartupGate,
  type RestoreGateConfig,
} from "../apps/server/restore-gate.ts";
import { EXPECTED_MIGRATION_VERSIONS } from "../packages/migrations.ts";
import {
  ledgerManifestSha256,
  restoreTargetIdentity,
  schemaManifestSha256,
  targetIdentitySha256,
  type RestoreCompletionReceipt,
} from "../packages/restore-receipt.ts";

const config: RestoreGateConfig = {
  RESTORE_MODE: "required",
  RESTORE_RECEIPT_PATH: "/receipt/completion.json",
  RESTORE_RUN_ID: "00000000-0000-4000-8000-000000000001",
  RESTORE_BACKUP_SHA256: "a".repeat(64),
  RESTORE_LEDGER_ID: "00000000-0000-4000-8000-000000000002",
  RESTORE_LEDGER_MANIFEST_SHA256: ledgerManifestSha256([]),
  DATABASE_URL: "postgres://runtime:hidden@localhost:5432/polka",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "content",
};

function validReceipt(): RestoreCompletionReceipt {
  return {
    version: 1,
    restoreRunId: config.RESTORE_RUN_ID!,
    backupSha256: config.RESTORE_BACKUP_SHA256!,
    targetIdentitySha256: targetIdentitySha256(
      restoreTargetIdentity({
        databaseUrl: config.DATABASE_URL,
        databaseOid: "42",
        storageEndpoint: config.S3_ENDPOINT,
        storageBucket: config.S3_BUCKET,
      }),
    ),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    schemaManifestSha256: schemaManifestSha256(EXPECTED_MIGRATION_VERSIONS),
    ledgerId: config.RESTORE_LEDGER_ID!,
    ledgerManifestSha256: config.RESTORE_LEDGER_MANIFEST_SHA256!,
  };
}

function database(options: { oid?: string; versions?: number[] } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async query(sql: string) {
      calls++;
      if (sql.includes("pg_catalog.pg_database"))
        return {
          rows: [{ database_name: "polka", database_oid: options.oid ?? "42" }],
        };
      return {
        rows: (options.versions ?? EXPECTED_MIGRATION_VERSIONS).map(
          (version) => ({ version }),
        ),
      };
    },
  };
}

test("restore startup gate is a no-op when restore mode is off", async () => {
  const db = database();
  assert.deepEqual(
    await assertRestoreStartupGate(
      { ...config, RESTORE_MODE: "off" },
      {
        database: db,
        readReceipt: async () => {
          throw new Error("must not read");
        },
      },
    ),
    { state: "off" },
  );
  assert.equal(db.calls, 0);
});

test("restore startup gate binds receipt to live target and exact schema", async () => {
  const db = database();
  assert.deepEqual(
    await assertRestoreStartupGate(config, {
      database: db,
      readReceipt: async () => validReceipt(),
    }),
    { state: "verified", restoreRunId: config.RESTORE_RUN_ID },
  );
  await assert.rejects(
    assertRestoreStartupGate(config, {
      database: database({ oid: "43" }),
      readReceipt: async () => validReceipt(),
    }),
    /stale/,
  );
  await assert.rejects(
    assertRestoreStartupGate(config, {
      database: database({
        versions: EXPECTED_MIGRATION_VERSIONS.slice(0, -1),
      }),
      readReceipt: async () => validReceipt(),
    }),
    /schema/,
  );
  await assert.rejects(
    assertRestoreStartupGate(
      { ...config, RESTORE_BACKUP_SHA256: "f".repeat(64) },
      { database: database(), readReceipt: async () => validReceipt() },
    ),
    /startup authority/,
  );
  await assert.rejects(
    assertRestoreStartupGate(config, {
      database: database(),
      readReceipt: async () => {
        throw new Error("receipt missing");
      },
    }),
    /receipt missing/,
  );
  await assert.rejects(
    assertRestoreStartupGate(
      { ...config, RESTORE_RUN_ID: "00000000-0000-4000-8000-000000000099" },
      { database: database(), readReceipt: async () => validReceipt() },
    ),
    /startup authority/,
  );
  await assert.rejects(
    assertRestoreStartupGate(
      { ...config, RESTORE_LEDGER_ID: "00000000-0000-4000-8000-000000000099" },
      { database: database(), readReceipt: async () => validReceipt() },
    ),
    /startup authority/,
  );
});

test("startup boundary never constructs the app after a receipt refusal", async () => {
  let constructed = false;
  await assert.rejects(
    startAfterRestoreStartupGate(
      config,
      {
        database: database(),
        readReceipt: async () => {
          throw new Error("refused");
        },
      },
      async () => {
        constructed = true;
        return {};
      },
    ),
    /refused/,
  );
  assert.equal(constructed, false);
});
