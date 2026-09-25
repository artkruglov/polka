import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import {
  createFolderFromAgent,
  deleteFolderFromAgent,
  moveFromAgent,
  renameFolderFromAgent,
} from "../apps/server/agent-folders.ts";
import {
  listArtifactsForAgent,
  listFoldersForAgent,
} from "../apps/server/agent-management.ts";
import { MAX_FOLDERS } from "../apps/server/folders.ts";
import {
  MCP_AUDIENCE,
  type ServiceActor,
} from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { LINK_MIME } from "../packages/contracts/index.ts";

/*
 * Folder tools for agents (agent-folders.ts over folders.ts): create, rename,
 * delete an empty folder, move a batch of works; keyed replays, tenant
 * isolation, the batch limit, all-or-nothing moves and the audit trail.
 */

const password = randomBytes(24).toString("hex");
type Account = Awaited<ReturnType<typeof createAccount>>;
let owner: Account;
let other: Account;

async function connection(account: Account, scopes: string[]) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'folders test',$5,$6,now()+interval '1 day')`,
    [
      id,
      account.tenant,
      account.id,
      sha256(randomBytes(32)),
      scopes,
      MCP_AUDIENCE,
    ],
  );
  return {
    accountId: account.id,
    tenantId: account.tenant,
    connectionId: id,
    scopes,
    audience: MCP_AUDIENCE,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  } as ServiceActor;
}

async function artifact(
  account: Account,
  title: string,
  options: {
    folderId?: string | null;
    trashed?: boolean;
    mime?: string;
    filename?: string;
    updatedAt?: string;
  } = {},
) {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  await db.query(
    `INSERT INTO artifacts(id,tenant_id,created_by,folder_id,title,updated_at,trashed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      artifactId,
      account.tenant,
      account.id,
      options.folderId ?? null,
      title,
      options.updatedAt ?? new Date().toISOString(),
      options.trashed ? new Date().toISOString() : null,
    ],
  );
  const mime = options.mime ?? "text/plain";
  await db.query(
    `INSERT INTO revisions(
       id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
       object_key,object_version,storage_kind,total_size,html_profile
     ) VALUES($1,$2,$3,1,$4,$5,$6,4,$7,$8,'version','single',4,$9)`,
    [
      revisionId,
      account.tenant,
      artifactId,
      account.id,
      options.filename ?? "note.txt",
      mime,
      sha256("note"),
      `${account.tenant}/agent-folders/${revisionId}`,
      mime === "text/html" ? "static" : null,
    ],
  );
  await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [
    artifactId,
    revisionId,
  ]);
  return artifactId;
}

async function folderOf(artifactId: string) {
  return (
    await db.query("SELECT folder_id FROM artifacts WHERE id=$1", [artifactId])
  ).rows[0].folder_id as string | null;
}

async function auditCount(
  action: string,
  target: string,
  connectionId: string,
) {
  return Number(
    (
      await db.query(
        `SELECT count(*) FROM audit_outbox
         WHERE action=$1 AND target_id=$2 AND actor_type='agent' AND connection_id=$3`,
        [action, target, connectionId],
      )
    ).rows[0].count,
  );
}

const rejected =
  (status: number, code: string, check?: (error: any) => boolean) =>
  (error: any) =>
    error?.status === status &&
    error?.code === code &&
    (!check || check(error));

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`folders-a-${suffix}`, password);
  other = await createAccount(`folders-b-${suffix}`, password);
});

after(async () => {
  await db.end();
  s3.destroy();
});

