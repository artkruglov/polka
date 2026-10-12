import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  CURRENT_SCHEMA_VERSION,
  EXPECTED_MIGRATION_VERSIONS,
  migrationFileUrl,
  SCHEMA_MIGRATIONS,
} from "../packages/migrations.ts";

test("migration catalog is the complete contiguous schema 72 set", async () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 72);
  assert.deepEqual(
    EXPECTED_MIGRATION_VERSIONS,
    Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
  );

  const catalogFiles = SCHEMA_MIGRATIONS.map(({ version, file }) => {
    assert.match(file, new RegExp(`^${String(version).padStart(3, "0")}_.*\\.sql$`));
    return file;
  });
  const migrationDirectory = new URL("../deploy/migrations/", import.meta.url);
  const diskFiles = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();

  assert.deepEqual(catalogFiles, diskFiles);
  await Promise.all(
    SCHEMA_MIGRATIONS.map(async ({ file }) => {
      assert.ok((await readFile(migrationFileUrl(file), "utf8")).trim());
    }),
  );
});

test("account identities are unique per provider subject and erased with a deletion request", async () => {
  const sql = await readFile(migrationFileUrl("032_account_identities.sql"), "utf8");
  assert.match(sql, /CREATE TABLE account_identities/);
  assert.match(sql, /UNIQUE \(provider, subject\)/);
  assert.match(sql, /REFERENCES accounts\(id\) ON DELETE CASCADE/);
  assert.match(sql, /WHEN \(NEW\.deletion_requested_at IS NOT NULL\)/);
  assert.match(sql, /'template_library\.domain_joined'/);
  // No function body of the purge is redefined: 031 may redefine it.
  assert.doesNotMatch(sql, /terminal_erase_account_metadata\s*\(/);
});

test("product analytics stores keys, not identities, and counts a link once a day", async () => {
  const sql = await readFile(migrationFileUrl("034_product_analytics.sql"), "utf8");
  assert.match(sql, /CREATE TABLE analytics_events/);
  assert.match(sql, /actor text CHECK \(actor ~ '\^\[A-Za-z0-9_-\]\{43\}\$'\)/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX analytics_share_opened_daily ON analytics_events\(subject, day\)\s+WHERE name='share_opened'/,
  );
  assert.match(sql, /CREATE TABLE analytics_daily/);
  assert.match(sql, /CREATE TABLE analytics_optouts/);
  // No column may hold an account, an address or a request.
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /account_id|email|\bip\b|user_agent|referer|url\b/i);
});

test("only a single-file HTML bundle may carry a static profile", async () => {
  const sql = await readFile(migrationFileUrl("027_single_file_bundle_profile.sql"), "utf8");
  assert.match(sql, /DROP CONSTRAINT bundle_revision_shape/);
  assert.match(sql, /html_profile='unsupported'/);
  assert.match(sql, /jsonb_array_length\(manifest->'files'\)=1/);
  assert.match(sql, /manifest->'files'->0->>'path'=manifest->>'entrypoint'/);
});

test("library event journal is typed, append-only, and terminal-purge redacted", async () => {
  const sql = await readFile(migrationFileUrl("026_template_library_events.sql"), "utf8");
  assert.match(sql, /CREATE TABLE template_library_events/);
  assert.match(sql, /target_account_id uuid REFERENCES accounts\(id\) ON DELETE SET NULL/);
  assert.match(sql, /template library events are append-only/);
  assert.match(sql, /NEW\.name='deleted-'\|\|NEW\.id::text/);
  assert.match(sql, /purge\.phase='source_empty'/);
  assert.doesNotMatch(sql, /OLD\.email IS NOT NULL/);
  assert.match(sql, /action IN \('template_library\.member_role_changed','template_library\.member_revoked'\)/);
});

test("template library schema pins publications to exact releases", async () => {
  const sql = await readFile(migrationFileUrl("022_template_libraries.sql"), "utf8");
  assert.match(sql, /FOREIGN KEY\(release_id,artifact_id,revision_id\)/);
  assert.match(sql, /REFERENCES template_releases\(id,artifact_id,revision_id\)/);
  assert.match(sql, /REFERENCES revisions\(artifact_id,id\) ON DELETE CASCADE/);
  assert.match(sql, /role IN \('reader','curator','admin'\)/);
  assert.match(sql, /state IN \('active','revoked'\)/);
  assert.match(sql, /state IN \('active','withdrawn'\)/);
  assert.match(sql, /created_by uuid REFERENCES accounts\(id\) ON DELETE SET NULL/);
  assert.match(sql, /publisher_id uuid REFERENCES accounts\(id\) ON DELETE SET NULL/);
});

