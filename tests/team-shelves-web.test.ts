// Department shelves, stage 2 (docs/specs/TEAM_SHELVES.md): members and roles
// managed by the shelf's admin, and the shelf's own routes — saving, the
// list, search, folders, trash — on a department shelf with roles checked.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
type Account = Awaited<ReturnType<typeof createAccount>>;
let admin: Account, author: Account, other: Account, reader: Account, stranger: Account;
let shelf: { id: string; name: string };
const sessions = new Map<string, string>();

const call = (method: any, url: string, account: Account, body?: unknown, onShelf?: string) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      cookie: `polka_session=${sessions.get(account.name)}`,
      ...(onShelf ? { "x-polka-shelf": onShelf } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body as any,
  });

async function save(account: Account, title: string, text: string, onShelf?: string) {
  const body = Buffer.from(text);
  const start = await call(
    "POST",
    "/api/uploads",
    account,
    { key: randomUUID(), title, filename: "note.txt", mime: "text/plain", size: body.length, sha256: sha256(body) },
    onShelf,
  );
  if (start.statusCode !== 200) return start;
  const uploadId = start.json().uploadId;
  const put = await call("PUT", `/api/uploads/${uploadId}/bytes`, account, body, onShelf);
  assert.equal(put.statusCode, 200, put.body);
  return call("POST", `/api/uploads/${uploadId}/finalize`, account, {}, onShelf);
}

before(async () => {
  config.TEAM_SHELVES = "on";
  const suffix = randomBytes(5).toString("hex");
  admin = await createAccount(`web-admin-${suffix}`, password);
  author = await createAccount(`web-author-${suffix}`, password);
  other = await createAccount(`web-other-${suffix}`, password);
  reader = await createAccount(`web-reader-${suffix}`, password);
  stranger = await createAccount(`web-stranger-${suffix}`, password);
  for (const account of [admin, author, other, reader, stranger]) {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin },
      payload: { name: account.name, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    sessions.set(account.name, login.cookies[0].value);
  }
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  shelf = (await call("POST", "/api/shelves", admin, { name: "Отдел продаж" })).json();
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("an admin adds colleagues, changes roles, and the shelf keeps an admin", async () => {
  const listed = (await call("GET", "/api/shelves", admin)).json();
  assert.equal(listed.canCreate, true);
  assert.equal((await call("GET", "/api/shelves", author)).json().canCreate, false);
  for (const [account, role] of [[author, "author"], [other, "author"], [reader, "reader"]] as const) {
    const added = await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: account.name.toUpperCase(), role });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().role, role);
  }
  const again = await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: author.name });
  assert.equal(again.statusCode, 409, again.body);
  const nobody = await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: "nobody-here@example.com" });
  assert.equal(nobody.statusCode, 404, nobody.body);
  // Only the admin manages members; a stranger does not even see the shelf.
  const byAuthor = await call("POST", `/api/shelves/${shelf.id}/members`, author, { who: stranger.name });
  assert.equal(byAuthor.statusCode, 403, byAuthor.body);
  assert.equal((await call("GET", `/api/shelves/${shelf.id}/members`, stranger)).statusCode, 404);
  const members = (await call("GET", `/api/shelves/${shelf.id}/members`, reader)).json();
  assert.equal(members.role, "reader");
  assert.equal(members.items.length, 4);
  assert.ok(members.items.every((item: any) => item.email === null));
  // The last admin can neither step down nor leave.
  const demote = await call("PATCH", `/api/shelves/${shelf.id}/members/${admin.id}`, admin, { role: "curator" });
  assert.equal(demote.statusCode, 409, demote.body);
  const leave = await call("POST", `/api/shelves/${shelf.id}/members/${admin.id}/revoke`, admin);
  assert.equal(leave.statusCode, 409, leave.body);
  const renamed = await call("PATCH", `/api/shelves/${shelf.id}`, admin, { name: "Продажи" });
  assert.equal(renamed.json().name, "Продажи");
  const events = (await call("GET", `/api/shelves/${shelf.id}/events`, admin)).json().items;
  assert.deepEqual(
    events.map((item: any) => item.action).reverse(),
    ["shelf_created", "member_added", "member_added", "member_added", "shelf_renamed"],
  );
  assert.equal((await call("GET", `/api/shelves/${shelf.id}/events`, author)).statusCode, 403);
});