test("create and rename: unique names, keyed replays, audit, other shelves untouched", async () => {
  const actor = await connection(owner, ["manage"]);
  const sibling = await connection(owner, ["manage"]);
  const createInput = { key: randomUUID(), name: "  Y360 Radar  " };
  const created = await createFolderFromAgent(actor, createInput);
  assert.equal(created.replayed, false);
  assert.equal(created.operation, "folder-create");
  assert.equal(created.applied.name, "Y360 Radar");
  const folderId = created.applied.id;
  assert.equal(
    await auditCount("folder.created", folderId, actor.connectionId),
    1,
  );

  // The same key and request: the stored result, nothing new.
  const replayed = await createFolderFromAgent(actor, createInput);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.applied, created.applied);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM folders WHERE tenant_id=$1 AND name='Y360 Radar'",
          [owner.tenant],
        )
      ).rows[0].count,
    ),
    1,
  );
  // The same key for another request, or from another connection: conflict.
  await assert.rejects(
    createFolderFromAgent(actor, { ...createInput, name: "Другое" }),
    rejected(409, "conflict"),
  );
  await assert.rejects(
    createFolderFromAgent(sibling, createInput),
    rejected(409, "conflict"),
  );
  // A taken name names the folder that has it.
  await assert.rejects(
    createFolderFromAgent(actor, { key: randomUUID(), name: "Y360 Radar" }),
    rejected(
      409,
      "conflict",
      (error) =>
        error.details.reason === "name_taken" &&
        error.details.folderId === folderId,
    ),
  );
  // Another shelf may use the same name.
  const foreign = await createFolderFromAgent(
    await connection(other, ["manage"]),
    {
      key: randomUUID(),
      name: "Y360 Radar",
    },
  );
  assert.notEqual(foreign.applied.id, folderId);

  const lessons = await createFolderFromAgent(actor, {
    key: randomUUID(),
    name: "Учёба",
  });
  const renameInput = { key: randomUUID(), folderId, name: "Отчёты Y360" };
  const renamed = await renameFolderFromAgent(actor, renameInput);
  assert.deepEqual(renamed.applied, {
    id: folderId,
    name: "Отчёты Y360",
    previousName: "Y360 Radar",
  });
  assert.equal(
    await auditCount("folder.renamed", folderId, actor.connectionId),
    1,
  );
  assert.equal(
    (await renameFolderFromAgent(actor, renameInput)).replayed,
    true,
  );
  await assert.rejects(
    renameFolderFromAgent(actor, {
      key: randomUUID(),
      folderId,
      name: "Учёба",
    }),
    rejected(
      409,
      "conflict",
      (error) => error.details.folderId === lessons.applied.id,
    ),
  );
  // Another shelf's folder is not there at all.
  await assert.rejects(
    renameFolderFromAgent(actor, {
      key: randomUUID(),
      folderId: foreign.applied.id,
      name: "Чужая",
    }),
    rejected(404, "not_found"),
  );
  assert.equal(
    (
      await db.query("SELECT name FROM folders WHERE id=$1", [
        foreign.applied.id,
      ])
    ).rows[0].name,
    "Y360 Radar",
  );
  // Names are 1-80 characters after trimming.
  await assert.rejects(
    createFolderFromAgent(actor, { key: randomUUID(), name: "   " }),
  );
  await assert.rejects(
    createFolderFromAgent(actor, { key: randomUUID(), name: "я".repeat(81) }),
  );
});

test("a shelf holds at most MAX_FOLDERS folders", async () => {
  const account = await createAccount(
    `folders-cap-${randomBytes(5).toString("hex")}`,
    password,
  );
  const actor = await connection(account, ["manage"]);
  await db.query(
    `INSERT INTO folders(id,tenant_id,name)
     SELECT gen_random_uuid(),$1,'Папка '||n FROM generate_series(1,$2::int) n`,
    [account.tenant, MAX_FOLDERS],
  );
  await assert.rejects(
    createFolderFromAgent(actor, { key: randomUUID(), name: "Лишняя" }),
    rejected(413, "quota"),
  );
});

