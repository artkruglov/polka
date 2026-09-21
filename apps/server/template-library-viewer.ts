import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor } from "./artifacts.ts";
import { readAuthorizedRevisionSource } from "./artifacts.ts";
import { buildInlineRevisionFromSource } from "./bundle-derivatives.ts";
import {
  BUNDLE_BUILDER_VERSION,
  BUNDLE_RUNTIME_PROFILE,
} from "./bundle-runtime-contract.ts";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { missing } from "./errors.ts";
import { readBlob, sha256 } from "./storage.ts";
import {
  authorizeTemplateRevision,
  type TemplateLibraryRevisionRequest,
} from "./template-library-access.ts";
import { isLiveRevisionEligible } from "./viewer-config.ts";

const LIVE_HTML_PROFILE = "inline-live-experimental-v1";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type LibraryLiveViewResult =
  | {
      status: "ready";
      url: string;
      expiresAt: string;
      profile: string;
    }
  | {
      status: "preparation_required";
      revisionId: string;
      build: {
        state: "pending" | "unsupported" | "failed";
        runtimeProfile: string | null;
        reason: string | null;
        path: string | null;
      } | null;
    };

export async function prepareLibraryLiveView(
  actor: Actor,
  request: TemplateLibraryRevisionRequest,
  dependencies: { build?: typeof buildInlineRevisionFromSource } = {},
) {
  if (
    !config.HTML_LIVE_ENABLED ||
    !isLiveRevisionEligible(config, request.revisionId)
  )
    throw missing();
  const initial = await transaction((c) =>
    authorizeTemplateRevision(c, actor, request),
  );
  const authorizeBuild = async (c: PoolClient) => {
    const authorized = await authorizeTemplateRevision(c, actor, request, {
      sourceMutation: true,
    });
    if (
      authorized.sourceTenantId !== initial.sourceTenantId ||
      authorized.membershipJoinedAt !== initial.membershipJoinedAt
    )
      throw missing();
    return authorized;
  };
  const runTransaction = <T>(operation: (c: PoolClient) => Promise<T>) =>
    transaction(async (c) => {
      await authorizeBuild(c);
      return operation(c);
    });
  const built = await (dependencies.build ?? buildInlineRevisionFromSource)({
    sourceTenantId: initial.sourceTenantId,
    revisionId: request.revisionId,
    runTransaction,
    readSource: () =>
      transaction(async (c) => {
        const authorized = await authorizeBuild(c);
        const revision = (
          await c.query(
            `SELECT * FROM revisions
             WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3`,
            [request.revisionId, request.artifactId, authorized.sourceTenantId],
          )
        ).rows[0];
        return readAuthorizedRevisionSource(c, revision);
      }),
  });
  return {
    revisionId: request.revisionId,
    concurrent: built.concurrent,
    ...built.status,
  };
}

export async function issueLibraryLiveView(
  actor: Actor,
  sessionToken: string,
  request: TemplateLibraryRevisionRequest,
): Promise<LibraryLiveViewResult> {
  if (
    !config.HTML_LIVE_ENABLED ||
    !isLiveRevisionEligible(config, request.revisionId)
  )
    throw missing();
  const token = randomBytes(32).toString("base64url");
  const sessionHash = sha256(sessionToken);
  return transaction(async (c) => {
    const authorized = await authorizeTemplateRevision(c, actor, request);
    const {
      rows: [session],
    } = await c.query(
      `SELECT expires_at FROM sessions
       WHERE hash=$1 AND account_id=$2 AND expires_at>clock_timestamp()
       FOR SHARE`,
      [sessionHash, actor.id],
    );
    if (!session) throw missing();

    const {
      rows: [revision],
    } = await c.query(
      `SELECT storage_kind,mime,manifest_sha256
       FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3`,
      [request.revisionId, request.artifactId, authorized.sourceTenantId],
    );
    if (!revision || revision.mime !== "text/html") throw missing();

    let derivative: any = null;
    if (revision.storage_kind === "bundle") {
      const {
        rows: [candidate],
      } = await c.query(
        `SELECT id,state,runtime_profile,reason,error_path
         FROM revision_derivatives
         WHERE revision_id=$1 AND source_manifest_sha256=$2 AND builder_version=$3
         FOR SHARE`,
        [request.revisionId, revision.manifest_sha256, BUNDLE_BUILDER_VERSION],
      );
      if (
        !candidate ||
        candidate.state !== "ready" ||
        candidate.runtime_profile !== BUNDLE_RUNTIME_PROFILE
      ) {
        return {
          status: "preparation_required",
          revisionId: request.revisionId,
          build: candidate
            ? {
                state: candidate.state,
                runtimeProfile: candidate.runtime_profile ?? null,
                reason: candidate.reason ?? null,
                path: candidate.error_path ?? null,
              }
            : null,
        };
      }
      derivative = candidate;
    } else if (revision.storage_kind !== "single") {
      throw missing();
    }

    const {
      rows: [grant],
    } = await c.query(
      `WITH issued AS (SELECT clock_timestamp() AS at)
       INSERT INTO template_library_viewer_grants(
         hash,session_hash,library_id,publication_id,artifact_id,revision_id,
         member_account_id,membership_joined_at,derivative_id,expires_at,created_at
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,
              LEAST(issued.at+interval '60 seconds',$10::timestamptz),issued.at
       FROM issued
       WHERE $10::timestamptz>issued.at
       RETURNING expires_at`,
      [
        sha256(token),
        sessionHash,
        request.libraryId,
        request.publicationId,
        request.artifactId,
        request.revisionId,
        actor.id,
        authorized.membershipJoinedAt,
        derivative?.id ?? null,
        session.expires_at,
      ],
    );
    if (!grant) throw missing();
    return {
      status: "ready",
      url: `${config.VIEWER_ORIGIN}/library-document/${token}`,
      expiresAt: grant.expires_at.toISOString(),
      profile: derivative ? BUNDLE_RUNTIME_PROFILE : LIVE_HTML_PROFILE,
    };
  });
}

