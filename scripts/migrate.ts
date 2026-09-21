import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrationFileUrl, SCHEMA_MIGRATIONS } from "../packages/migrations.ts";
import { closeMigrationClient, runMigrations } from "./migration-runner.ts";

// This job receives only schema-owner DB credentials, never app/S3 secrets.
let client: pg.Client | undefined;
try {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !["postgres:", "postgresql:"].includes(new URL(connectionString).protocol))
    throw new Error("DATABASE_URL is required");
  client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 15000,
  });
  client.on("error", () => {}); // Query/connect rejects; never print raw provider diagnostics.
  await client.connect();
  await runMigrations(client, SCHEMA_MIGRATIONS, (file) =>
    readFile(migrationFileUrl(file), "utf8"),
  );
} catch {
  console.error("Metadata migration failed. Check database access and the migration files.");
  process.exitCode = 1;
} finally {
  if (client && !(await closeMigrationClient(client))) {
    console.error("Metadata migration database cleanup failed.");
    process.exit(1); // Dedicated one-shot job: close any remaining socket handles.
  }
}

if (!process.exitCode) console.log("Metadata schema ready.");
