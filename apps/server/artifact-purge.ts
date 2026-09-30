// Delete a work for good (docs/specs/WORK_DELETION.md). The owner empties a
// work from the trash; nothing of it stays readable.
//
// Two steps, because the store cannot join a database transaction:
//   1. One transaction closes the work: its links are revoked, unfinished
//      uploads of it stopped and `purged_at` set. From here on it is in no list
//      and cannot be restored.
//   2. Every object version of it is deleted from the store, then one
//      transaction marks each version deleted, removes its shelf cover and
//      search text, blanks the discussion under its links, and gives the bytes
//      back to the shelf's space. Step 2 is safe to repeat: the sweep in main.ts
//      finishes whatever a crash left.
// The rows stay as tombstones, as when moderation deletes content
// (content-moderation.ts, purgeBlock).
import { artifactLifecycleSchema } from "../../packages/contracts/index.ts";
import { audit, type Actor } from "./artifacts.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { assertMayChange, lockShelf } from "./shelves.ts";
import { deleteAllVersions } from "./storage.ts";

const conflict = () =>
  new Problem(409, "conflict", "Состояние работы изменилось. Обновите корзину и повторите.");

/** Close the work, then delete it. Returns once the objects are gone. */
export async function deleteArtifactForever(actor: Actor, artifactId: string, body: unknown) {
  const input = artifactLifecycleSchema.parse(body);
  await transaction(async (c) => {
    const { role } = await lockShelf(c, actor, "author");
    const {
      rows: [artifact],
    } = await c.query(
      "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [artifactId, actor.tenant],
    );
    if (!artifact || artifact.purged_at) throw missing();
    assertMayChange(role, artifact.created_by, actor.id);
    if (!artifact.trashed_at)
      throw new Problem(409, "conflict", "Сначала переместите работу в корзину.");
    if (
      artifact.latest_revision_id !== input.expectedRevisionId ||
      Number(artifact.lifecycle_version) !== input.expectedLifecycleVersion
    )
      throw conflict();
    // What is evidence or published elsewhere is not the owner's to delete alone.
    const {
      rows: [held],
    } = await c.query(
      `SELECT
         EXISTS(SELECT 1 FROM moderation_blocks WHERE artifact_id=$1) AS blocked,
         EXISTS(SELECT 1 FROM share_reports report JOIN shares share ON share.id=report.share_id
                WHERE share.artifact_id=$1) AS reported,
         EXISTS(SELECT 1 FROM editorial_publications WHERE artifact_id=$1) AS featured,
         EXISTS(SELECT 1 FROM template_releases WHERE artifact_id=$1) AS template`,
      [artifactId],
    );
    if (held.blocked || held.reported)
      throw new Problem(
        409,
        "conflict",
        "На эту работу есть жалоба или решение модерации, поэтому удалить её сейчас нельзя. Напишите оператору Полки.",
        { reason: "evidence" },
      );
    if (held.featured || held.template)
      throw new Problem(
        409,
        "conflict",
        "Работа опубликована в Ленте или в библиотеке шаблонов. Сначала снимите публикацию.",
        { reason: "published" },
      );
    await c.query(
      "UPDATE shares SET revoked=true WHERE artifact_id=$1 AND tenant_id=$2 AND NOT revoked",
      [artifactId, actor.tenant],
    );
    await c.query(
      `UPDATE uploads SET aborted=true
       WHERE tenant_id=$1 AND receipt IS NULL AND NOT aborted AND request->>'artifactId'=$2`,
      [actor.tenant, artifactId],
    );
    await c.query(
      "UPDATE artifacts SET purged_at=clock_timestamp(),lifecycle_version=lifecycle_version+1 WHERE id=$1",
      [artifactId],
    );
    await audit(c, actor, "artifact.purge_started", artifactId);
  });
  await finishArtifactPurge(artifactId);
  return { id: artifactId, purged: true as const };
}

/**
 * Delete the objects of a closed work and mark its versions deleted. Safe to
 * repeat, and safe against a second run at the same time (a session advisory
 * lock, on its own connection because the store work spans no transaction).
 */
