import type { PoolClient } from "pg";
import { updateArtifactMetadataSchema } from "../../packages/contracts/index.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { audit, getArtifact, type Actor } from "./artifacts.ts";
import { assertMayChange, lockShelf } from "./shelves.ts";

export async function updateArtifactMetadata(
  actor: Actor,
  artifactId: string,
  body: unknown,
) {
  const input = updateArtifactMetadataSchema.parse(body);
  await transaction((c) =>
    updateArtifactMetadataInTransaction(c, actor, artifactId, input),
  );
  return getArtifact(actor, artifactId);
}

export async function updateArtifactMetadataInTransaction(
  c: PoolClient,
  actor: Actor,
  artifactId: string,
  input: ReturnType<typeof updateArtifactMetadataSchema.parse>,
) {
  const { role } = await lockShelf(c, actor, "author");

  const {
    rows: [artifact],
  } = await c.query(
    "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR UPDATE",
    [artifactId, actor.tenant],
  );
  if (!artifact) throw missing();
  assertMayChange(role, artifact.created_by, actor.id);
  if (
    artifact.title !== input.expectedTitle ||
    artifact.folder_id !== input.expectedFolderId
  )
    throw new Problem(
      409,
      "conflict",
      "Работа уже изменилась. Обновите данные и повторите действие.",
    );

  if (input.folderId) {
    const target = await c.query(
      "SELECT 1 FROM folders WHERE id=$1 AND tenant_id=$2",
      [input.folderId, actor.tenant],
    );
    if (!target.rowCount) throw missing();
  }

  const title = input.title ?? artifact.title;
  const folderId =
    input.folderId !== undefined ? input.folderId : artifact.folder_id;
  await c.query(
    "UPDATE artifacts SET title=$2,folder_id=$3,updated_at=clock_timestamp() WHERE id=$1",
    [artifactId, title, folderId],
  );
  await audit(c, actor, "artifact.metadata_updated", artifactId);
  return { id: artifactId, title, folderId };
}
