// Department shelves after review (docs/specs/TEAM_SHELVES.md): a freeze and a
// disable are the author's, not the colleagues'; the operator takes down a
// work saved on a department shelf; looking a colleague up tells a non-admin
// nothing; an author's new version of a colleague's work is refused at once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { freezeAccountInTransaction } from "../apps/server/content-moderation.ts";
import { disableAccount, takedown } from "../apps/server/moderation.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string };
let admin: Account, author: Account, colleague: Account, reader: Account;
let shelf: { id: string };

async function account(prefix: string): Promise<Account> {
  const created = await createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: created.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  return { ...created, cookie: `polka_session=${login.cookies[0].value}` };
}

const call = (method: any, url: string, who: Account, body?: unknown, onShelf?: string) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      cookie: who.cookie,
      ...(onShelf ? { "x-polka-shelf": onShelf } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body as any,
  });

async function connection(who: Account, tenant: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'agent',ARRAY['context','capture'],$5,now()+interval '1 day')`,
    [id, tenant, who.id, sha256(randomBytes(32).toString("base64url")), MCP_AUDIENCE],
  );
  return id;
}
const revoked = async (id: string) =>
  !!(await db.query("SELECT revoked_at FROM agent_connections WHERE id=$1", [id])).rows[0].revoked_at;

async function save(who: Account, title: string) {
  const body = Buffer.from(`<!doctype html><title>${title}</title><h1>${title}</h1><p>Текст отдела.</p>`);
  const start = await call(
    "POST",
    "/api/uploads",
    who,
    { key: randomUUID(), title, filename: "page.html", mime: "text/html", size: body.length, sha256: sha256(body) },
    shelf.id,
  );
  assert.equal(start.statusCode, 200, start.body);
  await call("PUT", `/api/uploads/${start.json().uploadId}/bytes`, who, body, shelf.id);
  const done = await call("POST", `/api/uploads/${start.json().uploadId}/finalize`, who, {}, shelf.id);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

before(async () => {
  config.TEAM_SHELVES = "on";
  admin = await account("review-admin");
  author = await account("review-author");
  colleague = await account("review-colleague");
  reader = await account("review-reader");
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  shelf = (await call("POST", "/api/shelves", admin, { name: "Отдел ревью" })).json();
  for (const [who, role] of [[author, "author"], [colleague, "author"], [reader, "reader"]] as const)
    assert.equal(
      (await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: who.name, role })).statusCode,
      200,
    );
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("a freeze from a department shelf stops the author's agents, not the colleagues'", async () => {
  const authorOnShelf = await connection(author, shelf.id);
  const authorOwn = await connection(author, author.tenant);
  const colleagues = await connection(colleague, shelf.id);
  await transaction((c) =>
    freezeAccountInTransaction(c, { accountId: author.id, tenantId: shelf.id }, "filter", "тест", "other"),
  );
  assert.equal(await revoked(authorOnShelf), true);
  assert.equal(await revoked(authorOwn), true);
  assert.equal(await revoked(colleagues), false);
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [author.id]);
  // The frozen author's session ended; sign in again for the next tests.
  author = await account("review-author2");
  await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: author.name, role: "author" });
});

test("disabling an account revokes its agents on department shelves too", async () => {
  const member = await account("review-disabled");
  await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: member.name, role: "author" });
  const onShelf = await connection(member, shelf.id);
  await disableAccount(member.name, "тест");
  assert.equal(await revoked(onShelf), true);
});

test("the operator takes down a work saved on a department shelf", async () => {
  const saved = await save(author, "Спорная страница");
  const receipt = await takedown(saved.artifactId, { reason: "по жалобе", category: "other" });
  assert.equal(receipt.blocked.length, 1);
  assert.equal(receipt.blocked[0]!.revisionId, saved.revisionId);
});

test("looking a colleague up tells a non-admin nothing", async () => {
  const known = await call("POST", `/api/shelves/${shelf.id}/members`, reader, { who: admin.name });
  const unknown = await call("POST", `/api/shelves/${shelf.id}/members`, reader, { who: "nobody@example.invalid" });
  assert.equal(known.statusCode, 403);
  assert.equal(unknown.statusCode, 403);
});

test("an author's new version of a colleague's work is refused when it begins", async () => {
  const theirs = await save(colleague, "Чужой отчёт");
  const body = Buffer.from("<!doctype html><title>x</title><p>x</p>");
  const begun = await call(
    "POST",
    "/api/uploads",
    author,
    {
      key: randomUUID(),
      title: "Чужой отчёт",
      filename: "page.html",
      mime: "text/html",
      size: body.length,
      sha256: sha256(body),
      artifactId: theirs.artifactId,
      baseRevisionId: theirs.revisionId,
    },
    shelf.id,
  );
  assert.equal(begun.statusCode, 403, begun.body);
});
