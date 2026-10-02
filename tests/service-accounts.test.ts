// Service accounts (docs/specs/DATA_MODELS.md §3, §4): an unattended agent on a
// department shelf with a person responsible for it, short task tokens, the
// freeze when the responsible person leaves, and the pinned-link rule.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE, authenticateServiceToken } from "../apps/server/service-auth.ts";
import { moveShareFromAgent } from "../apps/server/shares.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const saved = { team: config.TEAM_SHELVES, service: config.SERVICE_ACCOUNTS };
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string };
let admin: Account, curator: Account;
let shelf: { id: string };

async function account(prefix: string): Promise<Account> {
  const created = await createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: created.name, password } });
  assert.equal(login.statusCode, 200, login.body);
  return { ...created, cookie: `polka_session=${login.cookies[0].value}` };
}
const session = (who: Account, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    remoteAddress: address(),
    headers: {
      origin,
      cookie: who.cookie,
      "x-polka-shelf": shelf.id,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
const api = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    remoteAddress: address(),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Сводка отдела.</p></body></html>`;
const publish = (token: string, title: string, extra: Record<string, unknown> = {}) =>
  api(token, "POST", "/api/v1/publish", { key: randomUUID(), title, html: page(title), ...extra });
async function humanToken(who: Account, scopes: string[]) {
  const csrf = await app.inject({
    method: "POST",
    url: "/api/agent-connections/csrf",
    remoteAddress: address(),
    headers: { origin, cookie: who.cookie, "content-type": "application/json" },
    payload: "{}",
  });
  const issued = await app.inject({
    method: "POST",
    url: "/api/agent-connections",
    remoteAddress: address(),
    headers: { origin, cookie: who.cookie, "content-type": "application/json", "x-polka-csrf": csrf.json().csrfToken },
    payload: JSON.stringify({ name: "Человек", audience: MCP_AUDIENCE, ttlDays: 1, scopes, shelfId: shelf.id }),
  });
  assert.equal(issued.statusCode, 200, issued.body);
  return issued.json().token as string;
}
const create = async (who: Account, body: Record<string, unknown>) => {
  const response = await session(who, "POST", "/api/service-accounts", body);
  return response;
};

before(async () => {
  config.TEAM_SHELVES = "on";
  config.SERVICE_ACCOUNTS = "on";
  admin = await account("svc-admin");
  curator = await account("svc-curator");
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  shelf = (await app.inject({ method: "POST", url: "/api/shelves", headers: { origin, cookie: admin.cookie }, payload: { name: "Отдел сервисов" } })).json();
  const added = await app.inject({
    method: "POST",
    url: `/api/shelves/${shelf.id}/members`,
    headers: { origin, cookie: admin.cookie },
    payload: { who: curator.name, role: "curator" },
  });
  assert.equal(added.statusCode, 200, added.body);
});

after(async () => {
  config.TEAM_SHELVES = saved.team;
  config.SERVICE_ACCOUNTS = saved.service;
  await app.close();
  await db.end();
  s3.destroy();
});

test("off by default; scopes are limited; read and share never together", async () => {
  config.SERVICE_ACCOUNTS = "off";
  assert.equal((await create(admin, { name: "Выключено" })).statusCode, 404);
  config.SERVICE_ACCOUNTS = "on";
  for (const scopes of [["read", "share"], ["source:read", "share"], ["manage"], ["sign_in", "read"]]) {
    const refused = await create(admin, { name: `Нельзя ${scopes.join("+")}`, scopes });
    assert.equal(refused.statusCode, 400, refused.body);
  }
  assert.equal((await create(admin, { name: "Долго", ttlDays: 91 })).statusCode, 400);
  const ok = await create(admin, { name: "Ночной дайджест", scopes: ["context", "read", "capture", "revise"] });
  assert.equal(ok.statusCode, 200, ok.body);
  // «context» is added even when the form leaves it out.
  const bare = await create(admin, { name: "Без context", scopes: ["read"] });
  assert.deepEqual(bare.json().scopes, ["context", "read"]);
  // Left out altogether: what a nightly reader needs, read and capture.
  const defaults = await create(admin, { name: "По умолчанию" });
  assert.deepEqual(defaults.json().scopes, ["capture", "context", "read"]);
  assert.equal((await create(admin, { name: "ночной дайджест" })).statusCode, 409);
  const listed = (await session(admin, "GET", "/api/service-accounts")).json();
  assert.ok(listed.items.some((item: any) => item.name === "Ночной дайджест" && item.status === "active"));
});

test("a service token reads and saves as its responsible person; people's lists do not show it", async () => {
  const { token, servicePrincipal } = (await create(admin, { name: "Рабочий", scopes: ["context", "read", "capture"] })).json();
  const works = await api(token, "GET", "/api/v1/works");
  assert.equal(works.statusCode, 200, works.body);
  const saved = await publish(token, "Сводка сервиса");
  assert.equal(saved.statusCode, 200, saved.body);
  const {
    rows: [work],
  } = await db.query("SELECT tenant_id,created_by FROM artifacts WHERE id=$1", [saved.json().artifactId]);
  assert.deepEqual(work, { tenant_id: shelf.id, created_by: admin.id });
  const {
    rows: [event],
  } = await db.query("SELECT actor_type,connection_id FROM audit_outbox WHERE action='revision.saved' AND target_id=$1", [saved.json().revisionId]);
  assert.equal(event.actor_type, "agent");
  assert.ok(event.connection_id);
  const mine = (await session(admin, "GET", "/api/agent-connections")).json();
  assert.ok(!JSON.stringify(mine).includes(servicePrincipal.id));
  assert.ok(!mine.some((connection: any) => connection.name === "Рабочий"));
  // The responsible person cannot revoke it through the people's route either.
  const {
    rows: [row],
  } = await db.query("SELECT id FROM agent_connections WHERE service_principal_id=$1", [servicePrincipal.id]);
  const csrf = (await session(admin, "POST", "/api/agent-connections/csrf", {})).json().csrfToken;
  const revoke = await app.inject({
    method: "POST",
    url: `/api/agent-connections/${row.id}/revoke`,
    remoteAddress: address(),
    headers: { origin, cookie: admin.cookie, "x-polka-shelf": shelf.id, "x-polka-csrf": csrf },
  });
  assert.equal(revoke.statusCode, 404, "a service token is not on the people's list");
  assert.equal((await api(token, "GET", "/api/v1/works")).statusCode, 200);
});

test("task tokens: a subset of scopes, 5–60 minutes, stop with the parent, mint nothing", async () => {
  const madeTask = await create(admin, { name: "Задачи", scopes: ["context", "read", "capture"] });
  assert.equal(madeTask.statusCode, 200, madeTask.body);
  const { token, servicePrincipal } = madeTask.json();
  assert.equal((await api(token, "POST", "/api/v1/task-token", { minutes: 3 })).statusCode, 400);
  assert.equal((await api(token, "POST", "/api/v1/task-token", { minutes: 61 })).statusCode, 400);
  assert.equal((await api(token, "POST", "/api/v1/task-token", { scopes: ["share"] })).statusCode, 403);
  const issued = await api(token, "POST", "/api/v1/task-token", { scopes: ["read"], minutes: 10, taskId: "nightly-42" });
  assert.equal(issued.statusCode, 200, issued.body);
  const task = issued.json();
  assert.deepEqual(task.scopes, ["context", "read"]);
  assert.equal(task.taskId, "nightly-42");
  assert.equal((await api(task.token, "GET", "/api/v1/works")).statusCode, 200);
  assert.ok([403, 404].includes((await publish(task.token, "Нельзя")).statusCode));
  assert.equal((await api(task.token, "POST", "/api/v1/task-token", {})).statusCode, 403);
  const {
    rows: [audit],
  } = await db.query("SELECT payload FROM audit_outbox WHERE action='service_account.task_token' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.payload.taskId, "nightly-42");
  assert.equal(audit.payload.servicePrincipalId, servicePrincipal.id);
  // A person's token cannot ask for one.
  assert.equal((await api(await humanToken(admin, ["context", "read"]), "POST", "/api/v1/task-token", {})).statusCode, 403);
  // Disabling the account ends the parent and the child.
  assert.equal((await session(admin, "POST", `/api/service-accounts/${servicePrincipal.id}/disable`)).statusCode, 200);
  assert.equal((await api(token, "GET", "/api/v1/works")).statusCode, 401);
  assert.equal((await api(task.token, "GET", "/api/v1/works")).statusCode, 401);
});

test("rotating a token ends the old one", async () => {
  const { token, servicePrincipal } = (await create(admin, { name: "Ротация", scopes: ["context", "read"] })).json();
  const rotated = await session(admin, "POST", `/api/service-accounts/${servicePrincipal.id}/rotate`, { ttlDays: 10 });
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal((await api(token, "GET", "/api/v1/works")).statusCode, 401);
  assert.equal((await api(rotated.json().token, "GET", "/api/v1/works")).statusCode, 200);
  // The connection row stays the same: what an extension keeps per connection (a folder limit) is not lost.
  const rows = (await db.query("SELECT id,revoked_at FROM agent_connections WHERE service_principal_id=$1", [servicePrincipal.id])).rows;
  assert.equal(rows.length, 1, "rotation reuses the connection, it does not add one");
  assert.equal(rows[0].revoked_at, null);
  const rootId = rows[0].id;
  // A task token of the old secret dies with the rotation.
  const again = await session(admin, "POST", `/api/service-accounts/${servicePrincipal.id}/rotate`, { ttlDays: 5 });
  assert.equal(again.statusCode, 200, again.body);
  const after = (await db.query("SELECT id FROM agent_connections WHERE service_principal_id=$1 AND parent_id IS NULL", [servicePrincipal.id])).rows;
  assert.deepEqual(after.map((row) => row.id), [rootId]);
});

test("the responsible person leaves: the account freezes; an admin names another and it thaws", async () => {
  const made = (await create(curator, { name: "Под куратором", scopes: ["context", "read"] })).json();
  const token = made.token as string;
  const id = made.servicePrincipal.id as string;
  assert.equal((await api(token, "GET", "/api/v1/works")).statusCode, 200);
  const removed = await app.inject({
    method: "POST",
    url: `/api/shelves/${shelf.id}/members/${curator.id}/revoke`,
    headers: { origin, cookie: admin.cookie },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const {
    rows: [frozen],
  } = await db.query("SELECT status,frozen_at FROM service_principals WHERE id=$1", [id]);
  assert.equal(frozen.status, "frozen");
  assert.ok(frozen.frozen_at);
  assert.equal((await api(token, "GET", "/api/v1/works")).statusCode, 401);
  // Not revoked: the person's own agents are, the service token is kept for the next owner.
  const {
    rows: [connection],
  } = await db.query("SELECT revoked_at FROM agent_connections WHERE service_principal_id=$1", [id]);
  assert.equal(connection.revoked_at, null);
  // Only a curator or admin of the shelf may take it over; a stranger cannot.
  const stranger = await account("svc-stranger");
  assert.equal((await session(admin, "PUT", `/api/service-accounts/${id}/responsible`, { accountId: stranger.id })).statusCode, 422);
  const thawed = await session(admin, "PUT", `/api/service-accounts/${id}/responsible`, { accountId: admin.id });
  assert.equal(thawed.statusCode, 200, thawed.body);
  // The departed person's copy of the token stays dead; the new responsible gets a fresh one.
  assert.equal((await api(token, "GET", "/api/v1/works")).statusCode, 401);
  assert.equal((await api(thawed.json().token, "GET", "/api/v1/works")).statusCode, 200);
  const {
    rows: [after],
  } = await db.query("SELECT status,frozen_at,responsible_account_id FROM service_principals WHERE id=$1", [id]);
  assert.deepEqual([after.status, after.frozen_at, after.responsible_account_id], ["active", null, admin.id]);
  const reused = (await db.query("SELECT id FROM agent_connections WHERE service_principal_id=$1 AND parent_id IS NULL", [id])).rows;
  assert.equal(reused.length, 1, "a new responsible person reuses the connection row");
});

test("a service account moves a link only when it is set to follow new versions", async () => {
  const humanTok = await humanToken(admin, ["context", "capture", "revise", "share"]);
  const first = (await publish(humanTok, "Отчёт со ссылкой")).json();
  assert.equal(first.state, "shared", JSON.stringify(first));
  const { token } = (await create(admin, { name: "Ночная правка", scopes: ["context", "capture", "revise", "share"] })).json();
  const next = (extra: object = {}) =>
    publish(token, "Отчёт со ссылкой", { artifactId: first.artifactId, baseRevisionId: first.revisionId, ...extra });
  const pinned = await next();
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.equal(pinned.json().state, "saved");
  assert.match(pinned.json().linkUnavailableReason, /pinned|закреп|link/i);
  const {
    rows: [share],
  } = await db.query("SELECT id,revision_id FROM shares WHERE artifact_id=$1 AND NOT revoked", [first.artifactId]);
  assert.equal(share.revision_id, first.revisionId, "the link stayed on its version");
  // The explicit move (polka_share moveShareId) is held back the same way.
  const serviceActor = await authenticateServiceToken(token, MCP_AUDIENCE);
  await assert.rejects(
    moveShareFromAgent(serviceActor, {
      key: randomUUID(),
      artifactId: first.artifactId,
      shareId: share.id,
      expectedRevisionId: pinned.json().revisionId,
    }),
    { status: 409 },
  );
  assert.equal((await session(admin, "PUT", `/api/shares/${share.id}/follow`, { followMode: "follows" })).statusCode, 200);
  const latest = pinned.json().revisionId;
  const followed = await publish(token, "Отчёт со ссылкой", { artifactId: first.artifactId, baseRevisionId: latest });
  assert.equal(followed.statusCode, 200, followed.body);
  assert.equal(followed.json().linkMoved, true);
  const {
    rows: [moved],
  } = await db.query("SELECT revision_id FROM shares WHERE id=$1", [share.id]);
  assert.equal(moved.revision_id, followed.json().revisionId);
});

test("rotation is the responsible person's or an admin's; personal shelves have none; task tokens are capped", async () => {
  const owner = await account("svc-owner");
  const other = await account("svc-other");
  for (const who of [owner, other])
    assert.equal((await app.inject({ method: "POST", url: `/api/shelves/${shelf.id}/members`, headers: { origin, cookie: admin.cookie }, payload: { who: who.name, role: "curator" } })).statusCode, 200);
  const made = (await create(owner, { name: "Ротация куратора", scopes: ["context", "read"] })).json();
  const id = made.servicePrincipal.id as string;
  // Another curator (not responsible, not admin) cannot rotate.
  assert.equal((await session(other, "POST", `/api/service-accounts/${id}/rotate`, {})).statusCode, 403);
  assert.equal((await session(owner, "POST", `/api/service-accounts/${id}/rotate`, {})).statusCode, 200);
  assert.equal((await session(admin, "POST", `/api/service-accounts/${id}/rotate`, {})).statusCode, 200);
  // On one's own shelf: refused (a merge would orphan the token).
  const personal = await app.inject({
    method: "POST",
    url: "/api/service-accounts",
    headers: { origin, cookie: admin.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name: "Личный" }),
  });
  assert.equal(personal.statusCode, 422, personal.body);
  // Task tokens: no more than 20 live at once.
  const { token } = (await create(admin, { name: "Много задач", scopes: ["context", "read"] })).json();
  for (let n = 0; n < 20; n++) assert.equal((await api(token, "POST", "/api/v1/task-token", { minutes: 5 })).statusCode, 200);
  assert.equal((await api(token, "POST", "/api/v1/task-token", { minutes: 5 })).statusCode, 413);
});

test("erasing the responsible account freezes the service account and ends its token", async () => {
  const person = await account("svc-erased");
  assert.equal((await app.inject({ method: "POST", url: `/api/shelves/${shelf.id}/members`, headers: { origin, cookie: admin.cookie }, payload: { who: person.name, role: "curator" } })).statusCode, 200);
  const made = (await create(person, { name: "Стирание", scopes: ["context", "read"] })).json();
  assert.equal((await api(made.token, "GET", "/api/v1/works")).statusCode, 200);
  // The erasure renames the account (030); its trigger acts on the department rows.
  await db.query("UPDATE accounts SET name='deleted-'||id::text WHERE id=$1", [person.id]);
  const {
    rows: [row],
  } = await db.query("SELECT status FROM service_principals WHERE id=$1", [made.servicePrincipal.id]);
  assert.equal(row.status, "frozen");
  assert.equal((await api(made.token, "GET", "/api/v1/works")).statusCode, 401);
  const listed = (await session(admin, "GET", "/api/service-accounts")).json();
  assert.equal(listed.items.find((item: any) => item.id === made.servicePrincipal.id).status, "frozen");
  // An admin names another person and a fresh token comes back.
  const thawed = await session(admin, "PUT", `/api/service-accounts/${made.servicePrincipal.id}/responsible`, { accountId: admin.id });
  assert.equal(thawed.statusCode, 200, thawed.body);
  assert.equal((await api(thawed.json().token, "GET", "/api/v1/works")).statusCode, 200);
});

test("erasing an account clears its shelf card and its mark as a work's owner (migration 060)", async () => {
  const person = await account("svc-erase-marks");
  assert.equal((await app.inject({ method: "POST", url: `/api/shelves/${shelf.id}/members`, headers: { origin, cookie: admin.cookie }, payload: { who: person.name, role: "curator" } })).statusCode, 200);
  const token = (await create(admin, { name: "Для стирания меток", scopes: ["context", "capture"] })).json().token as string;
  const saved = (await publish(token, "Работа с ответственным")).json();
  await db.query("UPDATE artifacts SET owner_account_id=$2 WHERE id=$1", [saved.artifactId, person.id]);
  await db.query("UPDATE tenants SET card_md='Мои правила' WHERE id=$1", [person.tenant]);
  await db.query("INSERT INTO agent_read_days(tenant_id,day,principal_type,reads) VALUES($1,current_date,'human',3)", [person.tenant]);
  await db.query("UPDATE accounts SET name='deleted-'||id::text WHERE id=$1", [person.id]);
  const {
    rows: [work],
  } = await db.query("SELECT owner_account_id FROM artifacts WHERE id=$1", [saved.artifactId]);
  const {
    rows: [tenant],
  } = await db.query("SELECT card_md FROM tenants WHERE id=$1", [person.tenant]);
  assert.equal(work.owner_account_id, null);
  assert.equal(tenant.card_md, null);
  const counts = await db.query("SELECT 1 FROM agent_read_days WHERE tenant_id=$1", [person.tenant]);
  assert.equal(counts.rowCount, 0, "read counts of an erased person's shelf are gone");
});

test("the events feed and the works list carry metadata only: no bytes, no payload", async () => {
  const token = (await create(admin, { name: "Только метаданные", scopes: ["context", "read", "capture"] })).json().token as string;
  const tail = (await api(token, "GET", "/api/v1/events")).json();
  const saved = (await publish(token, "Метаданные")).json();
  let events: any[] = [];
  for (let tries = 0; tries < 60 && !events.length; tries++) {
    events = (await api(token, "GET", `/api/v1/events?after=${encodeURIComponent(tail.nextCursor)}`)).json().events;
    if (!events.length) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(events.length);
  const allowed = new Set(["id", "action", "artifactId", "revisionId", "actorType", "at"]);
  for (const event of events) for (const key of Object.keys(event)) assert.ok(allowed.has(key), `unexpected event field ${key}`);
  const body = (await api(token, "GET", `/api/v1/works?query=Метаданные`)).body;
  for (const forbidden of ["bytes", "html", "data", "payload", "objectKey", "object_key", "/s#"])
    assert.ok(!body.includes(`"${forbidden}"`) && !body.includes(forbidden === "/s#" ? forbidden : `"${forbidden}":`), `works list shows ${forbidden}`);
  assert.ok(saved.artifactId);
});
