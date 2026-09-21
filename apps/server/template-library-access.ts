import type { PoolClient } from "pg";
import type { Actor } from "./artifacts.ts";
import { missing } from "./errors.ts";

export interface TemplateLibraryRevisionRequest {
  libraryId: string;
  publicationId: string;
  artifactId: string;
  revisionId: string;
}

export interface AuthorizedTemplateLibraryRevision {
  libraryId: string;
  publicationId: string;
  releaseId: string;
  artifactId: string;
  revisionId: string;
  sourceTenantId: string;
  /** PostgreSQL timestamp text preserves the membership epoch's microseconds. */
  membershipJoinedAt: string;
  role: "reader" | "curator" | "admin";
}

/**
 * Authorize one exact, active library publication in a fresh transaction.
 * Do not call this after lockActiveOwnerTenant or any other row lock. Callers
 * must keep the transaction open until the authorized bytes have been read.
 * Revocation and archive operations must acquire locks in this same order:
 * all tenants ordered by id, all accounts ordered by id, library, membership,
 * publication/artifact/revision. The release tuple is protected by the locked
 * source rows and needs no UPDATE privilege. Normal reads use FOR SHARE.
 * Derivative mutations choose sourceMutation before locking: the complete,
 * sorted tenant set and the exact artifact/revision are then locked FOR UPDATE,
 * so a later SHARE-to-UPDATE upgrade cannot deadlock reciprocal A/B builds.
 * These locks make authorization the linearization point: a concurrent revoke
 * either wins first, or waits until this transaction ends.
 */
export async function authorizeTemplateRevision(
  c: Pick<PoolClient, "query">,
  actor: Actor,
  request: TemplateLibraryRevisionRequest,
  options: { sourceMutation?: boolean } = {},
): Promise<AuthorizedTemplateLibraryRevision> {
  // This lookup does not grant access. It only discovers the complete account
  // and tenant lock set; every returned identity is revalidated after locking.
  const source = (
    await c.query(
      `SELECT source_tenant.id AS "sourceTenantId",
              source_tenant.owner_id AS "sourceOwnerId"
         FROM template_library_publications publication
         JOIN artifacts artifact ON artifact.id=publication.artifact_id
         JOIN tenants source_tenant ON source_tenant.id=artifact.tenant_id
        WHERE publication.id=$1
          AND publication.library_id=$2
          AND publication.artifact_id=$3
          AND publication.revision_id=$4`,
      [
        request.publicationId,
        request.libraryId,
        request.artifactId,
        request.revisionId,
      ],
    )
  ).rows[0];
  if (!source) throw missing();

  const tenantLock = options.sourceMutation ? "UPDATE" : "SHARE";
  const tenants = await c.query(
    `SELECT id,owner_id AS "ownerId" FROM tenants
      WHERE id=ANY($1::uuid[])
      ORDER BY id FOR ${tenantLock}`,
    [[actor.tenant, source.sourceTenantId]],
  );
  const actorTenant = tenants.rows.find((row) => row.id === actor.tenant);
  const sourceTenant = tenants.rows.find(
    (row) => row.id === source.sourceTenantId,
  );
  if (
    actorTenant?.ownerId !== actor.id ||
    sourceTenant?.ownerId !== source.sourceOwnerId
  )
    throw missing();

  const accounts = await c.query(
    `SELECT id FROM accounts
      WHERE id=ANY($1::uuid[])
        AND NOT disabled AND deletion_requested_at IS NULL
      ORDER BY id FOR SHARE`,
    [[actor.id, source.sourceOwnerId]],
  );
  if (accounts.rowCount !== new Set([actor.id, source.sourceOwnerId]).size)
    throw missing();

  const library = (
    await c.query(
      `SELECT id FROM template_libraries
        WHERE id=$1 AND state='active' AND archived_at IS NULL
        FOR SHARE`,
      [request.libraryId],
    )
  ).rows[0];
  if (!library) throw missing();

  const member = (
    await c.query(
      `SELECT role,joined_at::text AS "membershipJoinedAt" FROM template_library_members
        WHERE library_id=$1 AND account_id=$2
          AND state='active' AND revoked_at IS NULL
        FOR SHARE`,
      [request.libraryId, actor.id],
    )
  ).rows[0];
  if (!member) throw missing();

  const sourceLocks = options.sourceMutation
    ? "FOR SHARE OF publication FOR UPDATE OF artifact,revision"
    : "FOR SHARE OF publication,artifact,revision";
  const publication = (
    await c.query(
      `SELECT publication.id AS "publicationId",
              publication.library_id AS "libraryId",
              publication.release_id AS "releaseId",
              publication.artifact_id AS "artifactId",
              publication.revision_id AS "revisionId",
              artifact.tenant_id AS "sourceTenantId"
         FROM template_library_publications publication
         JOIN template_releases release
           ON release.id=publication.release_id
          AND release.artifact_id=publication.artifact_id
          AND release.revision_id=publication.revision_id
         JOIN artifacts artifact ON artifact.id=publication.artifact_id
         JOIN revisions revision
           ON revision.id=publication.revision_id
          AND revision.artifact_id=artifact.id
          AND revision.tenant_id=artifact.tenant_id
        WHERE publication.id=$1
          AND publication.library_id=$2
          AND publication.artifact_id=$3
          AND publication.revision_id=$4
          AND publication.state='active'
          AND publication.withdrawn_at IS NULL
          AND artifact.trashed_at IS NULL
          AND artifact.tenant_id=$5
        ${sourceLocks}`,
      [
        request.publicationId,
        request.libraryId,
        request.artifactId,
        request.revisionId,
        source.sourceTenantId,
      ],
    )
  ).rows[0];
  if (!publication) throw missing();

  return {
    ...publication,
    membershipJoinedAt: member.membershipJoinedAt,
    role: member.role,
  };
}
