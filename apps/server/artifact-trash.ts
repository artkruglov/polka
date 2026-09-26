import { assertArtifactInAgentScope } from "./agent-scope.ts";
import type { PoolClient } from "pg";
import {
  artifactLifecycleSchema,
  type ArtifactLifecycleInput,
  type ArtifactLifecycleSnapshot,
} from "../../packages/contracts/index.ts";
import { audit, type Actor } from "./artifacts.ts";
import { transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { assertMayChange, lockShelf } from "./shelves.ts";

type DesiredLifecycle = "active" | "trashed";

const snapshot = (artifact: any): ArtifactLifecycleSnapshot => ({
  id: artifact.id,
  trashedAt: artifact.trashed_at
    ? new Date(artifact.trashed_at).toISOString()
    : null,
  lifecycleVersion: Number(artifact.lifecycle_version),
});

const conflict = () =>
  new Problem(
    409,
    "conflict",
    "Состояние работы изменилось. Обновите данные и повторите действие.",
  );

/**
 * Shared owner/service-actor business operation. Callers pass their current
 * transaction and actor; no cookie or HTTP policy is embedded here.
 *
 * Lock order is tenant -> pending uploads by id -> artifact -> shares by id ->
 * pending derivatives by id. Service-actor callers already holding the tenant
 * and connection locks may safely enter this function without nesting a
 * transaction.
 */
export async function transitionArtifactLifecycleInTransaction(
  c: PoolClient,
  actor: Actor,
  artifactId: string,
  input: ArtifactLifecycleInput,
  desired: DesiredLifecycle,
): Promise<ArtifactLifecycleSnapshot> {
  const { role } = await lockShelf(c, actor, "author");
  await c.query(
    `SELECT id FROM uploads
     WHERE tenant_id=$1 AND receipt IS NULL
       AND request->>'artifactId'=$2
     ORDER BY id FOR UPDATE`,
    [actor.tenant, artifactId],
  );
  const {
    rows: [artifact],
  } = await c.query(
    "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [artifactId, actor.tenant],
  );
  if (!artifact) throw missing();
  await assertArtifactInAgentScope(c, actor, artifactId);
  assertMayChange(role, artifact.created_by, actor.id);
  if (artifact.latest_revision_id !== input.expectedRevisionId)
    throw conflict();

  const currentVersion = Number(artifact.lifecycle_version);
  const isDesired =
    desired === "trashed"
      ? artifact.trashed_at !== null
      : artifact.trashed_at === null;
  if (currentVersion === input.expectedLifecycleVersion + 1 && isDesired)
    return snapshot(artifact);
  if (currentVersion !== input.expectedLifecycleVersion || isDesired)
    throw conflict();

  if (desired === "active") {
    const {
      rows: [restored],
    } = await c.query(
      `UPDATE artifacts
       SET trashed_at=NULL,lifecycle_version=lifecycle_version+1,
           updated_at=clock_timestamp()
       WHERE id=$1 RETURNING *`,
      [artifactId],
    );
    await audit(c, actor, "artifact.restored", artifactId);
    return snapshot(restored);
  }

  await c.query(
    "SELECT id FROM shares WHERE artifact_id=$1 ORDER BY id FOR UPDATE",
    [artifactId],
  );
  await c.query(
    `SELECT derivative.id
     FROM revision_derivatives derivative
     JOIN revisions revision ON revision.id=derivative.revision_id
     WHERE revision.artifact_id=$1 AND derivative.state='pending'
     ORDER BY derivative.id FOR UPDATE OF derivative`,
    [artifactId],
  );
  const {
    rows: [trashed],
  } = await c.query(
    `UPDATE artifacts
     SET trashed_at=clock_timestamp(),lifecycle_version=lifecycle_version+1,
         updated_at=clock_timestamp()
     WHERE id=$1 RETURNING *`,
    [artifactId],
  );
  await c.query(
    `DELETE FROM viewer_grants viewer_grant
     USING revisions revision
     WHERE viewer_grant.revision_id=revision.id AND revision.artifact_id=$1
       AND revision.tenant_id=$2`,
    [artifactId, actor.tenant],
  );
  await c.query(
    `DELETE FROM grants issued_grant
     USING shares share
     WHERE issued_grant.share_id=share.id AND share.artifact_id=$1
       AND share.tenant_id=$2`,
    [artifactId, actor.tenant],
  );
  await c.query(
    "UPDATE shares SET revoked=true WHERE artifact_id=$1 AND tenant_id=$2",
    [artifactId, actor.tenant],
  );
  await c.query(
    `UPDATE uploads SET aborted=true
     WHERE tenant_id=$1 AND receipt IS NULL
       AND request->>'artifactId'=$2`,
    [actor.tenant, artifactId],
  );
  await c.query(
    `UPDATE revision_derivatives derivative
     SET attempt_expires_at=LEAST(derivative.attempt_expires_at,clock_timestamp()),
         updated_at=clock_timestamp()
     FROM revisions revision
     WHERE derivative.revision_id=revision.id AND revision.artifact_id=$1
       AND revision.tenant_id=$2 AND derivative.state='pending'`,
    [artifactId, actor.tenant],
  );
  await audit(c, actor, "artifact.trashed", artifactId);
  return snapshot(trashed);
}

export async function transitionOwnerArtifactLifecycle(
  actor: Actor,
  artifactId: string,
  body: unknown,
  desired: DesiredLifecycle,
) {
  const input = artifactLifecycleSchema.parse(body);
  return transaction((c) =>
    transitionArtifactLifecycleInTransaction(
      c,
      actor,
      artifactId,
      input,
      desired,
    ),
  );
}
