// Organisations on a shared cloud (docs/specs/TEAM_SHELVES.md, «Организации в
// облаке», migration 070): with TEAM_SHELVES_SCOPE=organisation a company
// admin sees and changes only their organisation's shelves, people, agents'
// searches and service accounts; a shelf admin adds directly only people of
// the organisation, and the refusal never tells whether an outside address has
// an account; everyone else joins through the invitation link.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { configureOrganisation, setCompanyAdmin } from "../apps/server/organisations.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const saved = {
  TEAM_SHELVES: config.TEAM_SHELVES,
  TEAM_SHELVES_SCOPE: config.TEAM_SHELVES_SCOPE,
  SERVICE_ACCOUNTS: config.SERVICE_ACCOUNTS,
};
const tag = randomBytes(4).toString("hex");
const domainA = `a-${tag}.test`,
  domainB = `b-${tag}.test`;
const orgA = `Альфа ${tag}`,
  orgB = `Бета ${tag}`;
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string; email: string | null };
let adminA: Account, adminB: Account, colleagueA: Account, unverifiedA: Account, outsider: Account, memberB: Account;
let shelfA: string, shelfB: string;

async function account(prefix: string, email: string | null = null, verified = true): Promise<Account> {
  const created = await createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
  if (email)
    await db.query("UPDATE accounts SET email=$2,email_verified_at=CASE WHEN $3::boolean THEN now() END WHERE id=$1", [
      created.id,
      email,
      verified,
    ]);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: created.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  return { ...created, email, cookie: `polka_session=${login.cookies[0].value}` };
}

