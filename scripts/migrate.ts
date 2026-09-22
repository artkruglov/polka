import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrationFileUrl, SCHEMA_MIGRATIONS } from "../packages/migrations.ts";
import { closeMigrationClient, runMigrations } from "./migration-runner.ts";

// Large tables make some migrations (index builds, backfills) slow; the whole
// set runs in one transaction, so the bound is per statement.
const DEFAULT_TIMEOUT_MS = 120_000;
const timeoutMs = (() => {
  const raw = process.env.MIGRATION_STATEMENT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000) {
    console.error("MIGRATION_STATEMENT_TIMEOUT_MS must be an integer from 1000 to 3600000.");
    process.exit(2);
  }
  return value;
})();

// This job receives only schema-owner DB credentials, never app/S3 secrets.
let client: pg.Client | undefined;
let currentFile: string | undefined;
try {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !["postgres:", "postgresql:"].includes(new URL(connectionString).protocol))
    throw new Error("DATABASE_URL is required");
  client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs + 5_000,
  });
  client.on("error", () => {}); // Query/connect rejects; never print raw provider diagnostics.
  await client.connect();
  await runMigrations(client, SCHEMA_MIGRATIONS, (file) => {
    currentFile = file; // The runner applies each file right after reading it.
    return readFile(migrationFileUrl(file), "utf8");
  });
} catch (error) {
  // SQLSTATE and file name only: the raw message can quote data or credentials.
  const code = (error as { code?: unknown } | null)?.code;
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "none";
  console.error(
    `Metadata migration failed${currentFile ? ` in ${currentFile}` : " before applying a migration file"} (SQLSTATE ${sqlstate}). The transaction was rolled back.`,
  );
  process.exitCode = 1;
} finally {
  if (client && !(await closeMigrationClient(client))) {
    console.error("Metadata migration database cleanup failed.");
    process.exit(1); // Dedicated one-shot job: close any remaining socket handles.
  }
}

if (!process.exitCode) console.log("Metadata schema ready.");
