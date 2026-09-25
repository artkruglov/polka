import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import { cleanupEmailChallengesInTransaction } from "../apps/server/email-maintenance.ts";
import {
  closeProvisionalShelf,
  eraseProvisionalShelfRows,
  idleProvisionalShelves,
  retireProvisionalShelf,
  type ProvisionalRetirementPolicy,
} from "../apps/server/provisional-maintenance.ts";
import type { MaintenanceClient } from "./maintenance-guard.ts";

export type MaintenanceObjectVersion = {
  key: string;
  versionId: string;
};

export type MaintenanceObjectPage = {
  versions: Array<{ key?: string; versionId?: string }>;
  deleteMarkers: Array<{ key?: string; versionId?: string }>;
  truncated: boolean;
  nextKeyMarker?: string;
  nextVersionIdMarker?: string;
};

export type MaintenanceObjectStore = {
  listVersions: (
    input: {
      prefix: string;
      keyMarker?: string;
      versionIdMarker?: string;
      maxKeys: number;
    },
    signal: AbortSignal,
  ) => Promise<MaintenanceObjectPage>;
  deleteVersion: (
    key: string,
    versionId: string,
    signal: AbortSignal,
  ) => Promise<void>;
};

export type MaintenanceScope = {
  signal: AbortSignal;
  transaction: <R>(
    operation: (client: MaintenanceClient) => Promise<R>,
  ) => Promise<R>;
};

export type MaintenanceCounters = {
  expiredUploadsReconciled: number;
  expiredDerivativesReconciled: number;
  emailChallengesRemoved: number;
  /** Idle provisional shelves handed to the deletion pipeline. */
  provisionalShelvesRetired: number;
};

export class MaintenanceStorageFailure extends Error {}
class MaintenanceStopped extends Error {}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new MaintenanceStopped();
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "null";
}

