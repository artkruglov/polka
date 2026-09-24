export interface SchemaMigration {
  readonly version: number;
  readonly file: string;
}

const catalog = [
  { version: 1, file: "001_foundation.sql" },
  { version: 2, file: "002_upload_reconciliation.sql" },
  { version: 3, file: "003_html_static_and_reports.sql" },
  { version: 4, file: "004_email_identity.sql" },
  { version: 5, file: "005_local_live_viewer.sql" },
  { version: 6, file: "006_revision_manifest.sql" },
  { version: 7, file: "007_bundle_storage.sql" },
  { version: 8, file: "008_bundle_inline_derivatives.sql" },
  { version: 9, file: "009_agent_connections.sql" },
  { version: 10, file: "010_agent_upload_binding.sql" },
  { version: 11, file: "011_agent_audit_identity.sql" },
  { version: 12, file: "012_agent_share_operations.sql" },
  { version: 13, file: "013_artifact_trash.sql" },
  { version: 14, file: "014_agent_management.sql" },
  { version: 15, file: "015_editorial_publications.sql" },
  { version: 16, file: "016_account_deletion.sql" },
  { version: 17, file: "017_account_purge.sql" },
  { version: 18, file: "018_erasure_restore_suppression.sql" },
  { version: 19, file: "019_url_import_jobs.sql" },
  { version: 20, file: "020_purge_url_import_jobs.sql" },
  { version: 21, file: "021_agent_context_templates.sql" },
  { version: 22, file: "022_template_libraries.sql" },
  { version: 23, file: "023_purge_template_library_identities.sql" },
  { version: 24, file: "024_template_library_invitations.sql" },
  { version: 25, file: "025_template_library_viewer_grants.sql" },
  { version: 26, file: "026_template_library_events.sql" },
  { version: 27, file: "027_single_file_bundle_profile.sql" },
  { version: 28, file: "028_mcp_oauth.sql" },
  { version: 29, file: "029_abuse_protection.sql" },
  { version: 30, file: "030_comments.sql" },
  { version: 31, file: "031_content_filter.sql" },
  { version: 32, file: "032_account_identities.sql" },
  { version: 33, file: "033_enterprise_requests.sql" },
  { version: 34, file: "034_product_analytics.sql" },
] as const satisfies readonly SchemaMigration[];

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = Object.freeze(
  catalog.map((migration) => Object.freeze({ ...migration })),
);

export const EXPECTED_MIGRATION_VERSIONS: readonly number[] = Object.freeze(
  SCHEMA_MIGRATIONS.map(({ version }) => version),
);

export const CURRENT_SCHEMA_VERSION =
  SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]!.version;

export function migrationFileUrl(file: string): URL {
  return new URL(`../deploy/migrations/${file}`, import.meta.url);
}
