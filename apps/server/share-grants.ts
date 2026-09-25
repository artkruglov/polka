import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { revisionDTO } from "./artifacts.ts";
import {
  isServedBuilderVersion,
  isServedRuntimeProfile,
} from "./bundle-runtime-contract.ts";
import { config } from "./config.ts";
import { autoCheckedClean } from "./content-filter/policy.ts";
import { sensitiveInputOf } from "./content-filter/sensitive-input.ts";
import { missing } from "./errors.ts";
import { isStaticSingleFileBundle } from "./revision-manifest.ts";
import { sha256 } from "./storage.ts";

/**
 * A 60-second view grant for the version a share points at: the recipient's
 * link (/api/resolve) and the operator's preview from a moderation letter
 * use the same one. The caller has locked and checked the share.
 */
export async function issueShareGrant(
  c: PoolClient,
  share: { id: string; revision_id: string; derivative_id: string | null },
  artifactId: string,
) {
  const r = (
    await c.query(
      `SELECT r.*,
         CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
           'state',d.state,'runtimeProfile',d.runtime_profile,'reason',NULL,'path',NULL
         ) END AS inline_build,
         d.state AS derivative_state,d.source_manifest_sha256 AS derivative_source,
         d.builder_version AS derivative_builder,d.runtime_profile AS derivative_profile
       FROM revisions r
       LEFT JOIN revision_derivatives d ON d.id=$2 AND d.revision_id=r.id
       WHERE r.id=$1 AND r.artifact_id=$3`,
      [share.revision_id, share.derivative_id, artifactId],
    )
  ).rows[0];
  // A bundle (other than a lone static page) and any share bound to an
  // interactive version open only through that ready derivative.
  const needsDerivative =
    r?.storage_kind === "bundle"
      ? !(isStaticSingleFileBundle(r) && !share.derivative_id)
      : !!share.derivative_id;
  if (
    !r ||
    (needsDerivative &&
      (!config.HTML_LIVE_ENABLED ||
        !share.derivative_id ||
        r.derivative_state !== "ready" ||
        r.derivative_source !== r.manifest_sha256 ||
        !isServedBuilderVersion(r.derivative_builder) ||
        !isServedRuntimeProfile(r.derivative_profile)))
  )
    throw missing();
  const grant = randomBytes(32).toString("base64url");
  const g = (
    await c.query(
      "INSERT INTO grants(hash,share_id,revision_id,derivative_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '60 seconds') RETURNING expires_at",
      [sha256(grant), share.id, r.id, share.derivative_id],
    )
  ).rows[0];
  return {
    revision: revisionDTO(r),
    grant,
    expiresAt: (g.expires_at as Date).toISOString(),
    // What the recipient's note says about this version (never the findings).
    sensitiveInput: sensitiveInputOf(r.content_filter),
    autoChecked: autoCheckedClean(r.content_filter),
  };
}
