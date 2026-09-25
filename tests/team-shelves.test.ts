// Department shelves, stage 1 (docs/specs/TEAM_SHELVES.md): every personal
// shelf has its owner as a member, a company admin opens a department shelf
// while TEAM_SHELVES is on, a request follows X-Polka-Shelf only to a shelf
// the account is an active member of, and roles are checked by lockShelf.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount, identity } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { lockShelf } from "../apps/server/shelves.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
let admin: Awaited<ReturnType<typeof createAccount>>;
let member: Awaited<ReturnType<typeof createAccount>>;
let stranger: Awaited<ReturnType<typeof createAccount>>;
const sessions = new Map<string, string>();

async function login(name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.cookies[0].value as string;
}

const call = (method: any, url: string, account: { name: string }, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { origin, cookie: `polka_session=${sessions.get(account.name)}` },
    payload: body as any,
  });

const notFound = (error: any) => error.status === 404;

// identity() as a shelf route calls it: the session cookie and the header.
const asRequest = (account: { name: string }, shelf?: string) =>
  ({
    cookies: { polka_session: sessions.get(account.name) },
    headers: shelf ? { "x-polka-shelf": shelf } : {},
  }) as any;

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  admin = await createAccount(`team-admin-${suffix}`, password);
  member = await createAccount(`team-member-${suffix}`, password);
  stranger = await createAccount(`team-stranger-${suffix}`, password);
  for (const account of [admin, member, stranger])
    sessions.set(account.name, await login(account.name));
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("a new personal shelf has its owner as its one member", async () => {
  const { rows } = await db.query(
    "SELECT account_id,role,state FROM tenant_members WHERE tenant_id=$1",
    [admin.tenant],
  );
  assert.deepEqual(rows, [{ account_id: admin.id, role: "owner", state: "active" }]);
  const missingOwners = await db.query(
    `SELECT t.id FROM tenants t WHERE t.kind='personal' AND NOT EXISTS (
       SELECT 1 FROM tenant_members m WHERE m.tenant_id=t.id AND m.account_id=t.owner_id AND m.role='owner')`,
  );
  assert.equal(missingOwners.rowCount, 0);
});

test("with TEAM_SHELVES off: only the personal shelf, no department shelves", async () => {
  config.TEAM_SHELVES = "off";
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  const created = await call("POST", "/api/shelves", admin, { name: "Отдел продаж" });
  assert.equal(created.statusCode, 404, created.body);
  const listed = await call("GET", "/api/shelves", admin);
  assert.deepEqual(
    listed.json().items.map((shelf: any) => [shelf.kind, shelf.role]),
    [["personal", "owner"]],
  );
});

test("a company admin opens a department shelf; others may not", async () => {
  config.TEAM_SHELVES = "on";
  const refused = await call("POST", "/api/shelves", member, { name: "Отдел продаж" });
  assert.equal(refused.statusCode, 403, refused.body);
  const created = await call("POST", "/api/shelves", admin, { name: "  Отдел продаж  " });
  assert.equal(created.statusCode, 200, created.body);
  const shelf = created.json();
  assert.equal(shelf.name, "Отдел продаж");
  assert.equal(shelf.role, "admin");
  const { rows: [row] } = await db.query(
    "SELECT kind,owner_id,created_by FROM tenants WHERE id=$1",
    [shelf.id],
  );
  assert.deepEqual(row, { kind: "team", owner_id: null, created_by: admin.id });
  const events = await db.query(
    "SELECT action,new_role FROM tenant_member_events WHERE tenant_id=$1",
    [shelf.id],
  );
  assert.deepEqual(events.rows, [{ action: "shelf_created", new_role: "admin" }]);
  const listed = (await call("GET", "/api/shelves", admin)).json().items;
  assert.deepEqual(
    listed.map((item: any) => [item.kind, item.role]),
    [["personal", "owner"], ["team", "admin"]],
  );
});

test("a request follows X-Polka-Shelf only to a shelf the account is a member of", async () => {
  config.TEAM_SHELVES = "on";
  const shelf = (await call("POST", "/api/shelves", admin, { name: "Аналитика" })).json();
  await db.query(
    "INSERT INTO tenant_members(tenant_id,account_id,role,invited_by) VALUES($1,$2,'reader',$3)",
    [shelf.id, member.id, admin.id],
  );
  // Without the option (account-level routes) the header is ignored.
  const personal = await identity(asRequest(member, shelf.id));
  assert.equal(personal.tenant, member.tenant);
  assert.equal(personal.role, "owner");
  const onShelf = await identity(asRequest(member, shelf.id), { shelf: true });
  assert.equal(onShelf.tenant, shelf.id);
  assert.equal(onShelf.role, "reader");
  // Not a member, a malformed id, someone else's personal shelf: not found.
  for (const [account, header] of [
    [stranger, shelf.id],
    [member, "not-a-uuid"],
    [member, admin.tenant],
  ] as const)
    await assert.rejects(identity(asRequest(account, header), { shelf: true }), notFound);
  // A revoked member is out; so is everyone while TEAM_SHELVES is off.
  config.TEAM_SHELVES = "off";
  await assert.rejects(identity(asRequest(admin, shelf.id), { shelf: true }), notFound);
  config.TEAM_SHELVES = "on";
  await db.query(
    "UPDATE tenant_members SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND account_id=$2",
    [shelf.id, member.id],
  );
  await assert.rejects(identity(asRequest(member, shelf.id), { shelf: true }), notFound);
});

test("lockShelf checks the role; a personal shelf's owner passes any", async () => {
  config.TEAM_SHELVES = "on";
  const shelf = (await call("POST", "/api/shelves", admin, { name: "Маркетинг" })).json();
  await db.query(
    "INSERT INTO tenant_members(tenant_id,account_id,role,invited_by) VALUES($1,$2,'reader',$3)",
    [shelf.id, member.id, admin.id],
  );
  const lock = (actor: { id: string; tenant: string }, role: any) =>
    transaction((c) => lockShelf(c, actor, role));
  assert.equal((await lock({ id: member.id, tenant: shelf.id }, "reader")).role, "reader");
  await assert.rejects(lock({ id: member.id, tenant: shelf.id }, "author"), (error: any) => error.status === 403);
  await assert.rejects(lock({ id: stranger.id, tenant: shelf.id }, "reader"), notFound);
  assert.equal((await lock({ id: admin.id, tenant: shelf.id }, "curator")).role, "admin");
  assert.equal((await lock({ id: member.id, tenant: member.tenant }, "admin")).role, "owner");
});

test("the schema keeps owners and department shelves apart", async () => {
  await assert.rejects(
    db.query(
      "INSERT INTO tenants(id,owner_id,kind,name) VALUES($1,$2,'team','Лишний владелец')",
      [randomUUID(), stranger.id],
    ),
  );
  await assert.rejects(
    db.query("INSERT INTO tenants(id,owner_id,kind) VALUES($1,NULL,'personal')", [randomUUID()]),
  );
  const shelf = (await call("POST", "/api/shelves", admin, { name: "Юристы" })).json();
  await assert.rejects(
    db.query(
      "INSERT INTO tenant_members(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [shelf.id, stranger.id],
    ),
    /owner role/,
  );
});
