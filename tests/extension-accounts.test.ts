// An extension's own sign-in and provisioning (docs/specs/EXTENSIONS.md,
// context.accounts, context.teamShelves, signInPaths, signInMethods and
// policies.signIn): what an enterprise SSO (SAML) and directory (SCIM) need,
// with no protocol of either in the core. The test extension posts to its
// sign-in path from a foreign origin, provisions people, puts them on a
// department shelf, deprovisions them and refuses the core's own sign-in for
// one domain.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { ExtensionContext, PolkaEvent, PolkaExtension } from "../packages/extension-api/index.ts";
import { loadExtensions, useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";

const events: PolkaEvent[] = [];
let context: ExtensionContext;
const domain = `sso-${randomBytes(4).toString("hex")}.test`;
const extension: PolkaExtension = {
  name: "sso",
  signInPaths: ["/api/ext/sso/acs"],
  machinePaths: ["/api/ext/sso/scim/*"],
  signInMethods: () => [
    { id: "acme", name: "Войти через SSO компании", start: "/api/ext/sso/start?connection=acme" },
    { id: "BAD ID", name: "x", start: "/api/ext/sso/start" },
    { id: "elsewhere", name: "x", start: "/api/ext/other/start" },
  ],
  register(app, ctx) {
    context = ctx;
    // Stands in for a verified SAML answer: the assertion names an address.
    app.post("/api/ext/sso/acs", async (req, reply) => {
      const { email } = req.body as { email: string };
      const { account } = await ctx.accounts.provision({ email, name: "Иван Петров" });
      await ctx.accounts.startSession(reply, account.id);
      return reply.redirect("/", 303);
    });
    app.get("/api/ext/sso/acs", async (req) => ({ name: (await ctx.identity(req)).name }));
    app.post("/api/ext/sso/scim/Users/:id", async (req) => ({ id: (req.params as { id: string }).id }));
    app.post("/api/ext/sso/scimx/Users/:id", async () => ({ ok: true }));
    app.post("/api/ext/sso/settings", async () => ({ ok: true }));
  },
  policies: {
    async signIn(attempt) {
      return attempt.email?.endsWith(`@${domain}`)
        ? { allow: false, message: "Для этой почты вход только через SSO компании." }
        : { allow: true };
    },
  },
  onEvent(event) {
    events.push(event);
  },
};
useExtensions([extension]);
const teamShelves = config.TEAM_SHELVES;
config.TEAM_SHELVES = "on";
const { createApp } = await import("../apps/server/app.ts");
const app = await createApp();
const origin = config.APP_ORIGIN;

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  useExtensions([]);
  await app.close();
  await db.end();
  s3.destroy();
});

const me = (cookie: string) =>
  app.inject({ method: "GET", url: "/api/me", headers: { cookie } }).then((res) => res.statusCode);

test("an identity provider's post signs the person in with the core's session; no cookie identity there", async () => {
  const email = `ivan@${domain}`;
  const posted = await app.inject({
    method: "POST",
    url: "/api/ext/sso/acs",
    headers: { origin: "https://idp.example.com" },
    payload: { email },
  });
  assert.equal(posted.statusCode, 303, posted.body);
  const session = posted.cookies.find((cookie) => cookie.name === "polka_session");
  assert.ok(session, "a session cookie");
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, "Strict");
  const cookie = `polka_session=${session.value}`;
  assert.equal(await me(cookie), 200);
  // The sign-in path has no Origin rule, so it never reads the cookie.
  const identity = await app.inject({ method: "GET", url: "/api/ext/sso/acs", headers: { cookie } });
  assert.equal(identity.statusCode, 403);
  const account = await context.accounts.findByEmail(email.toUpperCase());
  assert.equal(account?.name, "Иван Петров");
  assert.match(account!.login, /^sso-/);
  assert.equal(account?.state, "active");
  assert.ok(account?.personalShelfId);
  // The same address again: the same account.
  const again = await context.accounts.provision({ email });
  assert.equal(again.created, false);
  assert.equal(again.account.id, account!.id);
});