test("delete: only an empty folder; trashed works lose it; audit", async () => {
  const actor = await connection(owner, ["manage"]);
  const { applied: folder } = await createFolderFromAgent(actor, {
    key: randomUUID(),
    name: `Удаляемая ${randomUUID().slice(0, 8)}`,
  });
  const onShelf = await artifact(owner, "Живая работа", {
    folderId: folder.id,
  });
  const inTrash = await artifact(owner, "Работа в корзине", {
    folderId: folder.id,
    trashed: true,
  });
  await assert.rejects(
    deleteFolderFromAgent(actor, { key: randomUUID(), folderId: folder.id }),
    rejected(
      409,
      "conflict",
      (error) =>
        error.details.reason === "folder_not_empty" &&
        error.details.works === 1,
    ),
  );
  assert.equal(await folderOf(onShelf), folder.id);

  await moveFromAgent(actor, {
    key: randomUUID(),
    artifactIds: [onShelf],
    folderId: null,
  });
  const deleteInput = { key: randomUUID(), folderId: folder.id };
  const deleted = await deleteFolderFromAgent(actor, deleteInput);
  assert.deepEqual(deleted.applied, {
    id: folder.id,
    name: folder.name,
    trashedWorksDetached: 1,
  });
  assert.equal(await folderOf(inTrash), null);
  assert.equal(
    (await db.query("SELECT 1 FROM folders WHERE id=$1", [folder.id])).rowCount,
    0,
  );
  assert.equal(
    await auditCount("folder.deleted", folder.id, actor.connectionId),
    1,
  );
  // A retry after the folder is gone returns what was done.
  const replay = await deleteFolderFromAgent(actor, deleteInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.applied, deleted.applied);
  // A fresh key for a folder that is gone, or another shelf's: not found.
  await assert.rejects(
    deleteFolderFromAgent(actor, { key: randomUUID(), folderId: folder.id }),
    rejected(404, "not_found"),
  );
  const { applied: foreign } = await createFolderFromAgent(
    await connection(other, ["manage"]),
    { key: randomUUID(), name: `Чужая ${randomUUID().slice(0, 8)}` },
  );
  await assert.rejects(
    deleteFolderFromAgent(actor, { key: randomUUID(), folderId: foreign.id }),
    rejected(404, "not_found"),
  );
  assert.equal(
    (await db.query("SELECT 1 FROM folders WHERE id=$1", [foreign.id]))
      .rowCount,
    1,
  );
});

test("move: a batch at once, all or nothing, order kept, replayed by key", async () => {
  const actor = await connection(owner, ["manage"]);
  const { applied: radar } = await createFolderFromAgent(actor, {
    key: randomUUID(),
    name: `Радар ${randomUUID().slice(0, 8)}`,
  });
  const updatedAt = "2026-09-01T10:00:00.000Z";
  const works = [];
  for (const week of ["W36", "W37", "W38"])
    works.push(await artifact(owner, `Y360 Radar · ${week}`, { updatedAt }));
  const already = await artifact(owner, "Уже в папке", {
    folderId: radar.id,
    updatedAt,
  });
  const moveInput = {
    key: randomUUID(),
    artifactIds: [...works, already],
    folderId: radar.id,
  };
  const moved = await moveFromAgent(actor, moveInput);
  assert.equal(moved.replayed, false);
  assert.deepEqual(moved.applied, {
    folderId: radar.id,
    folderName: radar.name,
    moved: works,
    unchanged: [already],
  });
  for (const id of [...works, already]) {
    assert.equal(await folderOf(id), radar.id);
    // Tidying up does not reorder the shelf.
    const { rows } = await db.query(
      "SELECT updated_at FROM artifacts WHERE id=$1",
      [id],
    );
    assert.equal(new Date(rows[0].updated_at).toISOString(), updatedAt);
  }
  for (const id of works)
    assert.equal(await auditCount("artifact.moved", id, actor.connectionId), 1);
  assert.equal(
    await auditCount("artifact.moved", already, actor.connectionId),
    0,
  );

  const replay = await moveFromAgent(actor, moveInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.applied, moved.applied);
  await assert.rejects(
    moveFromAgent(actor, { ...moveInput, folderId: null }),
    rejected(409, "conflict"),
  );

  // One foreign, trashed or unknown id refuses the whole batch and is named.
  const foreign = await artifact(other, "Чужая работа");
  const trashed = await artifact(owner, "В корзине", { trashed: true });
  const unknown = randomUUID();
  const loose = await artifact(owner, "Без папки");
  for (const bad of [foreign, trashed, unknown])
    await assert.rejects(
      moveFromAgent(actor, {
        key: randomUUID(),
        artifactIds: [loose, bad],
        folderId: radar.id,
      }),
      rejected(404, "not_found", (error) => {
        assert.deepEqual(error.details.missing, [bad]);
        return true;
      }),
    );
  assert.equal(await folderOf(loose), null);
  assert.equal(await folderOf(foreign), null);
  // Into another shelf's folder: not found, nothing moved.
  const { applied: foreignFolder } = await createFolderFromAgent(
    await connection(other, ["manage"]),
    { key: randomUUID(), name: `Чужая папка ${randomUUID().slice(0, 8)}` },
  );
  await assert.rejects(
    moveFromAgent(actor, {
      key: randomUUID(),
      artifactIds: [loose],
      folderId: foreignFolder.id,
    }),
    rejected(404, "not_found"),
  );
  assert.equal(await folderOf(loose), null);

  // folderId null takes works out of any folder.
  const out = await moveFromAgent(actor, {
    key: randomUUID(),
    artifactIds: [already],
    folderId: null,
  });
  assert.deepEqual(out.applied, {
    folderId: null,
    folderName: null,
    moved: [already],
    unchanged: [],
  });
});