const call = (method: string, url: string, who: Account, payload?: unknown, shelf?: string) =>
  app.inject({
    method: method as "GET",
    url,
    remoteAddress: address(),
    headers: {
      origin,
      cookie: who.cookie,
      ...(shelf ? { "x-polka-shelf": shelf } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

async function newShelf(admin: Account, name: string) {
  const created = await call("POST", "/api/shelves", admin, { name });
  assert.equal(created.statusCode, 200, created.body);
  return created.json().id as string;
}

async function issueToken(who: Account, body: Record<string, unknown>) {
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

before(async () => {
  config.TEAM_SHELVES = "on";
  config.SERVICE_ACCOUNTS = "on";
  config.TEAM_SHELVES_SCOPE = "organisation";
  adminA = await account("org-admin-a", `boss@${domainA}`);
  adminB = await account("org-admin-b", `boss@${domainB}`);
  colleagueA = await account("org-colleague-a", `colleague@${domainA}`);
  unverifiedA = await account("org-unverified-a", `claims@${domainA}`, false);
  outsider = await account("org-outsider", `someone@${domainB}`);
  memberB = await account("org-member-b", `member@${domainB}`);
  await transaction(async (c) => {
    await configureOrganisation(c, orgA, { addDomains: [domainA] });
    await configureOrganisation(c, orgB, { addDomains: [`@${domainB.toUpperCase()}`] });
    await setCompanyAdmin(c, adminA.name, { org: orgA });
    await setCompanyAdmin(c, `boss@${domainB}`, { org: orgB.toUpperCase() });
  });
  shelfA = await newShelf(adminA, "Продажи А");
  shelfB = await newShelf(adminB, "Продажи Б");
  const added = await call("POST", `/api/shelves/${shelfB}/members`, adminB, { who: memberB.name, role: "author" });
  assert.equal(added.statusCode, 200, added.body);
});

after(async () => {
  Object.assign(config, saved);
  await app.close();
  await db.end();
  s3.destroy();
});

test("the operator command: organisations by name, own domains only, --org required on a cloud", async () => {
  const {
    rows: [row],
  } = await db.query(
    `SELECT shelf.organisation_id=organisation.id AS mine FROM tenants shelf, organisations organisation
     WHERE shelf.id=$1 AND lower(organisation.name)=lower($2)`,
    [shelfA, orgA],
  );
  assert.equal(row.mine, true);
  await assert.rejects(
    transaction((c) => configureOrganisation(c, orgA, { addDomains: ["gmail.com"] })),
    /public mail service/,
  );
  await assert.rejects(
    transaction((c) => configureOrganisation(c, orgA, { addDomains: [domainB] })),
    /another organisation/,
  );
  await assert.rejects(
    transaction((c) => setCompanyAdmin(c, outsider.name, {})),
    /--org/,
  );
  // A company admin without an organisation administers nothing on a cloud.
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [outsider.id]);
  try {
    assert.equal((await call("GET", "/api/company/shelves", outsider)).statusCode, 404);
    assert.equal((await call("GET", "/api/shelves", outsider)).json().canCreate, false);
    assert.equal((await call("POST", "/api/shelves", outsider, { name: "Без организации" })).statusCode, 403);
  } finally {
    await db.query("UPDATE accounts SET company_admin=false WHERE id=$1", [outsider.id]);
  }
  const shelves = (await call("GET", "/api/shelves", outsider)).json();
  assert.equal(shelves.scope, "organisation");
  assert.ok("contact" in shelves);
});

test("organisation A's admin sees and administers only A's shelves and people", async () => {
  const listed = (await call("GET", "/api/company/shelves", adminA)).json().items.map((item: any) => item.id);
  assert.ok(listed.includes(shelfA));
  assert.ok(!listed.includes(shelfB));
  assert.equal((await call("GET", `/api/company/shelves/${shelfB}/members`, adminA)).statusCode, 404);
  assert.equal((await call("POST", `/api/company/shelves/${shelfB}/admin`, adminA, {})).statusCode, 404);
  for (const who of [memberB.name, `member@${domainB}`, adminB.name])
    assert.equal(
      (await call("GET", `/api/company/people?who=${encodeURIComponent(who)}`, adminA)).statusCode,
      404,
      who,
    );
  const offboard = await call("POST", `/api/company/people/${memberB.id}/offboard`, adminA, {});
  assert.equal(offboard.statusCode, 200, offboard.body);
  assert.deepEqual(offboard.json().removed, []);
  const { rows } = await db.query("SELECT state FROM tenant_members WHERE tenant_id=$1 AND account_id=$2", [
    shelfB,
    memberB.id,
  ]);
  assert.equal(rows[0].state, "active");
  // B's admin sees B's shelf, and A's colleague by address is A's.
  const ownB = (await call("GET", "/api/company/shelves", adminB)).json().items.map((item: any) => item.id);
  assert.deepEqual(ownB.includes(shelfB) && !ownB.includes(shelfA), true);
  const found = await call("GET", `/api/company/people?who=${encodeURIComponent(`colleague@${domainA}`)}`, adminA);
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(found.json().email, `colleague@${domainA}`);
  assert.deepEqual(found.json().shelves, []);
});

test("direct adding: only people of the organisation; the refusal tells nothing about the address", async () => {
  const add = (who: string) => call("POST", `/api/shelves/${shelfA}/members`, adminA, { who, role: "reader" });
  const ok = await add(`colleague@${domainA}`);
  assert.equal(ok.statusCode, 200, ok.body);
  const refusals = await Promise.all(
    [
      `someone@${domainB}`, // an account, of another organisation
      outsider.name, // the same account by login
      `nobody-${tag}@${domainB}`, // no account at all
      `nobody-${tag}@${domainA}`, // no account, the organisation's domain
      `claims@${domainA}`, // the organisation's domain, never verified
    ].map(add),
  );
  for (const refused of refusals) {
    assert.equal(refused.statusCode, 404, refused.body);
    assert.deepEqual(refused.json(), refusals[0].json());
  }
  assert.match(refusals[0].json().message ?? refusals[0].body, /пригласите ссылкой/);
  const members = (await call("GET", `/api/shelves/${shelfA}/members`, adminA)).json();
  assert.deepEqual(members.directAdd, { scope: "organisation", organisation: orgA, domains: [domainA] });
  assert.ok(!members.items.some((item: any) => [outsider.id, unverifiedA.id].includes(item.accountId)));
});

test("an outsider joins only through the link; the address stays hidden, then they count as the organisation's", async () => {
  const created = await call("POST", `/api/shelves/${shelfA}/invitations`, adminA, {
    role: "reader",
    expiresInHours: 24,
  });
  assert.equal(created.statusCode, 200, created.body);
  const fragment = new URLSearchParams(new URL(created.json().invitationUrl).hash.slice(1));
  const accepted = await call("POST", `/api/shelves/${shelfA}/invitations/accept`, outsider, {
    token: fragment.get("token"),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const members = (await call("GET", `/api/shelves/${shelfA}/members`, adminA)).json().items;
  const byId = new Map(members.map((item: any) => [item.accountId, item]));
  assert.equal((byId.get(outsider.id) as any)?.email, null);
  assert.equal((byId.get(colleagueA.id) as any)?.email, `colleague@${domainA}`);
  const company = (await call("GET", `/api/company/shelves/${shelfA}/members`, adminA)).json().items;
  assert.equal(company.find((item: any) => item.accountId === outsider.id)?.email, null);
  // Now a person of A (a member of its shelf): found by login, address hidden.
  const found = await call("GET", `/api/company/people?who=${encodeURIComponent(outsider.name)}`, adminA);
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(found.json().email, null);
  assert.deepEqual(
    found.json().shelves.map((item: any) => item.id),
    [shelfA],
  );
});

test("search across shelves and service accounts stay within membership", async () => {
  // memberB is on B only: a token may not search A's shelf.
  const refused = await issueToken(memberB, { scopes: ["context", "read"], allowedShelfIds: [shelfA] });
  assert.equal(refused.statusCode, 422, refused.body);
  // A service account on A's shelf is A's: B's admin cannot list or change it.
  const created = await call("POST", "/api/service-accounts", adminA, { name: "Ночной отчёт" }, shelfA);
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().servicePrincipal.id;
  assert.equal((await call("GET", "/api/service-accounts", adminB, undefined, shelfA)).statusCode, 404);
  const listedB = await call("GET", "/api/service-accounts", adminB, undefined, shelfB);
  assert.equal(listedB.statusCode, 200, listedB.body);
  assert.ok(!listedB.json().items.some((item: any) => item.id === id));
  for (const [method, path, body] of [
    ["POST", `/api/service-accounts/${id}/rotate`, {}],
    ["POST", `/api/service-accounts/${id}/disable`, undefined],
    ["PUT", `/api/service-accounts/${id}/responsible`, { accountId: adminB.id }],
  ] as const) {
    const response = await call(method, path, adminB, body, shelfB);
    assert.equal(response.statusCode, 404, `${path}: ${response.body}`);
  }
});

test("installation scope: one company, every shelf, anyone added directly (self-hosted, unchanged)", async () => {
  config.TEAM_SHELVES_SCOPE = "installation";
  try {
    const listed = (await call("GET", "/api/company/shelves", adminA)).json().items.map((item: any) => item.id);
    assert.ok(listed.includes(shelfA) && listed.includes(shelfB));
    const shelves = (await call("GET", "/api/shelves", adminA)).json();
    assert.equal(shelves.scope, undefined);
    const added = await call("POST", `/api/shelves/${shelfA}/members`, adminA, { who: memberB.name, role: "reader" });
    assert.equal(added.statusCode, 200, added.body);
    const members = (await call("GET", `/api/shelves/${shelfA}/members`, adminA)).json();
    assert.deepEqual(members.directAdd, { scope: "installation" });
    assert.equal(members.items.find((item: any) => item.accountId === outsider.id)?.email, `someone@${domainB}`);
  } finally {
    config.TEAM_SHELVES_SCOPE = "organisation";
  }
});

test("erasing an account clears its company admin role", async () => {
  const leaving = await account("org-leaving", `leaving@${domainA}`);
  await transaction((c) => setCompanyAdmin(c, leaving.name, { org: orgA }));
  await db.query("UPDATE accounts SET name='deleted-'||id::text WHERE id=$1", [leaving.id]);
  const {
    rows: [row],
  } = await db.query("SELECT company_admin,company_organisation_id FROM accounts WHERE id=$1", [leaving.id]);
  assert.deepEqual(row, { company_admin: false, company_organisation_id: null });
});