test("a machine prefix covers the paths below it, and nothing else", async () => {
  const scim = await app.inject({ method: "POST", url: "/api/ext/sso/scim/Users/42", payload: {} });
  assert.equal(scim.statusCode, 200, scim.body);
  assert.equal(scim.json().id, "42");
  const outside = await app.inject({ method: "POST", url: "/api/ext/sso/scimx/Users/42", payload: {} });
  assert.equal(outside.statusCode, 403);
  // The extension's other POST routes keep the Origin rule.
  const foreign = await app.inject({
    method: "POST",
    url: "/api/ext/sso/settings",
    headers: { origin: "https://idp.example.com" },
    payload: {},
  });
  assert.equal(foreign.statusCode, 403);
});

test("the sign-in buttons are offered in capabilities; malformed ones are left out", async () => {
  const capabilities = (await app.inject({ method: "GET", url: "/api/capabilities" })).json();
  assert.deepEqual(capabilities.extensionSignIn, [
    { id: "acme", name: "Войти через SSO компании", start: "/api/ext/sso/start?connection=acme" },
  ]);
});

test("the extension's sign-in policy refuses the core's code and password for its domain", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/api/auth/email/start",
    headers: { origin },
    payload: { email: `anna@${domain}` },
  });
  assert.equal(start.statusCode, 403, start.body);
  assert.equal(start.json().reason, "sign_in_policy");
  assert.match(start.json().message, /только через SSO/);
  const outside = await app.inject({
    method: "POST",
    url: "/api/auth/email/start",
    headers: { origin },
    payload: { email: `anna-${randomBytes(3).toString("hex")}@elsewhere.test` },
  });
  assert.equal(outside.statusCode, 200, outside.body);

  const password = randomBytes(16).toString("hex");
  const local = await createAccount(`sso-pw-${randomBytes(4).toString("hex")}`, password);
  await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [
    local.id,
    `pw-${randomBytes(3).toString("hex")}@${domain}`,
  ]);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: local.name, password },
  });
  assert.equal(login.statusCode, 403, login.body);
  assert.equal(login.json().reason, "sign_in_policy");
});