export async function finishArtifactPurge(artifactId: string) {
  const holder = await db.connect();
  let clean = false;
  try {
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`artifact-purge:${artifactId}`]);
    const result = await finishLocked(artifactId);
    await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`artifact-purge:${artifactId}`]);
    clean = true;
    return result;
  } finally {
    holder.release(clean ? undefined : true);
  }
}

async function finishLocked(artifactId: string) {
  const { rows: revisions } = await db.query(
    `SELECT revision.id,revision.tenant_id,revision.object_key
     FROM revisions revision JOIN artifacts artifact ON artifact.id=revision.artifact_id
     WHERE artifact.id=$1 AND artifact.purged_at IS NOT NULL AND revision.content_purged_at IS NULL`,
    [artifactId],
  );
  if (!revisions.length) return { versions: 0 };
  const ids = revisions.map((row) => row.id as string);
  const prefixes = new Set<string>();
  for (const row of revisions) if (row.object_key) prefixes.add(row.object_key);
  for (const row of (
    await db.query("SELECT object_key FROM revision_files WHERE revision_id=ANY($1::uuid[])", [ids])
  ).rows)
    prefixes.add(row.object_key);
  for (const row of (
    await db.query("SELECT id,tenant_id FROM revision_derivatives WHERE revision_id=ANY($1::uuid[])", [ids])
  ).rows)
    prefixes.add(`${row.tenant_id}/derivatives/${row.id}/`);
  let versions = 0;
  for (const prefix of prefixes)
    versions += await deleteAllVersions(prefix, (key) =>
      prefix.endsWith("/") ? key.startsWith(prefix) : key === prefix || key.startsWith(`${prefix}/`),
    );
  await transaction(async (c) => {
    const {
      rows: [artifact],
    } = await c.query(
      "SELECT id,tenant_id,created_by FROM artifacts WHERE id=$1 AND purged_at IS NOT NULL FOR UPDATE",
      [artifactId],
    );
    if (!artifact) return;
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [artifact.tenant_id]);
    const { rows: marked } = await c.query(
      `UPDATE revisions SET content_purged_at=clock_timestamp()
       WHERE artifact_id=$1 AND content_purged_at IS NULL RETURNING id,total_size`,
      [artifactId],
    );
    const done = marked.map((row) => row.id as string);
    if (!done.length) return;
    const {
      rows: [built],
    } = await c.query(
      "SELECT COALESCE(sum(size),0)::bigint AS bytes FROM revision_derivatives WHERE revision_id=ANY($1::uuid[]) AND state='ready'",
      [done],
    );
    await c.query("DELETE FROM revision_covers WHERE revision_id=ANY($1::uuid[])", [done]);
    await c.query("DELETE FROM artifact_search WHERE artifact_id=$1", [artifactId]);
    // The discussion under its links goes with it (a deleted comment is empty).
    await c.query(
      `UPDATE comments SET body='',anchor=NULL,deleted_at=COALESCE(deleted_at,clock_timestamp())
       WHERE artifact_id=$1`,
      [artifactId],
    );
    await c.query("UPDATE artifacts SET title='Удалено' WHERE id=$1", [artifactId]);
    const freed = marked.reduce((sum, row) => sum + Number(row.total_size), 0);
    await c.query(
      `UPDATE tenants SET used_bytes=GREATEST(0,used_bytes-$2),
         derivative_used_bytes=GREATEST(0,derivative_used_bytes-$3) WHERE id=$1`,
      [artifact.tenant_id, freed, Number(built.bytes)],
    );
    await audit(c, { id: artifact.created_by, tenant: artifact.tenant_id }, "artifact.purged", artifactId);
  });
  return { versions };
}

/** Finish what a crash between the two steps left (run by the hourly sweep). */
export async function finishPendingArtifactPurges(limit = 20) {
  const { rows } = await db.query(
    `SELECT artifact.id FROM artifacts artifact
     WHERE artifact.purged_at IS NOT NULL
       AND EXISTS(SELECT 1 FROM revisions WHERE artifact_id=artifact.id AND content_purged_at IS NULL)
     ORDER BY artifact.purged_at LIMIT $1`,
    [limit],
  );
  for (const row of rows) await finishArtifactPurge(row.id);
  return rows.length;
}
