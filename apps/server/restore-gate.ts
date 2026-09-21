import { isAbsolute } from "node:path";
import { EXPECTED_MIGRATION_VERSIONS } from "../../packages/migrations.ts";
import {
  readRestoreReceipt,
  restoreTargetIdentity,
  schemaManifestSha256,
  targetIdentitySha256,
  type RestoreCompletionReceipt,
} from "../../packages/restore-receipt.ts";

export type RestoreGateConfig = {
  RESTORE_MODE: "off" | "required";
  RESTORE_RECEIPT_PATH?: string;
  RESTORE_RUN_ID?: string;
  RESTORE_BACKUP_SHA256?: string;
  RESTORE_LEDGER_ID?: string;
  RESTORE_LEDGER_MANIFEST_SHA256?: string;
  DATABASE_URL: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
};

type Queryable = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows?: Array<Record<string, unknown>> }>;
};

function exactVersions(rows: Array<Record<string, unknown>> | undefined) {
  const versions = (rows ?? []).map(({ version }) => Number(version));
  if (
    versions.length !== EXPECTED_MIGRATION_VERSIONS.length ||
    versions.some(
      (version, index) => version !== EXPECTED_MIGRATION_VERSIONS[index],
    )
  )
    throw new Error("Restore receipt schema does not match the live database");
  return versions;
}

function assertExpected(
  receipt: RestoreCompletionReceipt,
  config: RestoreGateConfig,
) {
  if (
    receipt.restoreRunId !== config.RESTORE_RUN_ID ||
    receipt.backupSha256 !== config.RESTORE_BACKUP_SHA256 ||
    receipt.ledgerId !== config.RESTORE_LEDGER_ID ||
    receipt.ledgerManifestSha256 !== config.RESTORE_LEDGER_MANIFEST_SHA256
  )
    throw new Error(
      "Restore completion receipt does not match startup authority",
    );
}

/** Must finish before createApp or any listener is constructed. */
export async function assertRestoreStartupGate(
  config: RestoreGateConfig,
  dependencies: {
    database: Queryable;
    readReceipt?: typeof readRestoreReceipt;
  },
) {
  if (config.RESTORE_MODE === "off") return { state: "off" as const };
  const receiptPath = config.RESTORE_RECEIPT_PATH;
  if (!receiptPath || !isAbsolute(receiptPath))
    throw new Error("Restore completion receipt path must be absolute");
  const receipt = await (dependencies.readReceipt ?? readRestoreReceipt)(
    receiptPath,
  );
  assertExpected(receipt, config);
  const identityResult = await dependencies.database.query(
    `SELECT current_database() AS database_name,
            (SELECT oid::text FROM pg_catalog.pg_database
              WHERE datname=current_database()) AS database_oid`,
  );
  const identityRow = identityResult.rows?.[0];
  if (
    typeof identityRow?.database_name !== "string" ||
    typeof identityRow.database_oid !== "string"
  )
    throw new Error("Restore target database identity is unavailable");
  const urlDatabaseName = decodeURIComponent(
    new URL(config.DATABASE_URL).pathname.slice(1),
  );
  if (identityRow.database_name !== urlDatabaseName)
    throw new Error("Restore target database name changed");
  const migrations = await dependencies.database.query(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const versions = exactVersions(migrations.rows);
  const schemaHash = schemaManifestSha256(versions);
  const identityHash = targetIdentitySha256(
    restoreTargetIdentity({
      databaseUrl: config.DATABASE_URL,
      databaseOid: identityRow.database_oid,
      storageEndpoint: config.S3_ENDPOINT,
      storageBucket: config.S3_BUCKET,
    }),
  );
  if (
    receipt.schemaManifestSha256 !== schemaHash ||
    receipt.targetIdentitySha256 !== identityHash
  )
    throw new Error("Restore completion receipt is stale for this target");
  return { state: "verified" as const, restoreRunId: receipt.restoreRunId };
}

export async function startAfterRestoreStartupGate<T>(
  config: RestoreGateConfig,
  dependencies: Parameters<typeof assertRestoreStartupGate>[1],
  start: () => Promise<T>,
) {
  await assertRestoreStartupGate(config, dependencies);
  return start();
}