test("move: 1-100 distinct works per call", async () => {
  const actor = await connection(owner, ["manage"]);
  const ids = Array.from({ length: 101 }, () => randomUUID());
  await assert.rejects(
    moveFromAgent(actor, {
      key: randomUUID(),
      artifactIds: ids,
      folderId: null,
    }),
    (error: any) => error?.name === "ZodError",
  );
  await assert.rejects(
    moveFromAgent(actor, {
      key: randomUUID(),
      artifactIds: [],
      folderId: null,
    }),
    (error: any) => error?.name === "ZodError",
  );
  const one = await artifact(owner, "Дубль");
  await assert.rejects(
    moveFromAgent(actor, {
      key: randomUUID(),
      artifactIds: [one, one],
      folderId: null,
    }),
    (error: any) => error?.name === "ZodError",
  );
  // A hundred at once is fine.
  const { applied: folder } = await createFolderFromAgent(actor, {
    key: randomUUID(),
    name: `Сотня ${randomUUID().slice(0, 8)}`,
  });
  const hundred = [];
  for (let i = 0; i < 100; i++)
    hundred.push(await artifact(owner, `Работа ${i}`));
  const moved = await moveFromAgent(actor, {
    key: randomUUID(),
    artifactIds: hundred,
    folderId: folder.id,
  });
  assert.equal(moved.applied.moved.length, 100);
  const listed = await listFoldersForAgent(await connection(owner, ["read"]), {
    limit: 100,
  });
  assert.equal(listed.items.find((item) => item.id === folder.id)?.works, 100);
});

test("the folder tools need manage, and a revoked connection stops", async () => {
  const readOnly = await connection(owner, ["read", "capture"]);
  for (const call of [
    () =>
      createFolderFromAgent(readOnly, { key: randomUUID(), name: "Нельзя" }),
    () =>
      moveFromAgent(readOnly, {
        key: randomUUID(),
        artifactIds: [randomUUID()],
        folderId: null,
      }),
  ])
    await assert.rejects(
      call(),
      (error: any) => error?.status === 403 || error?.status === 401,
    );
  const actor = await connection(owner, ["manage"]);
  await db.query("UPDATE agent_connections SET revoked_at=now() WHERE id=$1", [
    actor.connectionId,
  ]);
  await assert.rejects(
    createFolderFromAgent(actor, { key: randomUUID(), name: "После отзыва" }),
    (error: any) =>
      error?.status === 401 || error?.name === "UnauthorizedError",
  );
});

test("polka_list gives what organizing needs: kind, folder name, created date", async () => {
  const actor = await connection(owner, ["read", "manage"]);
  const { applied: folder } = await createFolderFromAgent(actor, {
    key: randomUUID(),
    name: `Лендинги ${randomUUID().slice(0, 8)}`,
  });
  const tag = randomUUID().slice(0, 8);
  const page = await artifact(owner, `Страница ${tag}`, {
    mime: "text/html",
    filename: "index.html",
    folderId: folder.id,
  });
  const link = await artifact(owner, `Ссылка ${tag}`, {
    mime: LINK_MIME,
    filename: "claude.ai.link.json",
  });
  const listed = await listArtifactsForAgent(actor, { query: tag, limit: 100 });
  const byId = new Map(listed.items.map((item) => [item.id, item]));
  const pageItem = byId.get(page)!;
  assert.equal(pageItem.kind, "page");
  assert.equal(pageItem.folderId, folder.id);
  assert.equal(pageItem.folderName, folder.name);
  assert.ok(Date.parse(pageItem.createdAt));
  const linkItem = byId.get(link)!;
  assert.equal(linkItem.kind, "link");
  assert.equal(linkItem.linkHost, "claude.ai");
  assert.equal(linkItem.folderName, null);
  // Only works without a folder.
  const loose = await listArtifactsForAgent(actor, {
    query: tag,
    folderId: null,
  });
  assert.deepEqual(
    loose.items.map((item) => item.id),
    [link],
  );
});
