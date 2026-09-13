import { readFile } from "node:fs/promises";
import { db, transaction } from "../apps/server/db.ts";
import { prepareBucket, s3 } from "../apps/server/storage.ts";
try {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4388001)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const [version, file] of [
      [1, "001_foundation.sql"],
      [2, "002_upload_reconciliation.sql"],
    ] as const) {
      if (
        (
          await c.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
            version,
          ])
        ).rowCount
      )
        continue;
      await c.query(
        await readFile(
          new URL(`../deploy/migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        version,
      ]);
    }
  });
  await prepareBucket();
  console.log("Metadata schema and versioned private bucket ready.");
} finally {
  await db.end();
  s3.destroy();
}
