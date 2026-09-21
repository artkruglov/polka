import type { PoolClient } from "pg";

type MigrationClient = Pick<PoolClient, "query">;
type Migration = { version: number; file: string };

/** One transaction and advisory lock cover the complete ordered migration set. */
export async function runMigrations(
  client: MigrationClient,
  migrations: readonly Migration[],
  readSql: (file: string) => Promise<string>,
) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(4388001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const { version, file } of migrations) {
      if ((await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version])).rowCount)
        continue;
      await client.query(await readSql(file));
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* The caller discards this connection. */ }
    throw error;
  }
}

/** False means the CLI must fail and terminate its own remaining DB handles. */
export async function closeMigrationClient(
  client: { end(): Promise<void> },
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve().then(() => client.end()).then(() => finish(true), () => finish(false));
  });
}
