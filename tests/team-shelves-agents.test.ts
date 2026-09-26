// Department shelves, stage 3 (docs/specs/TEAM_SHELVES.md): an agent is
// connected to one shelf the account belongs to. It saves there by the
// account's role, polka_context names the shelf and role, links and comments
// are not offered, and leaving the shelf ends its agents there.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const mcpHost = new URL(MCP_AUDIENCE).host;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
const address = () =>
  `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string };
let admin: Account, author: Account, reader: Account, stranger: Account;
let shelf: { id: string; name: string };

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

async function issue(who: Account, body: Record<string, unknown>) {
  const csrf = await app.inject({
    method: "POST",
    url: "/api/agent-connections/csrf",
    remoteAddress: address(),
    headers: { origin, cookie: who.cookie, "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(csrf.statusCode, 200, csrf.body);
  return app.inject({
    method: "POST",
    url: "/api/agent-connections",
    remoteAddress: address(),
    headers: {
      origin,
      cookie: who.cookie,
      "content-type": "application/json",
      "x-polka-csrf": csrf.json().csrfToken,
    },
    payload: JSON.stringify({ name: "Claude Code", audience: MCP_AUDIENCE, ttlDays: 1, ...body }),
  });
}

async function mcp(bearer: string, method: string, params: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: address(),
    headers: {
      host: mcpHost,
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  if (response.statusCode !== 200) return { status: response.statusCode, message: null as any };
  const text = String(response.headers["content-type"]).startsWith("text/event-stream")
    ? response.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("")
    : response.body;
  return { status: 200, message: JSON.parse(text) };
}

const publish = (bearer: string, title: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: JSON.stringify({
      key: randomUUID(),
      title,
      html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Отчёт отдела для коллег.</p></body></html>`,
    }),
  });

before(async () => {
  config.TEAM_SHELVES = "on";
  admin = await account("agents-admin");
  author = await account("agents-author");
  reader = await account("agents-reader");
  stranger = await account("agents-stranger");
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  const created = await app.inject({
    method: "POST",
    url: "/api/shelves",
    headers: { origin, cookie: admin.cookie },
    payload: { name: "Отдел продаж" },
  });
  shelf = created.json();
  for (const [who, role] of [[author, "author"], [reader, "reader"]] as const) {
    const added = await app.inject({
      method: "POST",
      url: `/api/shelves/${shelf.id}/members`,
      headers: { origin, cookie: admin.cookie },
      payload: { who: who.name, role },
    });
    assert.equal(added.statusCode, 200, added.body);
  }
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("an author's agent saves to the department shelf and knows where it is", async () => {
  const issued = await issue(author, { scopes: ["context", "read", "capture"], shelfId: shelf.id });
  assert.equal(issued.statusCode, 200, issued.body);
  assert.deepEqual(issued.json().connection.shelf, { id: shelf.id, name: "Отдел продаж" });
  const token = issued.json().token;
  const saved = await publish(token, "Отчёт агента");
  assert.equal(saved.statusCode, 200, saved.body);
  const { rows: [work] } = await db.query(
    "SELECT tenant_id,created_by FROM artifacts WHERE id=$1",
    [saved.json().artifactId],
  );
  assert.deepEqual(work, { tenant_id: shelf.id, created_by: author.id });
  // Colleagues see it on the shelf.
  const listed = await app.inject({
    method: "GET",
    url: "/api/artifacts",
    headers: { origin, cookie: reader.cookie, "x-polka-shelf": shelf.id },
  });
  assert.ok(listed.json().items.some((item: any) => item.id === saved.json().artifactId));
  // polka_context names the shelf and the role; links and comments are not offered.
  assert.equal((await mcp(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "1.0" },
  })).status, 200);
  const context = await mcp(token, "tools/call", { name: "polka_context", arguments: {} });
  const result = JSON.parse(context.message.result.content[0].text);
  assert.deepEqual(
    { kind: result.shelf.kind, name: result.shelf.name, role: result.shelf.role, canSave: result.shelf.canSave },
    { kind: "team", name: "Отдел продаж", role: "author", canSave: true },
  );
  assert.equal(result.capabilities.share, false);
  const tools = (await mcp(token, "tools/list")).message.result.tools.map((tool: any) => tool.name);
  assert.ok(tools.includes("polka_publish"));
  // An author's agent reads the discussions; links and answers are a curator's.
  assert.ok(tools.includes("polka_comments"));
  for (const name of ["polka_share", "polka_note", "polka_resolve_comment"])
    assert.ok(!tools.includes(name), name);
  // The owner's list shows the connection with its shelf.
  const list = await app.inject({ method: "GET", url: "/api/agent-connections", headers: { origin, cookie: author.cookie } });
  assert.equal(list.json().find((item: any) => item.id === issued.json().connection.id).shelf.name, "Отдел продаж");
});

