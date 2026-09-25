import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { Problem, missing } from "./errors.ts";
import { audit, type Actor } from "./artifacts.ts";
import { lockShelf } from "./shelves.ts";

/**
 * Folders of a shelf: the rules the web («ПАПКИ», +) and the agent tools
 * (polka_create_folder, polka_rename_folder, polka_delete_folder, polka_move)
 * share. A name is 1-80 characters and unique on the shelf; a shelf has at
 * most MAX_FOLDERS folders. Every call runs inside the caller's transaction,
 * after the owner's tenant is locked, so two requests never race on a name.
 */
export const MAX_FOLDERS = 100;
/** How many works one polka_move takes. */
export const MAX_MOVE_BATCH = 100;
export const folderNameSchema = z.string().trim().min(1).max(80);

const nameTaken = (name: string, folderId: string) =>
  new Problem(409, "conflict", `Папка «${name}» уже есть на полке.`, {
    reason: "name_taken",
    folderId,
  });

async function folderNamed(c: PoolClient, tenant: string, name: string) {
  const {
    rows: [row],
  } = await c.query("SELECT id FROM folders WHERE tenant_id=$1 AND name=$2", [
    tenant,
    name,
  ]);
  return row?.id as string | undefined;
}

export async function createFolderInTransaction(
  c: PoolClient,
  actor: Actor,
  rawName: string,
) {
  const name = folderNameSchema.parse(rawName);
  await lockShelf(c, actor, "curator");
  const {
    rows: [{ count }],
  } = await c.query("SELECT count(*) FROM folders WHERE tenant_id=$1", [
    actor.tenant,
  ]);
  if (Number(count) >= MAX_FOLDERS)
    throw new Problem(
      413,
      "quota",
      `В этой сборке доступно до ${MAX_FOLDERS} папок.`,
    );
  const existing = await folderNamed(c, actor.tenant, name);
  if (existing) throw nameTaken(name, existing);
  const folder = { id: randomUUID(), name };
  await c.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [
    folder.id,
    actor.tenant,
    folder.name,
  ]);
  await audit(c, actor, "folder.created", folder.id);
  return folder;
}

async function lockFolder(c: PoolClient, tenant: string, folderId: string) {
  const {
    rows: [folder],
  } = await c.query(
    "SELECT id,name FROM folders WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [folderId, tenant],
  );
  if (!folder) throw missing();
  return folder as { id: string; name: string };
}

export async function renameFolderInTransaction(
  c: PoolClient,
  actor: Actor,
  folderId: string,
  rawName: string,
) {
  const name = folderNameSchema.parse(rawName);
  await lockShelf(c, actor, "curator");
  const folder = await lockFolder(c, actor.tenant, folderId);
  if (folder.name === name) return { id: folder.id, name, previousName: name };
  const existing = await folderNamed(c, actor.tenant, name);
  if (existing) throw nameTaken(name, existing);
  await c.query("UPDATE folders SET name=$2 WHERE id=$1", [folder.id, name]);
  await audit(c, actor, "folder.renamed", folder.id);
  return { id: folder.id, name, previousName: folder.name };
}

/**
 * Removes a folder that holds no works on the shelf. Works in the trash that
 * were in it lose the folder (restored, they come back «без папки»); works on
 * the shelf are never moved implicitly: the refusal counts them.
 */
export async function deleteFolderInTransaction(
  c: PoolClient,
  actor: Actor,
  folderId: string,
) {
  await lockShelf(c, actor, "curator");
  const folder = await lockFolder(c, actor.tenant, folderId);
  const {
    rows: [counts],
  } = await c.query(
    `SELECT count(*) FILTER (WHERE trashed_at IS NULL) AS active,
            count(*) FILTER (WHERE trashed_at IS NOT NULL) AS trashed
     FROM artifacts WHERE tenant_id=$1 AND folder_id=$2`,
    [actor.tenant, folder.id],
  );
  const active = Number(counts.active);
  if (active > 0)
    throw new Problem(
      409,
      "conflict",
      `В папке «${folder.name}» ещё есть работы (${active}). Сначала перенесите их в другую папку или «без папки».`,
      { reason: "folder_not_empty", folderId: folder.id, works: active },
    );
  const detached = await c.query(
    `UPDATE artifacts SET folder_id=NULL
     WHERE tenant_id=$1 AND folder_id=$2 AND trashed_at IS NOT NULL`,
    [actor.tenant, folder.id],
  );
  await c.query("DELETE FROM folders WHERE id=$1 AND tenant_id=$2", [
    folder.id,
    actor.tenant,
  ]);
  await audit(c, actor, "folder.deleted", folder.id);
  return {
    id: folder.id,
    name: folder.name,
    trashedWorksDetached: detached.rowCount ?? 0,
  };
}

/**
 * Moves works on the shelf into one folder (or out of any, folderId null),
 * all or none: an id that is not a work on this shelf (another shelf's, one
 * in the trash, or unknown) refuses the whole batch and names it. The works
 * keep their place in the shelf's order (updated_at is not touched), so
 * tidying up does not make every moved work look freshly changed.
 */
export async function moveArtifactsInTransaction(
  c: PoolClient,
  actor: Actor,
  artifactIds: string[],
  folderId: string | null,
) {
  const ids = [...new Set(artifactIds.map((id) => id.toLowerCase()))];
  if (!ids.length || ids.length > MAX_MOVE_BATCH)
    throw new Problem(
      400,
      "invalid",
      `За один раз можно перенести от 1 до ${MAX_MOVE_BATCH} работ.`,
    );
  await lockShelf(c, actor, "curator");
  const folder = folderId ? await lockFolder(c, actor.tenant, folderId) : null;
  const { rows } = await c.query(
    `SELECT id,folder_id FROM artifacts
     WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL
     ORDER BY id FOR UPDATE`,
    [actor.tenant, ids],
  );
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((row) => row.id));
    throw new Problem(
      404,
      "not_found",
      "Некоторых работ нет на полке (или они в корзине). Ничего не перенесено.",
      { reason: "works_missing", missing: ids.filter((id) => !found.has(id)) },
    );
  }
  const target = folder?.id ?? null;
  const moved = rows
    .filter((row) => row.folder_id !== target)
    .map((row) => row.id as string);
  if (moved.length) {
    await c.query(
      "UPDATE artifacts SET folder_id=$3 WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
      [actor.tenant, moved, target],
    );
    for (const id of moved) await audit(c, actor, "artifact.moved", id);
  }
  const movedSet = new Set(moved);
  return {
    folderId: target,
    folderName: folder?.name ?? null,
    moved: ids.filter((id) => movedSet.has(id)),
    unchanged: ids.filter((id) => !movedSet.has(id)),
  };
}