async function candidateForToken(c: Pick<PoolClient, "query">, token: string) {
  const {
    rows: [candidate],
  } = await c.query(
    `SELECT viewer_grant.library_id AS "libraryId",
            viewer_grant.publication_id AS "publicationId",
            viewer_grant.artifact_id AS "artifactId",
            viewer_grant.revision_id AS "revisionId",
            viewer_grant.member_account_id AS "accountId",
            viewer_grant.membership_joined_at::text AS "membershipJoinedAt",
            viewer_grant.session_hash AS "sessionHash",
            tenant.id AS "tenantId"
     FROM template_library_viewer_grants viewer_grant
     JOIN tenants tenant ON tenant.owner_id=viewer_grant.member_account_id
     WHERE viewer_grant.hash=$1`,
    [sha256(token)],
  );
  return candidate ?? null;
}

export async function readLibraryLiveDocument(token: string) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(token)) throw missing();
  return transaction(async (c) => {
    // This first read only discovers the lock set. Authorization is repeated
    // below before the grant or any stored bytes are trusted.
    const candidate = await candidateForToken(c, token);
    if (!candidate || !isLiveRevisionEligible(config, candidate.revisionId))
      throw missing();
    const actor: Actor = {
      id: candidate.accountId,
      tenant: candidate.tenantId,
    };
    const authorized = await authorizeTemplateRevision(c, actor, candidate);
    if (authorized.membershipJoinedAt !== candidate.membershipJoinedAt)
      throw missing();

    const session = await c.query(
      `SELECT 1 FROM sessions
       WHERE hash=$1 AND account_id=$2 AND expires_at>clock_timestamp()
       FOR SHARE`,
      [candidate.sessionHash, candidate.accountId],
    );
    if (!session.rowCount) throw missing();

    const {
      rows: [grant],
    } = await c.query(
      `SELECT viewer_grant.derivative_id,revision.storage_kind,revision.mime,
              revision.manifest_sha256,revision.object_key,revision.object_version
       FROM template_library_viewer_grants viewer_grant
       JOIN revisions revision ON revision.id=viewer_grant.revision_id
       WHERE viewer_grant.hash=$1 AND viewer_grant.expires_at>clock_timestamp()
         AND viewer_grant.session_hash=$8
         AND viewer_grant.library_id=$2 AND viewer_grant.publication_id=$3
         AND viewer_grant.artifact_id=$4 AND viewer_grant.revision_id=$5
         AND viewer_grant.member_account_id=$6 AND viewer_grant.membership_joined_at=$7
         AND revision.mime='text/html'
       FOR SHARE OF viewer_grant,revision`,
      [
        sha256(token),
        candidate.libraryId,
        candidate.publicationId,
        candidate.artifactId,
        candidate.revisionId,
        candidate.accountId,
        candidate.membershipJoinedAt,
        candidate.sessionHash,
      ],
    );
    if (!grant) throw missing();

    let objectKey = grant.object_key;
    let objectVersion = grant.object_version;
    if (grant.storage_kind === "bundle") {
      if (!grant.derivative_id) throw missing();
      const {
        rows: [derivative],
      } = await c.query(
        `SELECT object_key,object_version FROM revision_derivatives
         WHERE id=$1 AND revision_id=$2 AND state='ready'
           AND source_manifest_sha256=$3 AND builder_version=$4
           AND runtime_profile=$5
         FOR SHARE`,
        [
          grant.derivative_id,
          candidate.revisionId,
          grant.manifest_sha256,
          BUNDLE_BUILDER_VERSION,
          BUNDLE_RUNTIME_PROFILE,
        ],
      );
      if (!derivative) throw missing();
      objectKey = derivative.object_key;
      objectVersion = derivative.object_version;
    } else if (grant.storage_kind !== "single" || grant.derivative_id) {
      throw missing();
    }
    // Keep all authorization locks until the pinned object version is read.
    return readBlob(objectKey, objectVersion);
  });
}