test("library viewer grants pin session, publication, revision, and membership epoch", async () => {
  const sql = await readFile(migrationFileUrl("025_template_library_viewer_grants.sql"), "utf8");
  assert.match(sql, /CHECK \(hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /REFERENCES sessions\(hash,account_id\) ON DELETE CASCADE/);
  assert.match(sql, /REFERENCES template_library_members\(library_id,account_id,joined_at\)[\s\S]*ON DELETE CASCADE/);
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

test("049 indexes the links of a revision and the live works of a folder; 050 opens video", async () => {
  const sql = await readFile(migrationFileUrl("049_share_revision_and_folder_indexes.sql"), "utf8");
  assert.match(sql, /CREATE INDEX shares_revision ON shares \(revision_id\);/);
  assert.match(
    sql,
    /CREATE INDEX artifacts_live_folder ON artifacts \(tenant_id, folder_id\)\s+WHERE trashed_at IS NULL;/,
  );
  // Every grant recipe was reviewed for the new schema.
  for (const recipe of ["runtime-grants.sql", "purge-worker-grants.sql", "restore-worker-grants.sql"]) {
    const text = await readFile(new URL(`../deploy/${recipe}`, import.meta.url), "utf8");
    assert.match(text, /schema_migrations\)<>72\n/, recipe);
    assert.match(text, /max\(version\) FROM public.schema_migrations\)<>72 THEN/, recipe);
    assert.match(text, /001 through 072/, recipe);
  }
  const video = await readFile(migrationFileUrl("050_project_video.sql"), "utf8");
  assert.match(video, /ADD COLUMN video_enabled boolean NOT NULL DEFAULT false/);
  assert.match(video, /mime IN \('video\/mp4','video\/webm'\) AND size <= 209715200/);
});

test("071 webhooks: no work content, encrypted secret, erased with the account", async () => {
  const sql = await readFile(migrationFileUrl("071_webhooks.sql"), "utf8");
  assert.match(sql, /CREATE TABLE webhook_endpoints/);
  assert.match(sql, /secret_enc bytea NOT NULL/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bsecret text\b/);
  assert.match(sql, /response_snippet text CHECK \(char_length\(response_snippet\) <= 200\)/);
  assert.match(sql, /endpoint_id uuid NOT NULL REFERENCES webhook_endpoints\(id\) ON DELETE CASCADE/);
  assert.match(sql, /LANGUAGE plpgsql SECURITY DEFINER\nSET search_path=pg_catalog,public,pg_temp/);
  assert.match(sql, /REVOKE ALL ON FUNCTION erase_account_webhooks\(\) FROM PUBLIC/);
  assert.match(sql, /AFTER UPDATE OF deletion_requested_at,name ON accounts/);
  const grants = await readFile(new URL("../deploy/runtime-grants.sql", import.meta.url), "utf8");
  assert.match(grants, /public\.webhook_endpoints, public\.webhook_deliveries/);
});

test("the migration job gives up on a held lock after 5 s instead of queueing the app", async () => {
  const source = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");
  assert.match(source, /await client\.query\("SET lock_timeout='5s'"\);\n\s+await runMigrations\(/);
});

test("072 keeps an account disabled while the operator's or an extension's reason holds", async () => {
  const sql = await readFile(migrationFileUrl("072_account_disable_reasons.sql"), "utf8");
  assert.match(sql, /ADD COLUMN operator_disabled_at timestamptz/);
  assert.match(sql, /ADD COLUMN deprovisioned_by text CHECK/);
  assert.match(sql, /CHECK \(disabled OR \(operator_disabled_at IS NULL AND deprovisioned_at IS NULL\)\)/);
  // Every account disabled before 072 was the operator's to lift.
  assert.match(sql, /UPDATE accounts SET operator_disabled_at = now\(\) WHERE disabled;/);
});