test("an admin's agent publishes with a link from the department shelf", async () => {
  const issued = await issue(admin, { scopes: ["context", "capture", "share"], shelfId: shelf.id });
  assert.equal(issued.statusCode, 200, issued.body);
  const saved = await publish(issued.json().token, "Отчёт со ссылкой");
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().state, "shared");
  const { rows: [share] } = await db.query(
    "SELECT created_by,tenant_id FROM shares WHERE artifact_id=$1 AND NOT revoked",
    [saved.json().artifactId],
  );
  assert.deepEqual(share, { created_by: admin.id, tenant_id: shelf.id });
  // An author's agent asking for a link through the HTTP API is refused.
  const authorToken = (await issue(author, { scopes: ["context", "capture", "share"], shelfId: shelf.id })).json().token;
  const refused = await app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${authorToken}`, "content-type": "application/json" },
    payload: JSON.stringify({
      key: randomUUID(),
      title: "Без ссылки",
      html: "<!doctype html><html><head><meta charset=\"utf-8\"><title>x</title></head><body><h1>x</h1><p>Текст отдела.</p></body></html>",
      expiresInDays: 7,
    }),
  });
  assert.notEqual(refused.json().state, "shared");
});

test("a reader connects an agent only to read; its role is checked on every save", async () => {
  const refused = await issue(reader, { scopes: ["context", "read", "capture"], shelfId: shelf.id });
  assert.equal(refused.statusCode, 403, refused.body);
  const readOnly = await issue(reader, { scopes: ["context", "read"], shelfId: shelf.id });
  assert.equal(readOnly.statusCode, 200, readOnly.body);
  // An author's agent loses saving when the author becomes a reader.
  const issued = await issue(author, { scopes: ["context", "capture"], shelfId: shelf.id });
  await app.inject({
    method: "PATCH",
    url: `/api/shelves/${shelf.id}/members/${author.id}`,
    headers: { origin, cookie: admin.cookie },
    payload: { role: "reader" },
  });
  try {
    const denied = await publish(issued.json().token, "Не сохранится");
    assert.equal(denied.statusCode, 403, denied.body);
  } finally {
    await app.inject({
      method: "PATCH",
      url: `/api/shelves/${shelf.id}/members/${author.id}`,
      headers: { origin, cookie: admin.cookie },
      payload: { role: "author" },
    });
  }
});

test("a shelf the account is not on takes no agent", async () => {
  const refused = await issue(stranger, { scopes: ["context", "read"], shelfId: shelf.id });
  assert.equal(refused.statusCode, 404, refused.body);
  await assert.rejects(
    db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
       VALUES($1,$2,$3,$4,'x',ARRAY['context'],$5,now()+interval '1 day')`,
      [randomUUID(), shelf.id, stranger.id, randomBytes(32).toString("hex"), MCP_AUDIENCE],
    ),
    /agent_connections_member_fkey/,
  );
});

test("leaving the shelf ends the agents connected to it, for good", async () => {
  const member = await account("agents-leaving");
  await app.inject({
    method: "POST",
    url: `/api/shelves/${shelf.id}/members`,
    headers: { origin, cookie: admin.cookie },
    payload: { who: member.name, role: "author" },
  });
  const onShelf = (await issue(member, { scopes: ["context", "capture"], shelfId: shelf.id })).json();
  const own = (await issue(member, { scopes: ["context", "capture"] })).json();
  assert.equal(own.connection.shelf, undefined);
  assert.equal((await publish(onShelf.token, "До ухода")).statusCode, 200);
  const removed = await app.inject({
    method: "POST",
    url: `/api/shelves/${shelf.id}/members/${member.id}/revoke`,
    headers: { origin, cookie: admin.cookie },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await publish(onShelf.token, "После ухода")).statusCode, 401);
  // Back on the shelf, the old agent stays closed; the own shelf's agent works.
  await app.inject({
    method: "POST",
    url: `/api/shelves/${shelf.id}/members`,
    headers: { origin, cookie: admin.cookie },
    payload: { who: member.name, role: "author" },
  });
  assert.equal((await publish(onShelf.token, "Снова")).statusCode, 401);
  const { rows: [row] } = await db.query("SELECT revoked_at FROM agent_connections WHERE id=$1", [onShelf.connection.id]);
  assert.ok(row.revoked_at);
  assert.equal((await publish(own.token, "На своей полке")).statusCode, 200);
});

test("with TEAM_SHELVES off a department shelf's agent stops", async () => {
  const issued = (await issue(author, { scopes: ["context", "capture"], shelfId: shelf.id })).json();
  config.TEAM_SHELVES = "off";
  try {
    assert.equal((await publish(issued.token, "Выключено")).statusCode, 401);
  } finally {
    config.TEAM_SHELVES = "on";
  }
  assert.equal((await publish(issued.token, "Включено")).statusCode, 200);
});