test("members save on the shelf, find each other's works, and change by role", async () => {
  const saved = await save(author, "План продаж", "Воронка и квартальный план продаж", shelf.id);
  assert.equal(saved.statusCode, 200, saved.body);
  const { artifactId, revisionId } = saved.json();
  // A reader may read but not save.
  const refused = await save(reader, "Заметка", "Текст", shelf.id);
  assert.equal(refused.statusCode, 403, refused.body);
  // Everyone on the shelf sees the work and who saved it; nobody's own shelf does.
  const seen = (await call("GET", "/api/artifacts?q=воронка", reader, undefined, shelf.id)).json().items;
  assert.deepEqual(seen.map((item: any) => [item.id, item.author.name]), [[artifactId, author.name]]);
  const own = (await call("GET", "/api/artifacts", author)).json().items;
  assert.ok(!own.some((item: any) => item.id === artifactId));
  assert.equal((await call("GET", `/api/artifacts/${artifactId}`, stranger, undefined, shelf.id)).statusCode, 404);
  assert.equal((await call("GET", `/api/artifacts/${artifactId}`, stranger)).statusCode, 404);
  assert.equal((await call("GET", `/api/revisions/${revisionId}/bytes`, reader, undefined, shelf.id)).statusCode, 200);
  // A GET the browser makes by itself names the shelf in the address; writes never do.
  assert.equal((await call("GET", `/api/revisions/${revisionId}/cover?shelf=${shelf.id}`, reader)).statusCode, 200);
  assert.equal((await call("GET", `/api/revisions/${revisionId}/bytes?shelf=${shelf.id}`, stranger)).statusCode, 404);
  const viaQuery = await call("POST", `/api/folders?shelf=${shelf.id}`, admin, { name: "Мимо" });
  assert.equal(viaQuery.statusCode, 200, viaQuery.body);
  assert.ok(!(await db.query("SELECT 1 FROM folders WHERE tenant_id=$1 AND name='Мимо'", [shelf.id])).rowCount);
  // Another author cannot rename it; a curator can; its author can.
  const rename = (account: Account, title: string, expectedTitle: string) =>
    call("PATCH", `/api/artifacts/${artifactId}`, account, { title, expectedTitle, expectedFolderId: null }, shelf.id);
  assert.equal((await rename(other, "Чужое", "План продаж")).statusCode, 403);
  assert.equal((await rename(author, "План продаж 2027", "План продаж")).statusCode, 200);
  await call("PATCH", `/api/shelves/${shelf.id}/members/${other.id}`, admin, { role: "curator" });
  assert.equal((await rename(other, "План продаж — итог", "План продаж 2027")).statusCode, 200);
  // Folders are a curator's; an author's attempt is refused.
  assert.equal((await call("POST", "/api/folders", author, { name: "Отчёты" }, shelf.id)).statusCode, 403);
  const folder = await call("POST", "/api/folders", other, { name: "Отчёты" }, shelf.id);
  assert.equal(folder.statusCode, 200, folder.body);
  const folders = (await call("GET", "/api/folders", reader, undefined, shelf.id)).json();
  assert.deepEqual(folders.map((item: any) => item.name), ["Отчёты"]);
  // The author puts the work in the trash; it stays on the shelf's trash.
  const work = (await call("GET", `/api/artifacts/${artifactId}`, author, undefined, shelf.id)).json();
  const trashed = await call(
    "POST",
    `/api/artifacts/${artifactId}/trash`,
    author,
    { expectedLifecycleVersion: work.lifecycleVersion, expectedRevisionId: work.revision.id },
    shelf.id,
  );
  assert.equal(trashed.statusCode, 200, trashed.body);
  const trash = (await call("GET", "/api/trash", reader, undefined, shelf.id)).json().items;
  assert.deepEqual(trash.map((item: any) => item.id), [artifactId]);
});

