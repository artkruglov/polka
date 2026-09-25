// Department shelves, stage 4 (docs/specs/TEAM_SHELVES.md): the company
// admin sees every department shelf and takes a leaving employee off all of
// them at once; the works stay, the agents there stop, and no shelf is left
// without an admin.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string };
let boss: Account, lead: Account, employee: Account, other: Account;

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

const call = (method: any, url: string, who: Account, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie }, payload: payload as any });

async function shelf(owner: Account, name: string, members: [Account, string][]) {
  const created = await call("POST", "/api/shelves", owner, { name });
  assert.equal(created.statusCode, 200, created.body);
  for (const [who, role] of members) {
    const added = await call("POST", `/api/shelves/${created.json().id}/members`, owner, { who: who.name, role });
    assert.equal(added.statusCode, 200, added.body);
  }
  return created.json() as { id: string; name: string };
}

before(async () => {
  config.TEAM_SHELVES = "on";
  boss = await account("company-boss");
  lead = await account("company-lead");
  employee = await account("company-employee");
  other = await account("company-other");
  await db.query("UPDATE accounts SET company_admin=true WHERE id=ANY($1::uuid[])", [[boss.id, lead.id]]);
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("only a company admin opens the page", async () => {
  assert.equal((await call("GET", "/api/company/shelves", other)).statusCode, 404);
  assert.equal((await call("GET", `/api/company/people?who=${other.name}`, other)).statusCode, 404);
  config.TEAM_SHELVES = "off";
  try {
    assert.equal((await call("GET", "/api/company/shelves", boss)).statusCode, 404);
  } finally {
    config.TEAM_SHELVES = "on";
  }
});

test("a leaving employee goes off every department shelf; works stay, agents stop, admins remain", async () => {
  // The employee is the only admin of one shelf (the lead made it and left
  // it to them) and an author on another.
  const sales = await shelf(lead, "Продажи", [[employee, "admin"]]);
  await call("POST", `/api/shelves/${sales.id}/members/${lead.id}/revoke`, lead);
  const legal = await shelf(boss, "Юристы", [[employee, "author"], [other, "reader"]]);
  const work = await db.query(
    "INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,'Договоры') RETURNING id",
    [randomUUID(), legal.id],
  );
  assert.equal(work.rowCount, 1);
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'Claude Code',ARRAY['context','capture'],$5,now()+interval '1 day')`,
    [randomUUID(), legal.id, employee.id, sha256(secret), MCP_AUDIENCE],
  );

  const listed = (await call("GET", "/api/company/shelves", boss)).json().items;
  const names = listed.map((item: any) => item.name);
  assert.ok(names.includes("Продажи") && names.includes("Юристы"));
  const members = (await call("GET", `/api/company/shelves/${legal.id}/members`, boss)).json().items;
  assert.equal(members.length, 3);

  const found = (await call("GET", `/api/company/people?who=${encodeURIComponent(employee.name.toUpperCase())}`, boss)).json();
  assert.deepEqual(found.shelves.map((item: any) => [item.name, item.role]).sort(), [["Продажи", "admin"], ["Юристы", "author"]]);
  assert.equal(found.teamAgents, 1);

  const self = await call("POST", `/api/company/people/${boss.id}/offboard`, boss);
  assert.equal(self.statusCode, 409, self.body);
  const refused = await call("POST", `/api/company/people/${employee.id}/offboard`, other);
  assert.equal(refused.statusCode, 404);

  const done = await call("POST", `/api/company/people/${employee.id}/offboard`, boss);
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json().removed.map((item: any) => item.name).sort(), ["Продажи", "Юристы"]);
  // Off both shelves; their agents there are revoked.
  assert.equal((await db.query(
    "SELECT 1 FROM tenant_members WHERE account_id=$1 AND state='active' AND role<>'owner'",
    [employee.id],
  )).rowCount, 0);
  const { rows: [agent] } = await db.query("SELECT revoked_at FROM agent_connections WHERE token_hash=$1", [sha256(secret)]);
  assert.ok(agent.revoked_at);
  // The shelf that had no other admin now has the company admin.
  const { rows: [salesAdmin] } = await db.query(
    "SELECT role,state FROM tenant_members WHERE tenant_id=$1 AND account_id=$2",
    [sales.id, boss.id],
  );
  assert.deepEqual(salesAdmin, { role: "admin", state: "active" });
  // Works (here a folder) stay with the shelf; the personal shelf stays.
  assert.equal((await db.query("SELECT 1 FROM folders WHERE tenant_id=$1", [legal.id])).rowCount, 1);
  assert.equal((await call("GET", "/api/artifacts", employee)).statusCode, 200);
  // Once more: nothing left to remove.
  assert.deepEqual((await call("POST", `/api/company/people/${employee.id}/offboard`, boss)).json().removed, []);
  const events = await db.query(
    "SELECT action FROM tenant_member_events WHERE tenant_id=$1 ORDER BY id",
    [sales.id],
  );
  assert.deepEqual(events.rows.map((row) => row.action).slice(-2), ["member_added", "member_revoked"]);
});

test("a company admin takes over a shelf left without an admin", async () => {
  const design = await shelf(lead, "Дизайн", [[other, "author"]]);
  // Its admin left through the SSO: the membership was revoked by deletion.
  await db.query(
    "UPDATE tenant_members SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND account_id=$2",
    [design.id, lead.id],
  );
  const row = (await call("GET", "/api/company/shelves", boss)).json().items.find((item: any) => item.id === design.id);
  assert.deepEqual(row.admins, []);
  const taken = await call("POST", `/api/company/shelves/${design.id}/admin`, boss);
  assert.equal(taken.statusCode, 200, taken.body);
  const again = (await call("GET", "/api/company/shelves", boss)).json().items.find((item: any) => item.id === design.id);
  assert.equal(again.admins.length, 1);
});
