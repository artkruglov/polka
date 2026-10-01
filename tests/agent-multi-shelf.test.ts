// Search across shelves for an agent (docs/specs/DATA_MODELS.md §7): only the
// department shelves the owner allowed the token at issue, a live membership on
// each at every call, active works only, and every item says its shelf.
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
const password = randomBytes(24).toString("hex");
const savedTeam = config.TEAM_SHELVES;
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string };
let admin: Account, person: Account;
let shelfA: string, shelfB: string, shelfC: string;
const word = `зонтик${randomBytes(3).toString("hex")}`;

async function account(prefix: string): Promise<Account> {
  const created = await createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: created.name, password } });
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
  return app.inject({
    method: "POST",
    url: "/api/agent-connections",
    remoteAddress: address(),
    headers: { origin, cookie: who.cookie, "content-type": "application/json", "x-polka-csrf": csrf.json().csrfToken },
    payload: JSON.stringify({ name: "Поиск", audience: MCP_AUDIENCE, ttlDays: 1, ...body }),
  });
}
const api = (token: string, url: string, method = "GET", payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    remoteAddress: address(),
    headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  });
const publish = (token: string, title: string) =>
  api(token, "/api/v1/publish", "POST", {
    key: randomUUID(),
    title,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
  });
const newShelf = async (name: string) =>
  (await app.inject({ method: "POST", url: "/api/shelves", headers: { origin, cookie: admin.cookie }, payload: { name } })).json().id as string;
const add = (shelf: string, who: Account, role: string) =>
  app.inject({ method: "POST", url: `/api/shelves/${shelf}/members`, headers: { origin, cookie: admin.cookie }, payload: { who: who.name, role } });

before(async () => {
  config.TEAM_SHELVES = "on";
  admin = await account("ms-admin");
  person = await account("ms-person");
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  [shelfA, shelfB, shelfC] = [await newShelf("Продажи"), await newShelf("Закупки"), await newShelf("Секретный")];
  assert.equal((await add(shelfA, person, "reader")).statusCode, 200);
  assert.equal((await add(shelfB, person, "author")).statusCode, 200);
});

after(async () => {
  config.TEAM_SHELVES = savedTeam;
  await app.close();
  await db.end();
  s3.destroy();
});

test("a token searches its own shelf and the allowed ones; the rest is refused", async () => {
  const own = await issue(person, { scopes: ["context", "read", "capture"] });
  const mine = await publish(own.json().token, `Личный ${word}`);
  assert.equal(mine.statusCode, 200, mine.body);
  const inA = await publish((await issue(admin, { scopes: ["context", "capture"], shelfId: shelfA })).json().token, `Продажи ${word}`);
  const inB = await publish((await issue(admin, { scopes: ["context", "capture"], shelfId: shelfB })).json().token, `Закупки ${word}`);
  const inC = await publish((await issue(admin, { scopes: ["context", "capture"], shelfId: shelfC })).json().token, `Секрет ${word}`);
  for (const response of [inA, inB, inC]) assert.equal(response.statusCode, 200, response.body);

  // Issue: only shelves the person belongs to, and with read.
  assert.equal((await issue(person, { scopes: ["context", "read"], allowedShelfIds: [shelfC] })).statusCode, 422);
  assert.equal((await issue(person, { scopes: ["context", "capture"], allowedShelfIds: [shelfA] })).statusCode, 400);
  const wide = await issue(person, { scopes: ["context", "read"], allowedShelfIds: [shelfA, shelfB] });
  assert.equal(wide.statusCode, 200, wide.body);
  const token = wide.json().token as string;
  const ids = [person.tenant, shelfA, shelfB].join(",");

  const all = await api(token, `/api/v1/works?query=${word}&shelfIds=${ids}`);
  assert.equal(all.statusCode, 200, all.body);
  const found = all.json().items.map((item: any) => [item.title.split(" ")[0], item.shelfId]).sort();
  assert.deepEqual(found, [["Закупки", shelfB], ["Личный", person.tenant], ["Продажи", shelfA]]);
  // Without shelfIds: its own shelf only, as before.
  const plain = await api(token, `/api/v1/works?query=${word}`);
  assert.deepEqual(plain.json().items.map((item: any) => item.shelfId), [person.tenant]);
  // A shelf not allowed, by id: refused, and its work never shows.
  const refused = await api(token, `/api/v1/works?query=${word}&shelfIds=${shelfC}`);
  assert.equal(refused.statusCode, 403);
  assert.ok(!refused.body.includes(shelfC) || refused.statusCode === 403);
  assert.ok(!(await api(token, `/api/v1/works?query=${word}&shelfIds=${person.tenant},${shelfC}`)).body.includes("Секрет"));
  // The token that was not given shelves cannot name them.
  const narrow = (await issue(person, { scopes: ["context", "read"] })).json().token as string;
  assert.equal((await api(narrow, `/api/v1/works?shelfIds=${shelfA}`)).statusCode, 403);
  // No trash, no folder with several shelves.
  assert.equal((await api(token, `/api/v1/works?shelfIds=${ids}&state=trashed`)).statusCode, 400);

  // Pages across shelves do not repeat or lose works.
  const seen: string[] = [];
  let cursor = "";
  do {
    const page = (await api(token, `/api/v1/works?query=${word}&shelfIds=${ids}&limit=1${cursor}`)).json();
    seen.push(...page.items.map((item: any) => item.id));
    cursor = page.nextCursor ? `&cursor=${encodeURIComponent(page.nextCursor)}` : "";
  } while (cursor);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);

  // The agent can learn which shelves it may name: polka_context lists them.
  const mcpHost = new URL(MCP_AUDIENCE).host;
  const call = async (name: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      remoteAddress: address(),
      headers: {
        host: mcpHost,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } },
    });
    const text = String(response.headers["content-type"]).startsWith("text/event-stream")
      ? response.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("")
      : response.body;
    return JSON.parse(JSON.parse(text).result.content[0].text);
  };
  const context = await call("polka_context");
  assert.equal(context.shelf.id, person.tenant);
  assert.deepEqual(
    context.searchableShelves.map((entry: any) => entry.id).sort(),
    [person.tenant, shelfA, shelfB].sort(),
  );
  // A personal shelf id is not a department shelf at issue.
  assert.equal((await issue(person, { scopes: ["context", "read"], allowedShelfIds: [person.tenant] })).statusCode, 422);
  // With department shelves off the extra shelves drop out at the call.
  config.TEAM_SHELVES = "off";
  try {
    const off = await api(token, `/api/v1/works?query=${word}&shelfIds=${ids}`);
    assert.deepEqual(off.json().items.map((item: any) => item.shelfId), [person.tenant]);
  } finally {
    config.TEAM_SHELVES = "on";
  }
  // Leaving a shelf closes it for the agent at once.
  const removed = await app.inject({
    method: "POST",
    url: `/api/shelves/${shelfB}/members/${person.id}/revoke`,
    headers: { origin, cookie: admin.cookie },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const after = await api(token, `/api/v1/works?query=${word}&shelfIds=${ids}`);
  assert.equal(after.statusCode, 200, after.body);
  assert.deepEqual(after.json().items.map((item: any) => item.shelfId).sort(), [person.tenant, shelfA].sort());
});
