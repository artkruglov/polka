import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import { cleanupEmailChallengesInTransaction } from "../apps/server/email-maintenance.ts";
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

export async function runMaintenanceCleanup(
  scope: MaintenanceScope,
  storage: MaintenanceObjectStore,
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

  const emailChallengesRemoved = await scope.transaction(async (c) => {
    for (const sql of [
      "DELETE FROM viewer_grants WHERE expires_at<now()",
      "DELETE FROM grants WHERE expires_at<now()",
      "DELETE FROM sessions WHERE expires_at<now()",
      "DELETE FROM agent_connection_csrf WHERE expires_at<now()",
      "DELETE FROM login_limits WHERE reset_at<now()",
      // Consumed codes stay a day so a late replay still revokes its grant.
      "DELETE FROM oauth_authorizations WHERE expires_at<now()-interval '1 day'",
      "DELETE FROM oauth_refresh_tokens WHERE expires_at<now()",
      // The privacy policy keeps a report for one year.
      "DELETE FROM share_reports WHERE created_at<now()-interval '1 year'",
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
  };
}