export async function storedVersions(
  storage: MaintenanceObjectStore,
  prefix: string,
  expected: ReadonlySet<string>,
  signal: AbortSignal,
) {
  const found: MaintenanceObjectVersion[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (let page = 0; page < 100; page++) {
    assertActive(signal);
    const result = await storage.listVersions(
      { prefix, keyMarker, versionIdMarker, maxKeys: 100 },
      signal,
    );
    assertActive(signal);
    for (const value of [...result.versions, ...result.deleteMarkers]) {
      if (!value.key || !expected.has(value.key)) continue;
      if (!validVersion(value.versionId)) throw new MaintenanceStorageFailure();
      found.push({ key: value.key, versionId: value.versionId });
    }
    if (!result.truncated) return found;
    if (
      !result.nextKeyMarker ||
      (result.nextKeyMarker === keyMarker &&
        result.nextVersionIdMarker === versionIdMarker)
    )
      throw new MaintenanceStorageFailure();
    keyMarker = result.nextKeyMarker;
    versionIdMarker = result.nextVersionIdMarker;
  }
  throw new MaintenanceStorageFailure();
}

async function deleteStoredVersions(
  storage: MaintenanceObjectStore,
  prefix: string,
  expected: ReadonlySet<string>,
  signal: AbortSignal,
) {
  const versions = await storedVersions(storage, prefix, expected, signal);
  for (const version of versions) {
    assertActive(signal);
    await storage.deleteVersion(version.key, version.versionId, signal);
    assertActive(signal);
  }
}

/**
 * Deletes the usage events and active days of every account that asked to be
 * deleted (a deletion request, a purge, a restored erasure). The keys are
 * HMACs only the application can compute, so this runs here.
 */
export async function eraseDeletedAccountsAnalytics(
  c: MaintenanceClient,
  actorKey: (accountId: string) => string,
  check: () => void = () => undefined,
) {
  const deleted = await c.query(
    "SELECT id FROM accounts WHERE deletion_requested_at IS NOT NULL",
  );
  const keys = ((deleted.rows ?? []) as Array<{ id: string }>).map((row) =>
    actorKey(row.id),
  );
  check();
  if (!keys.length) return;
  for (const sql of [
    "DELETE FROM analytics_events WHERE actor=ANY($1::text[])",
    "DELETE FROM analytics_active_days WHERE actor=ANY($1::text[])",
  ]) {
    await c.query(sql, [keys]);
    check();
  }
}

export type MaintenanceOptions = {
  /**
   * The analytics key of an account (apps/server/analytics-keys.ts). Given,
   * maintenance deletes the usage events of every deleted account: only the
   * application knows the key, so neither the purge worker nor a restore can.
   */
  analyticsActorKey?: (accountId: string) => string;
  /**
   * With account deletion enabled: its policy. Provisional shelves nobody
   * used for `idleDays` are then deleted (apps/server/provisional-maintenance.ts).
   */
  provisionalRetirement?: ProvisionalRetirementPolicy;
  /**
   * Without the deletion pipeline: idle provisional shelves are deleted here,
   * objects under their tenant prefix included, after this many idle days.
   */
  provisionalIdleDays?: number;
};

/** Every version (and delete marker) under `prefix`, deleted. */
async function deleteEveryVersion(
  storage: MaintenanceObjectStore,
  prefix: string,
  signal: AbortSignal,
) {
  for (let round = 0; round < 1000; round++) {
    assertActive(signal);
    const page = await storage.listVersions({ prefix, maxKeys: 100 }, signal);
    const all = [...page.versions, ...page.deleteMarkers];
    if (!all.length) {
      if (page.truncated) throw new MaintenanceStorageFailure();
      return;
    }
    for (const value of all) {
      if (!value.key?.startsWith(prefix) || !validVersion(value.versionId))
        throw new MaintenanceStorageFailure();
      assertActive(signal);
      await storage.deleteVersion(value.key, value.versionId, signal);
    }
  }
  throw new MaintenanceStorageFailure();
}

export async function runMaintenanceCleanup(
  scope: MaintenanceScope,
  storage: MaintenanceObjectStore,
  options: MaintenanceOptions = {},
): Promise<MaintenanceCounters> {
  const uploadCandidates = await scope.transaction(async (c) => {
    assertActive(scope.signal);
    const result = await c.query(
      `SELECT id,tenant_id FROM uploads
       WHERE receipt IS NULL AND reconciled_at IS NULL
         AND (aborted OR expires_at<now())
       ORDER BY expires_at,id LIMIT 100`,
    );
    assertActive(scope.signal);
    return result.rows ?? [];
  });
  let expiredUploadsReconciled = 0;
  for (const candidate of uploadCandidates) {
    const committed = await scope.transaction(async (c) => {
      await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [
        candidate.tenant_id,
      ]);
      const lockedUpload = await c.query(
        `SELECT * FROM uploads
         WHERE id=$1 AND tenant_id=$2 AND receipt IS NULL
           AND reconciled_at IS NULL AND (aborted OR expires_at<now())
         FOR UPDATE`,
        [candidate.id, candidate.tenant_id],
      );
      const upload = lockedUpload.rows?.[0];
      if (!upload) return false;
      const prefix = `${upload.tenant_id}/${upload.id}`;
      const expected = new Set<string>([prefix]);
      if (upload.kind === "bundle") {
        const request = upload.request as { manifest?: unknown };
        const manifest = canonicalizeManifest(request.manifest);
        for (const [index, file] of manifest.files.entries())
          expected.add(
            file.path === manifest.entrypoint
              ? prefix
              : `${prefix}/files/${index}`,
          );
      }
      const referenced = await c.query(
        `SELECT object_key FROM revisions WHERE object_key=ANY($1::text[])
         UNION ALL
         SELECT object_key FROM revision_files WHERE object_key=ANY($1::text[])
         LIMIT 1`,
        [[...expected]],
      );
      if (referenced.rows?.length)
        throw new Error("Receipt reconciliation required");
      await deleteStoredVersions(storage, prefix, expected, scope.signal);
      assertActive(scope.signal);
      await c.query(
        `UPDATE uploads
         SET aborted=true,object_version=NULL,reconciled_at=now()
         WHERE id=$1`,
        [upload.id],
      );
      return true;
    });
    if (committed) expiredUploadsReconciled++;
  }

  const derivativeCandidates = await scope.transaction(async (c) => {
    assertActive(scope.signal);
    const result = await c.query(
      `SELECT id,tenant_id FROM revision_derivatives
       WHERE state='pending' AND attempt_expires_at<now()
       ORDER BY attempt_expires_at,id LIMIT 100`,
    );
    assertActive(scope.signal);
    return result.rows ?? [];
  });
  let expiredDerivativesReconciled = 0;
  for (const candidate of derivativeCandidates) {
    const committed = await scope.transaction(async (c) => {
      await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [
        candidate.tenant_id,
      ]);
      const lockedDerivative = await c.query(
        `SELECT * FROM revision_derivatives
         WHERE id=$1 AND tenant_id=$2 AND state='pending'
           AND attempt_expires_at<now()
         FOR UPDATE`,
        [candidate.id, candidate.tenant_id],
      );
      const derivative = lockedDerivative.rows?.[0];
      if (!derivative) return false;
      const key = `${derivative.tenant_id}/derivatives/${derivative.id}/${derivative.attempt_id}.html`;
      await deleteStoredVersions(storage, key, new Set([key]), scope.signal);
      assertActive(scope.signal);
      await c.query(
        `UPDATE revision_derivatives
         SET state='failed',attempt_expires_at=NULL,
             reason='Сборка не завершилась вовремя. Повторите её.',
             error_path=NULL,updated_at=now()
         WHERE id=$1`,
        [derivative.id],
      );
      return true;
    });
    if (committed) expiredDerivativesReconciled++;
  }

  let provisionalShelvesRetired = 0;
  if (!options.provisionalRetirement && options.provisionalIdleDays) {
    const idleDays = options.provisionalIdleDays;
    const idle = await scope.transaction(async (c) => {
      assertActive(scope.signal);
      return idleProvisionalShelves(c, { idleDays });
    });
    for (const shelf of idle) {
      assertActive(scope.signal);
      const closed = await scope.transaction((c) =>
        closeProvisionalShelf(c, shelf, idleDays),
      );
      if (!closed.closed) continue;
      provisionalShelvesRetired++;
      if (!closed.erase) continue;
      await deleteEveryVersion(storage, `${shelf.tenant}/`, scope.signal);
      await scope.transaction((c) => eraseProvisionalShelfRows(c, shelf));
    }
  }
  if (options.provisionalRetirement) {
    const policy = options.provisionalRetirement;
    const idle = await scope.transaction(async (c) => {
      assertActive(scope.signal);
      return idleProvisionalShelves(c, policy);
    });
    for (const shelf of idle) {
      assertActive(scope.signal);
      if (
        await scope.transaction((c) => retireProvisionalShelf(c, shelf, policy))
      )
        provisionalShelvesRetired++;
    }
  }

  const emailChallengesRemoved = await scope.transaction(async (c) => {
    for (const sql of [
      "DELETE FROM viewer_grants WHERE expires_at<now()",
      "DELETE FROM project_view_grants WHERE expires_at<now()",
      "DELETE FROM grants WHERE expires_at<now()",
      "DELETE FROM sessions WHERE expires_at<now()",
      "DELETE FROM agent_connection_csrf WHERE expires_at<now()",
      "DELETE FROM login_limits WHERE reset_at<now()",
      // Consumed codes stay a day so a late replay still revokes its grant.
      "DELETE FROM oauth_authorizations WHERE expires_at<now()-interval '1 day'",
      "DELETE FROM oauth_refresh_tokens WHERE expires_at<now()",
      // Sign-in links from agents live 5 minutes; a day later they go.
      "DELETE FROM agent_sign_in_links WHERE expires_at<now()-interval '1 day'",
      // The privacy policy keeps a report for one year.
      "DELETE FROM share_reports WHERE created_at<now()-interval '1 year'",
      // The moderation journal is kept for 3 years (its trigger refuses any
      // younger event), and so are closed blocks: the SHA-256 stop list.
      "DELETE FROM moderation_events WHERE created_at<now()-interval '3 years'",
      `DELETE FROM moderation_blocks
       WHERE (purged_at IS NOT NULL OR released_at IS NOT NULL)
         AND blocked_at<now()-interval '3 years'`,
      // Requests from /enterprise: one year, as the privacy policy says.
      "DELETE FROM enterprise_requests WHERE created_at<now()-interval '1 year'",
      // Usage events and active days: 13 months, as the privacy policy says.
      // The anonymous daily counters (analytics_daily) are kept.
      "DELETE FROM analytics_events WHERE occurred_at<now()-interval '13 months'",
      "DELETE FROM analytics_active_days WHERE day<(now()-interval '13 months')::date",
      `DELETE FROM oauth_clients client
       WHERE client.created_at<now()-interval '30 days'
         AND NOT EXISTS(SELECT 1 FROM agent_connections connection
                        WHERE connection.oauth_client_id=client.client_id)
         AND NOT EXISTS(SELECT 1 FROM oauth_authorizations request
                        WHERE request.client_id=client.client_id)`,
    ]) {
      assertActive(scope.signal);
      await c.query(sql);
      assertActive(scope.signal);
    }
    if (options.analyticsActorKey)
      await eraseDeletedAccountsAnalytics(c, options.analyticsActorKey, () =>
        assertActive(scope.signal),
      );
    return cleanupEmailChallengesInTransaction(
      c as Parameters<typeof cleanupEmailChallengesInTransaction>[0],
      100,
      () => assertActive(scope.signal),
    );
  });

  return {
    expiredUploadsReconciled,
    expiredDerivativesReconciled,
    emailChallengesRemoved,
    provisionalShelvesRetired,
  };
}