test("a member who leaves or is removed loses the shelf; the works stay", async () => {
  const saved = (await save(other, "Регламент", "Регламент отдела", shelf.id)).json();
  const removed = await call("POST", `/api/shelves/${shelf.id}/members/${other.id}/revoke`, admin);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await call("GET", "/api/artifacts", other, undefined, shelf.id)).statusCode, 404);
  const left = await call("POST", `/api/shelves/${shelf.id}/members/${reader.id}/revoke`, reader);
  assert.equal(left.statusCode, 200, left.body);
  assert.equal((await call("GET", "/api/artifacts", reader, undefined, shelf.id)).statusCode, 404);
  const still = (await call("GET", `/api/artifacts/${saved.artifactId}`, admin, undefined, shelf.id)).json();
  assert.equal(still.author.name, other.name);
  const shelves = (await call("GET", "/api/shelves", other)).json().items;
  assert.deepEqual(shelves.map((item: any) => item.kind), ["personal"]);
});

test("an upload is its uploader's; a curator shares from the shelf and the link answers to the issuer", async () => {
  const body = Buffer.from("черновик");
  const start = await call(
    "POST",
    "/api/uploads",
    author,
    { key: randomUUID(), title: "Черновик", filename: "d.txt", mime: "text/plain", size: body.length, sha256: sha256(body) },
    shelf.id,
  );
  const uploadId = start.json().uploadId;
  assert.equal((await call("PUT", `/api/uploads/${uploadId}/bytes`, admin, body, shelf.id)).statusCode, 404);
  assert.equal((await call("GET", `/api/uploads/${uploadId}`, admin, undefined, shelf.id)).statusCode, 404);
  assert.equal((await call("DELETE", `/api/uploads/${uploadId}`, admin, undefined, shelf.id)).statusCode, 404);
  assert.equal((await call("PUT", `/api/uploads/${uploadId}/bytes`, author, body, shelf.id)).statusCode, 200);
  const saved = (await call("POST", `/api/uploads/${uploadId}/finalize`, author, {}, shelf.id)).json();
  const share = (who: Account) =>
    call(
      "POST",
      `/api/artifacts/${saved.artifactId}/share`,
      who,
      { expectedRevisionId: saved.revisionId, expiresInDays: 7 },
      shelf.id,
    );
  // Links out of a department shelf are a curator's.
  assert.equal((await share(author)).statusCode, 403);
  const shared = await share(admin);
  assert.equal(shared.statusCode, 200, shared.body);
  const link = shared.json().share;
  const { rows: [row] } = await db.query("SELECT created_by FROM shares WHERE id=$1", [link.id]);
  assert.equal(row.created_by, admin.id);
  const resolve = () =>
    app.inject({
      method: "POST",
      url: "/api/resolve",
      headers: { origin },
      payload: { token: new URL(link.url).hash.slice(1) },
    });
  assert.equal((await resolve()).statusCode, 200);
  // Comments on it are off, not an error.
  const comments = await app.inject({
    method: "POST",
    url: "/api/shared/comments",
    headers: { origin, "content-type": "application/json" },
    payload: JSON.stringify({ token: new URL(link.url).hash.slice(1) }),
  });
  assert.notEqual(comments.statusCode, 200);
  assert.notEqual(comments.statusCode, 500);
  // With TEAM_SHELVES off the link closes; on again, it opens.
  config.TEAM_SHELVES = "off";
  try {
    assert.equal((await resolve()).statusCode, 404);
  } finally {
    config.TEAM_SHELVES = "on";
  }
  assert.equal((await resolve()).statusCode, 200);
  // The issuer disabled: the link closes, like an owner's.
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [admin.id]);
  try {
    assert.equal((await resolve()).statusCode, 404);
  } finally {
    await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [admin.id]);
  }
  // A curator revokes it.
  const revoked = await call("POST", `/api/shares/${link.id}/revoke`, admin, {}, shelf.id);
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await resolve()).statusCode, 404);
});

test("personal shelves behave as before", async () => {
  const saved = await save(stranger, "Своё", "Личная заметка");
  assert.equal(saved.statusCode, 200, saved.body);
  const items = (await call("GET", "/api/artifacts", stranger)).json().items;
  assert.equal(items[0].author, undefined);
  const shared = await call("POST", `/api/artifacts/${saved.json().artifactId}/share`, stranger, {
    expectedRevisionId: saved.json().revisionId,
    expiresInDays: 7,
  });
  assert.equal(shared.statusCode, 200, shared.body);
});