test("a directory provisions people onto a department shelf, then deprovisions one", async () => {
  const anna = (await context.accounts.provision({ email: `anna-${randomBytes(3).toString("hex")}@corp.test` }))
    .account;
  const boris = (await context.accounts.provision({ email: `boris-${randomBytes(3).toString("hex")}@corp.test` }))
    .account;
  const shelf = await context.teamShelves.create("Продажи");
  assert.deepEqual(await context.teamShelves.get(shelf.id), shelf);
  assert.ok((await context.teamShelves.list()).some((item) => item.id === shelf.id));
  assert.equal((await context.teamShelves.setMember(shelf.id, anna.id, "admin")).added, true);
  assert.equal((await context.teamShelves.setMember(shelf.id, boris.id, "author")).added, true);
  assert.equal((await context.teamShelves.setMember(shelf.id, boris.id, "curator")).added, false);
  assert.deepEqual(
    (await context.teamShelves.members(shelf.id)).sort((a, b) => a.accountId.localeCompare(b.accountId)),
    [
      { accountId: anna.id, role: "admin" },
      { accountId: boris.id, role: "curator" },
    ].sort((a, b) => a.accountId.localeCompare(b.accountId)),
  );
  assert.equal((await context.teamShelves.rename(shelf.id, "Продажи и маркетинг")).name, "Продажи и маркетинг");
  const { rows: journal } = await db.query(
    "SELECT action,actor_id FROM tenant_member_events WHERE tenant_id=$1 ORDER BY id",
    [shelf.id],
  );
  assert.deepEqual(
    journal.map((row) => row.action),
    ["shelf_created", "member_added", "member_added", "member_role_changed", "shelf_renamed"],
  );
  assert.ok(journal.every((row) => row.actor_id === null));

  const updated = await context.accounts.update(boris.id, { name: "Борис Иванов" });
  assert.equal(updated.name, "Борис Иванов");
  const taken = await context.accounts.update(boris.id, { email: anna.email! }).catch((error) => error);
  assert.equal(taken.status, 409);

  // Boris signs in, then leaves the company.
  const posted = await app.inject({
    method: "POST",
    url: "/api/ext/sso/acs",
    headers: { origin: "https://idp.example.com" },
    payload: { email: boris.email },
  });
  const cookie = `polka_session=${posted.cookies.find((c) => c.name === "polka_session")!.value}`;
  assert.equal(await me(cookie), 200);
  const gone = await context.accounts.deprovision(boris.id, { reason: "scim: active=false" });
  assert.equal(gone.state, "deprovisioned");
  assert.equal(gone.sessions, 1);
  assert.deepEqual(gone.shelves, [shelf.id]);
  assert.equal(await me(cookie), 401);
  assert.equal((await context.accounts.get(boris.id))?.state, "disabled");
  assert.deepEqual(await context.teamShelves.members(shelf.id), [{ accountId: anna.id, role: "admin" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((e) => e.type === "member.revoked" && e.accountId === boris.id && e.tenantId === shelf.id));
  assert.equal((await context.accounts.deprovision(boris.id)).state, "already");
  // A disabled account cannot sign in or join a shelf.
  const refused = await app.inject({
    method: "POST",
    url: "/api/ext/sso/acs",
    headers: { origin: "https://idp.example.com" },
    payload: { email: boris.email },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal((await context.teamShelves.setMember(shelf.id, boris.id, "reader").catch((e) => e)).status, 409);
  const { rows: audit } = await db.query(
    "SELECT action FROM audit_outbox WHERE target_id=$1 AND action LIKE 'account.%' ORDER BY id",
    [boris.id],
  );
  assert.deepEqual(
    audit.map((row) => row.action),
    ["account.deprovisioned"],
  );

  // Back from the directory: active again, shelves are the directory's to give.
  assert.equal((await context.accounts.reactivate(boris.id)).state, "active");
  assert.deepEqual(await context.teamShelves.members(shelf.id), [{ accountId: anna.id, role: "admin" }]);

  // The last admin leaves too: the directory decides.
  assert.deepEqual(await context.teamShelves.removeMember(shelf.id, anna.id), { removed: true });
  assert.deepEqual(await context.teamShelves.removeMember(shelf.id, anna.id), { removed: false });
});

test("an account the operator disabled stays disabled", async () => {
  const carl = (await context.accounts.provision({ email: `carl-${randomBytes(3).toString("hex")}@corp.test` }))
    .account;
  await context.accounts.deprovision(carl.id);
  await db.query(
    `INSERT INTO moderation_events(id,actor,action,account_id) VALUES(gen_random_uuid(),'operator-script','account.disabled',$1)`,
    [carl.id],
  );
  const refused = await context.accounts.reactivate(carl.id).catch((error) => error);
  assert.equal(refused.status, 403);
  assert.equal(refused.details.reason, "operator_disabled");
});

test("department shelves are not offered while TEAM_SHELVES is off", async () => {
  config.TEAM_SHELVES = "off";
  try {
    assert.equal((await context.teamShelves.list().catch((error) => error)).status, 404);
  } finally {
    config.TEAM_SHELVES = "on";
  }
});

test("paths outside the extension's prefix are refused at load", async () => {
  const bad = async (fields: Partial<PolkaExtension>) => {
    const { writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = `${tmpdir()}/polka-ext-${randomBytes(4).toString("hex")}.mjs`;
    await writeFile(path, `export default ${JSON.stringify({ name: "bad", ...fields })};`);
    try {
      return await loadExtensions(path).then(
        () => null,
        (error: Error) => error.message,
      );
    } finally {
      await rm(path, { force: true });
      useExtensions([extension]);
    }
  };
  assert.match((await bad({ signInPaths: ["/api/ext/other/acs"] }))!, /sign-in path/);
  assert.match((await bad({ signInPaths: ["/api/ext/bad/acs/*"] }))!, /sign-in path/);
  assert.match((await bad({ machinePaths: ["/api/ext/bad/*/x"] }))!, /machine path/);
  assert.equal(await bad({ machinePaths: ["/api/ext/bad/scim/v2/*"] }), null);
});
