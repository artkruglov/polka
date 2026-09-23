import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  CURRENT_SCHEMA_VERSION,
  EXPECTED_MIGRATION_VERSIONS,
  migrationFileUrl,
  SCHEMA_MIGRATIONS,
} from "../packages/migrations.ts";

test("migration catalog is the complete schema 33 set (032 from a concurrent branch optional)", async () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 33);
  // 032_account_identities.sql lands from a concurrent branch; until it is on
  // main the catalog is 1..33 with or without it, never with another gap.
  // 031_content_filter.sql is required.
  assert.ok(new Set(EXPECTED_MIGRATION_VERSIONS).has(31));
  const present = new Set(EXPECTED_MIGRATION_VERSIONS);
  assert.deepEqual(
    EXPECTED_MIGRATION_VERSIONS,
    Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1).filter(
      (version) => (version !== 31 && version !== 32) || present.has(version),
    ),
  );

  const catalogFiles = SCHEMA_MIGRATIONS.map(({ version, file }) => {
    assert.match(
      file,
      new RegExp(`^${String(version).padStart(3, "0")}_.*\\.sql$`),
    );
    return file;
  });
  const migrationDirectory = new URL("../deploy/migrations/", import.meta.url);
  const diskFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  assert.deepEqual(catalogFiles, diskFiles);
  await Promise.all(
    SCHEMA_MIGRATIONS.map(async ({ file }) => {
      assert.ok((await readFile(migrationFileUrl(file), "utf8")).trim());
    }),
  );
});

test("only a single-file HTML bundle may carry a static profile", async () => {
  const sql = await readFile(
    migrationFileUrl("027_single_file_bundle_profile.sql"),
    "utf8",
  );
  assert.match(sql, /DROP CONSTRAINT bundle_revision_shape/);
  assert.match(sql, /html_profile='unsupported'/);
  assert.match(sql, /jsonb_array_length\(manifest->'files'\)=1/);
  assert.match(sql, /manifest->'files'->0->>'path'=manifest->>'entrypoint'/);
});

test("library event journal is typed, append-only, and terminal-purge redacted", async () => {
  const sql = await readFile(
    migrationFileUrl("026_template_library_events.sql"),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE template_library_events/);
  assert.match(
    sql,
    /target_account_id uuid REFERENCES accounts\(id\) ON DELETE SET NULL/,
  );
  assert.match(sql, /template library events are append-only/);
  assert.match(sql, /NEW\.name='deleted-'\|\|NEW\.id::text/);
  assert.match(sql, /purge\.phase='source_empty'/);
  assert.doesNotMatch(sql, /OLD\.email IS NOT NULL/);
  assert.match(
    sql,
    /action IN \('template_library\.member_role_changed','template_library\.member_revoked'\)/,
  );
});

test("template library schema pins publications to exact releases", async () => {
  const sql = await readFile(
    migrationFileUrl("022_template_libraries.sql"),
    "utf8",
  );
  assert.match(sql, /FOREIGN KEY\(release_id,artifact_id,revision_id\)/);
  assert.match(
    sql,
    /REFERENCES template_releases\(id,artifact_id,revision_id\)/,
  );
  assert.match(sql, /REFERENCES revisions\(artifact_id,id\) ON DELETE CASCADE/);
  assert.match(sql, /role IN \('reader','curator','admin'\)/);
  assert.match(sql, /state IN \('active','revoked'\)/);
  assert.match(sql, /state IN \('active','withdrawn'\)/);
  assert.match(
    sql,
    /created_by uuid REFERENCES accounts\(id\) ON DELETE SET NULL/,
  );
  assert.match(
    sql,
    /publisher_id uuid REFERENCES accounts\(id\) ON DELETE SET NULL/,
  );
});

test("library viewer grants pin session, publication, revision, and membership epoch", async () => {
  const sql = await readFile(
    migrationFileUrl("025_template_library_viewer_grants.sql"),
    "utf8",
  );
  assert.match(sql, /CHECK \(hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /REFERENCES sessions\(hash,account_id\) ON DELETE CASCADE/);
  assert.match(
    sql,
    /REFERENCES template_library_members\(library_id,account_id,joined_at\)[\s\S]*ON DELETE CASCADE/,
  );
  assert.match(
    sql,
    /REFERENCES template_library_publications\(id,library_id,artifact_id,revision_id\)[\s\S]*ON DELETE CASCADE/,
  );
  assert.match(sql, /expires_at<=created_at\+interval '60 seconds'/);
});

test("exported migration catalog cannot be mutated at runtime", () => {
  assert.ok(Object.isFrozen(SCHEMA_MIGRATIONS));
  assert.ok(SCHEMA_MIGRATIONS.every((migration) => Object.isFrozen(migration)));
  assert.ok(Object.isFrozen(EXPECTED_MIGRATION_VERSIONS));
});
