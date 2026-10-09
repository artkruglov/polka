// «Полка на дату» (docs/specs/SHELF_SNAPSHOT.md): the MCP tool polka_snapshot
// answers exactly what GET /api/v1/snapshot answers, the web route gives a
// member the shelf the page shows, and the screen renders it read-only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { localInputValue, SnapshotList } from "../apps/web/src/pages/snapshot/view.tsx";
import type { SnapshotItem } from "../apps/web/src/shared/api/client.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const mcpHost = new URL(MCP_AUDIENCE).host;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
type Account = Awaited<ReturnType<typeof createAccount>>;
let owner: Account, reader: Account, stranger: Account;
const sessions = new Map<string, string>();
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const call = (method: any, url: string, account: Account | null, body?: unknown, onShelf?: string) =>
  app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: {
      origin,
      ...(account ? { cookie: `polka_session=${sessions.get(account.name)}` } : {}),
      ...(onShelf ? { "x-polka-shelf": onShelf } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body as any,
  });

async function save(account: Account, title: string, onShelf?: string) {
  const body = Buffer.from(`${title} ${randomUUID()}`);
  const start = await call(
    "POST",
    "/api/uploads",
    account,
    { key: randomUUID(), title, filename: "note.txt", mime: "text/plain", size: body.length, sha256: sha256(body) },
    onShelf,
  );
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  assert.equal((await call("PUT", `/api/uploads/${uploadId}/bytes`, account, body, onShelf)).statusCode, 200);
  const done = await call("POST", `/api/uploads/${uploadId}/finalize`, account, {}, onShelf);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

async function token(account: Account, scopes: string[]) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'snapshot',$5,$6,now()+interval '1 day')`,
    [randomUUID(), account.tenant, account.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}

async function mcp(secret: string, name: string, args: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: address(),
    headers: {
      host: mcpHost,
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const text = String(response.headers["content-type"]).startsWith("text/event-stream")
    ? response.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("")
    : response.body;
  const answer = JSON.parse(text);
  // An unknown tool is a JSON-RPC error, not a tool result.
  if (answer.error) return { isError: true, structuredContent: null, content: [{ text: answer.error.message as string }] };
  return answer.result as { isError?: boolean; structuredContent: any; content: { text: string }[] };
}

before(async () => {
  config.TEAM_SHELVES = "on";
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`snap-owner-${suffix}`, password);
  reader = await createAccount(`snap-reader-${suffix}`, password);
  stranger = await createAccount(`snap-stranger-${suffix}`, password);
  for (const account of [owner, reader, stranger]) {
    const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: account.name, password } });
    assert.equal(login.statusCode, 200, login.body);
    sessions.set(account.name, login.cookies[0].value);
  }
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("polka_snapshot answers what GET /api/v1/snapshot answers, page by page; the web adds what is true now", async () => {
  const twoVersions = await save(owner, "Снимок: две версии");
  const trashedLater = await save(owner, "Снимок: в корзине потом");
  await db.query("UPDATE revisions SET created_at=$2 WHERE id=ANY($1::uuid[])", [
    [twoVersions.revisionId, trashedLater.revisionId],
    day(10),
  ]);
  const second = randomUUID();
  await db.query(
    `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,storage_kind,total_size,created_at)
     VALUES($1,$2,$3,2,$4,'note.txt','text/plain',4,$5,$6,'version','single',4,$7)`,
    [second, owner.tenant, twoVersions.artifactId, owner.id, sha256("v2"), `${owner.tenant}/snapshot/${second}`, day(5)],
  );
  await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [twoVersions.artifactId, second]);
  const journal = (action: string, artifactId: string, daysAgo: number, payload: object | null = null) =>
    db.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [owner.tenant, owner.id, action, artifactId, payload, day(daysAgo)],
    );
  await journal("revision.accepted", twoVersions.artifactId, 8, { artifactId: twoVersions.artifactId, revisionId: twoVersions.revisionId });
  await journal("artifact.trashed", trashedLater.artifactId, 1);
  await db.query("UPDATE artifacts SET trashed_at=$2 WHERE id=$1", [trashedLater.artifactId, day(1)]);

  const secret = await token(owner, ["context", "read"]);
  const at = day(3);
  const http = (qs: string) =>
    app.inject({ method: "GET", url: `/api/v1/snapshot?${qs}`, remoteAddress: address(), headers: { authorization: `Bearer ${secret}` } });
  const whole = await http(new URLSearchParams({ at, limit: "100" }).toString());
  assert.equal(whole.statusCode, 200, whole.body);
  const tool = await mcp(secret, "polka_snapshot", { at, limit: 100 });
  assert.ok(!tool.isError, tool.content[0]?.text);
  assert.deepEqual(tool.structuredContent, whole.json());
  assert.equal(whole.json().items.length, 2);
  // Page by page, too: the cursor of one is the cursor of the other.
  const firstHttp = (await http(new URLSearchParams({ at, limit: "1" }).toString())).json();
  const firstTool = (await mcp(secret, "polka_snapshot", { at, limit: 1 })).structuredContent;
  assert.deepEqual(firstTool, firstHttp);
  assert.ok(firstHttp.nextCursor);
  const nextHttp = (await http(new URLSearchParams({ at, limit: "1", cursor: firstHttp.nextCursor }).toString())).json();
  assert.deepEqual((await mcp(secret, "polka_snapshot", { at, limit: 1, cursor: firstHttp.nextCursor })).structuredContent, nextHttp);
  // The tool refuses what the route refuses, and needs read.
  assert.ok((await mcp(secret, "polka_snapshot", { at: new Date(Date.now() + 3_600_000).toISOString() })).isError);
  assert.ok((await mcp(secret, "polka_snapshot", { at: "yesterday" })).isError);
  const noRead = await token(owner, ["context"]);
  const missingTool = await mcp(noRead, "polka_snapshot", { at });
  assert.ok(missingTool.isError, "a connection without read has no polka_snapshot");

  // The web route: the same works and versions, and what is true of them now.
  const web = await call("GET", `/api/snapshot?${new URLSearchParams({ at })}`, owner);
  assert.equal(web.statusCode, 200, web.body);
  const items = web.json().items as any[];
  assert.deepEqual(
    items.map(({ acceptedRevisionNumber, now, ...rest }) => rest),
    whole.json().items,
  );
  const two = items.find((item) => item.id === twoVersions.artifactId);
  assert.equal(two.revision.number, 2);
  assert.equal(two.acceptedRevisionId, twoVersions.revisionId);
  assert.equal(two.acceptedRevisionNumber, 1);
  assert.deepEqual(two.now, { latestRevisionNumber: 2, trashed: false });
  const trashed = items.find((item) => item.id === trashedLater.artifactId);
  assert.deepEqual(trashed.now, { latestRevisionNumber: 1, trashed: true });
  assert.equal(trashed.acceptedRevisionNumber, null);
  // Before anything was saved the shelf was empty; the future, a bad moment and no session are refused.
  assert.equal((await call("GET", `/api/snapshot?at=${encodeURIComponent(day(30))}`, owner)).json().items.length, 0);
  assert.equal((await call("GET", `/api/snapshot?at=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`, owner)).statusCode, 400);
  assert.equal((await call("GET", "/api/snapshot?at=yesterday", owner)).statusCode, 400);
  assert.equal((await call("GET", `/api/snapshot?at=${encodeURIComponent(at)}`, null)).statusCode, 401);
});

test("on a department shelf any member sees «Полка на дату»; others do not", async () => {
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [owner.id]);
  const shelf = (await call("POST", "/api/shelves", owner, { name: "Отдел снимков" })).json();
  const added = await call("POST", `/api/shelves/${shelf.id}/members`, owner, { who: reader.name, role: "reader" });
  assert.equal(added.statusCode, 200, added.body);
  const work = await save(owner, "Снимок отдела", shelf.id);
  const at = new Date(Date.now()).toISOString();
  const seen = await call("GET", `/api/snapshot?${new URLSearchParams({ at })}`, reader, undefined, shelf.id);
  assert.equal(seen.statusCode, 200, seen.body);
  assert.deepEqual(seen.json().items.map((item: any) => item.id), [work.artifactId]);
  // The reader's own shelf does not hold the department's work.
  const own = await call("GET", `/api/snapshot?${new URLSearchParams({ at })}`, reader);
  assert.ok(!own.json().items.some((item: any) => item.id === work.artifactId));
  assert.equal((await call("GET", `/api/snapshot?${new URLSearchParams({ at })}`, stranger, undefined, shelf.id)).statusCode, 404);
});

test("the screen lists each work's version then, the acceptance then and what changed since", () => {
  const item = (patch: Partial<SnapshotItem>): SnapshotItem => ({
    id: randomUUID(),
    title: "Отчёт",
    folderId: null,
    revision: { id: "r2", number: 2, filename: "a.html", mime: "text/html", size: 1, totalSize: 1, createdAt: "2026-10-01T09:00:00.000Z" },
    acceptedRevisionId: null,
    acceptedRevisionNumber: null,
    now: { latestRevisionNumber: 2, trashed: false },
    ...patch,
  });
  const html = renderToStaticMarkup(
    React.createElement(SnapshotList, {
      at: "2026-10-02T09:00:00.000Z",
      items: [
        item({ title: "План <продаж>", acceptedRevisionId: "r2", acceptedRevisionNumber: 2 }),
        item({ title: "Бриф", acceptedRevisionId: "r1", acceptedRevisionNumber: 1, now: { latestRevisionNumber: 4, trashed: true } }),
        item({ title: "Черновик" }),
      ],
      nextCursor: "c",
      onMore: () => {},
      hrefFor: (work) => `/works/${work.id}?revision=${work.revision.id}&shelf=s`,
    }),
  );
  assert.match(html, /План &lt;продаж&gt;/, "titles are text");
  assert.match(html, /Версия 2 от/);
  assert.match(html, /Эта версия принята/);
  assert.match(html, /Принята версия 1/);
  assert.match(html, /Сейчас в корзине, сейчас версия 4/);
  assert.match(html, /больше 3 работы на полке/);
  assert.match(html, /\?revision=r2&amp;shelf=s/);
  assert.match(html, /Показать ещё/);
  // Read-only: nothing on the screen changes the shelf.
  assert.doesNotMatch(html, /В корзину|Восстановить|Принять/);
  const empty = renderToStaticMarkup(
    React.createElement(SnapshotList, { at: "2026-10-02T09:00:00.000Z", items: [], nextCursor: null, onMore: () => {}, hrefFor: () => "" }),
  );
  assert.match(empty, /В этот момент полка была пуста/);
  assert.equal(localInputValue(new Date(2026, 0, 5, 7, 3)), "2026-01-05T07:03");
});
