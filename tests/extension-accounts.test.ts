// An extension's own sign-in and provisioning (docs/specs/EXTENSIONS.md,
// context.accounts, context.teamShelves, signInPaths,
// signInMethods and policies.signIn): what an enterprise SSO (SAML) and
// directory (SCIM) need, with no protocol of either in the core. Everything
// acts for one core organisation (migration 070) and stays on its domains and
// shelves; an extension's deprovision and the operator's disable are separate
// reasons (migration 072).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { ExtensionContext, PolkaEvent, PolkaExtension, SignInAttempt } from "../packages/extension-api/index.ts";
import { loadExtensions, useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { disableAccount, enableAccount } from "../apps/server/moderation.ts";
import { s3 } from "../apps/server/storage.ts";

const events: PolkaEvent[] = [];
const attempts: SignInAttempt[] = [];
let context: ExtensionContext;
const tag = randomBytes(4).toString("hex");
const domain = `corp-${tag}.test`;
const otherDomain = `other-${tag}.test`;
const extension: PolkaExtension = {
  name: "sso",
  signInPaths: ["/api/ext/sso/acs", "/api/ext/sso/acs-account"],
  machinePaths: ["/api/ext/sso/scim/*"],
  signInMethods: () => [
    { id: "acme", name: "Войти через SSO компании", start: "/api/ext/sso/start" },
    { id: "BAD ID", name: "x", start: "/api/ext/sso/start" },
    { id: "elsewhere", name: "x", start: "/api/ext/other/start" },
  ],
  register(app, ctx) {
    context = ctx;
    // Stands in for a verified SAML answer: the assertion names an address.
    app.post("/api/ext/sso/acs", async (req, reply) => {
      const { email, organisationId } = req.body as { email: string; organisationId: string };
      const { account } = await ctx.accounts.provision({ email, name: "Иван Петров", organisationId });
      await ctx.accounts.startSession(reply, account.id, { organisationId, previous: req.cookies.polka_session });
      return reply.redirect("/", 303);
    });
    // An account the extension already maps to the organisation's person.
    app.post("/api/ext/sso/acs-account", async (req, reply) => {
      const { accountId, organisationId } = req.body as { accountId: string; organisationId?: string };
      // Without an organisation: the old positional `previous` argument.
      await ctx.accounts.startSession(
        reply,
        accountId,
        (organisationId ? { organisationId } : req.cookies.polka_session) as { organisationId: string },
      );
      return reply.redirect("/", 303);
    });
    app.get("/api/ext/sso/acs", async (req) => ({ name: (await ctx.identity(req)).name }));
    app.post("/api/ext/sso/scim/Users/:id", async (req) => ({ id: (req.params as { id: string }).id }));
    app.post("/api/ext/sso/scimx/Users/:id", async () => ({ ok: true }));
    app.post("/api/ext/sso/settings", async () => ({ ok: true }));
  },
  policies: {
    async signIn(attempt) {
      attempts.push(attempt);
      return [attempt.email, attempt.accountEmail].some((address) => address?.endsWith(`@${domain}`))
        ? { allow: false, message: "Для этой почты вход только через SSO компании." }
        : { allow: true };
    },
  },
  onEvent(event) {
    events.push(event);
  },
};
useExtensions([extension]);
const saved = { teamShelves: config.TEAM_SHELVES, scope: config.TEAM_SHELVES_SCOPE };
config.TEAM_SHELVES = "on";
const { createApp } = await import("../apps/server/app.ts");
const app = await createApp();
const origin = config.APP_ORIGIN;

async function organisation(name: string, domains: string[]) {
  const {
    rows: [row],
  } = await db.query("INSERT INTO organisations(name) VALUES($1) RETURNING id", [`${name} ${tag}`]);
  for (const item of domains)
    await db.query("INSERT INTO organisation_domains(domain,organisation_id) VALUES($1,$2)", [item, row.id]);
  return row.id as string;
}
const corp = await organisation("Ромашка", [domain]);
const other = await organisation("Лютик", [otherDomain]);

after(async () => {
  config.TEAM_SHELVES = saved.teamShelves;
  config.TEAM_SHELVES_SCOPE = saved.scope;
  useExtensions([]);
  await app.close();
  await db.end();
  s3.destroy();
});

const me = (cookie: string) =>
  app.inject({ method: "GET", url: "/api/me", headers: { cookie } }).then((res) => res.statusCode);
const acs = (email: string, organisationId = corp, cookie?: string) =>
  app.inject({
    method: "POST",
    url: "/api/ext/sso/acs",
    headers: { origin: "https://idp.example.com", ...(cookie ? { cookie } : {}) },
    payload: { email, organisationId },
  });
const person = async (local: string, organisationId = corp, at = domain) =>
  (await context.accounts.provision({ email: `${local}-${randomBytes(3).toString("hex")}@${at}`, organisationId }))
    .account;
const audits = async (id: string) =>
  (
    await db.query("SELECT action FROM audit_outbox WHERE target_id=$1 AND action LIKE 'account.%' ORDER BY id", [id])
  ).rows.map((row) => row.action as string);

test("an identity provider's post signs the person in with the core's session; no cookie identity there", async () => {
  const email = `ivan@${domain}`;
  const posted = await acs(email);
  assert.equal(posted.statusCode, 303, posted.body);
  const session = posted.cookies.find((cookie) => cookie.name === "polka_session");
  assert.ok(session, "a session cookie");
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, "Strict");
  const cookie = `polka_session=${session.value}`;
  assert.equal(await me(cookie), 200);
  // The sign-in path has no Origin rule, so it never reads the cookie.
  assert.equal((await app.inject({ method: "GET", url: "/api/ext/sso/acs", headers: { cookie } })).statusCode, 403);
  const account = await context.accounts.findByEmail(email.toUpperCase());
  assert.equal(account?.name, "Иван Петров");
  assert.match(account!.login, /^sso-/);
  assert.equal(account?.state, "active");
  assert.equal(account?.emailVerified, true);
  assert.ok(account?.personalShelfId);
  // A second sign-in in the same browser ends the first session, and the
  // journal records which extension signed the person in.
  const again = await acs(email, corp, cookie);
  assert.equal(again.statusCode, 303);
  assert.equal(await me(cookie), 401);
  assert.deepEqual(await audits(account!.id), ["account.signed_in", "account.signed_in"]);
  const repeat = await context.accounts.provision({ email, organisationId: corp });
  assert.equal(repeat.created, false);
  assert.equal(repeat.account.id, account!.id);
});

test("an address off the organisation's domains is never provisioned or given to an account", async () => {
  const refused = await context.accounts
    .provision({ email: `boss@${otherDomain}`, organisationId: corp })
    .catch((error) => error);
  assert.equal(refused.status, 403);
  assert.equal(refused.details.reason, "organisation_domain");
  assert.equal(await context.accounts.findByEmail(`boss@${otherDomain}`), null);
  // An existing account of another company cannot be taken over by an address.
  const victim = await createAccount(`victim-${tag}`, randomBytes(16).toString("hex"));
  await db.query("UPDATE accounts SET email=$2,email_verified_at=now() WHERE id=$1", [
    victim.id,
    `victim@${otherDomain}`,
  ]);
  assert.equal((await acs(`victim@${otherDomain}`)).statusCode, 403);
  assert.equal(
    (await context.accounts.provision({ email: "x@y.test", organisationId: "nope" }).catch((e) => e)).status,
    404,
  );

  const anna = await person("anna");
  const moved = await context.accounts
    .update(anna.id, { email: `anna@${otherDomain}`, organisationId: corp })
    .catch((error) => error);
  assert.equal(moved.status, 403);
});

test("a changed address ends sessions and pending codes and is journaled", async () => {
  const boris = await person("boris");
  const cookie = `polka_session=${(await acs(boris.email!)).cookies.find((c) => c.name === "polka_session")!.value}`;
  await db.query(
    `INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at)
     VALUES(gen_random_uuid(),$1,'x','y','local',now()+interval '10 minutes')`,
    [boris.email],
  );
  const changed = await context.accounts.update(boris.id, {
    email: `boris.new-${tag}@${domain}`,
    name: "Борис Иванов",
    organisationId: corp,
  });
  assert.equal(changed.name, "Борис Иванов");
  assert.equal(changed.email, `boris.new-${tag}@${domain}`);
  assert.equal(await me(cookie), 401);
  const { rows } = await db.query("SELECT consumed_at FROM login_challenges WHERE email=$1", [boris.email]);
  assert.ok(rows.every((row) => row.consumed_at));
  assert.ok((await audits(boris.id)).includes("account.email_changed"));
  const taken = await context.accounts
    .update(boris.id, { email: `ivan@${domain}`, organisationId: corp })
    .catch((error) => error);
  assert.equal(taken.status, 409);
});

test("a machine prefix covers the paths below it; other POST routes keep the Origin rule", async () => {
  const scim = await app.inject({ method: "POST", url: "/api/ext/sso/scim/Users/42", payload: {} });
  assert.equal(scim.statusCode, 200, scim.body);
  assert.equal(scim.json().id, "42");
  assert.equal((await app.inject({ method: "POST", url: "/api/ext/sso/scimx/Users/42", payload: {} })).statusCode, 403);
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
    { id: "acme", name: "Войти через SSO компании", start: "/api/ext/sso/start" },
  ]);
});

test("the extension's sign-in policy sees the account's own address and refuses code and password", async () => {
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
    payload: { email: `anna-${tag}@elsewhere.test` },
  });
  assert.equal(outside.statusCode, 200, outside.body);

  const password = randomBytes(16).toString("hex");
  const local = await createAccount(`sso-pw-${tag}`, password);
  await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [local.id, `pw-${tag}@${domain}`]);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress: "2001:db8:5e::1",
    headers: { origin },
    payload: { name: local.name, password },
  });
  assert.equal(login.statusCode, 403, login.body);
  assert.equal(login.json().reason, "sign_in_policy");
  const attempt = attempts.find((item) => item.method === "password" && item.accountId === local.id);
  assert.equal(attempt?.accountEmail, `pw-${tag}@${domain}`);
});

test("department shelves belong to the organisation; only its verified people are added", async () => {
  const anna = await person("anna");
  const boris = await person("boris");
  const shelf = await context.teamShelves.create(corp, "Продажи");
  const { rows } = await db.query("SELECT organisation_id FROM tenants WHERE id=$1", [shelf.id]);
  assert.equal(rows[0].organisation_id, corp);
  assert.deepEqual(await context.teamShelves.get(corp, shelf.id), shelf);
  assert.ok((await context.teamShelves.list(corp)).some((item) => item.id === shelf.id));
  // Another organisation sees nothing of it.
  assert.equal(await context.teamShelves.get(other, shelf.id), null);
  assert.ok(!(await context.teamShelves.list(other)).some((item) => item.id === shelf.id));
  assert.equal((await context.teamShelves.setMember(other, shelf.id, anna.id, "admin").catch((e) => e)).status, 404);
  assert.equal((await context.teamShelves.members(other, shelf.id).catch((e) => e)).status, 404);

  assert.equal((await context.teamShelves.setMember(corp, shelf.id, anna.id, "admin")).added, true);
  assert.equal((await context.teamShelves.setMember(corp, shelf.id, boris.id, "author")).added, true);
  assert.equal((await context.teamShelves.setMember(corp, shelf.id, boris.id, "curator")).added, false);
  // Someone of another company, or with an unverified address: refused.
  const outsider = await person("out", other, otherDomain);
  const refused = await context.teamShelves.setMember(corp, shelf.id, outsider.id, "reader").catch((e) => e);
  assert.equal(refused.status, 403);
  assert.equal(refused.details.reason, "organisation_domain");
  await db.query("UPDATE accounts SET email_verified_at=NULL WHERE id=$1", [boris.id]);
  assert.equal((await context.teamShelves.setMember(corp, shelf.id, boris.id, "reader").catch((e) => e)).status, 403);
  await db.query("UPDATE accounts SET email_verified_at=now() WHERE id=$1", [boris.id]);

  assert.equal((await context.teamShelves.rename(corp, shelf.id, "Продажи и маркетинг")).name, "Продажи и маркетинг");
  const { rows: journal } = await db.query(
    "SELECT action,actor_id FROM tenant_member_events WHERE tenant_id=$1 ORDER BY id",
    [shelf.id],
  );
  assert.deepEqual(
    journal.map((row) => row.action),
    ["shelf_created", "member_added", "member_added", "member_role_changed", "shelf_renamed"],
  );
  assert.ok(journal.every((row) => row.actor_id === null));
  assert.deepEqual(await context.teamShelves.removeMember(corp, shelf.id, anna.id), { removed: true });
  assert.deepEqual(await context.teamShelves.removeMember(corp, shelf.id, anna.id), { removed: false });
});

test("deprovision ends sessions and agents, leaves only the organisation's shelves, and is idempotent", async () => {
  config.TEAM_SHELVES_SCOPE = "organisation";
  try {
    const vera = await person("vera");
    const mine = await context.teamShelves.create(corp, "Склад");
    await context.teamShelves.setMember(corp, mine.id, vera.id, "author");
    // A shelf of another organisation she joined by an invitation.
    const theirs = await context.teamShelves.create(other, "Партнёры");
    await db.query("INSERT INTO tenant_members(tenant_id,account_id,role) VALUES($1,$2,'reader')", [
      theirs.id,
      vera.id,
    ]);
    const cookie = `polka_session=${(await acs(vera.email!)).cookies.find((c) => c.name === "polka_session")!.value}`;
    const gone = await context.accounts.deprovision(vera.id, { organisationId: corp, reason: "scim: active=false" });
    assert.equal(gone.state, "deprovisioned");
    assert.equal(gone.sessions, 1);
    assert.deepEqual(gone.shelves, [mine.id]);
    assert.equal(await me(cookie), 401);
    const account = await context.accounts.get(vera.id);
    assert.equal(account?.state, "disabled");
    assert.equal(account?.deprovisionedBy, "sso");
    assert.equal(account?.operatorDisabled, false);
    const { rows } = await db.query("SELECT state FROM tenant_members WHERE tenant_id=$1 AND account_id=$2", [
      theirs.id,
      vera.id,
    ]);
    assert.equal(rows[0].state, "active", "another organisation's shelf is not this directory's");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.some((e) => e.type === "member.revoked" && e.accountId === vera.id && e.tenantId === mine.id));
    assert.equal((await context.accounts.deprovision(vera.id, { organisationId: corp })).state, "already");
    assert.equal((await acs(vera.email!)).statusCode, 403);
    assert.equal((await context.teamShelves.setMember(corp, mine.id, vera.id, "reader").catch((e) => e)).status, 409);
    assert.deepEqual(await audits(vera.id), ["account.signed_in", "account.deprovisioned"]);
    assert.equal((await context.accounts.reactivate(vera.id, { organisationId: corp })).state, "active");
  } finally {
    config.TEAM_SHELVES_SCOPE = saved.scope;
  }
});

test("the operator's disable and the extension's deprovision are separate: neither lifts the other", async () => {
  // Operator first, then the directory: reactivate leaves the operator's.
  const carl = await person("carl");
  await disableAccount(carl.login, "spam");
  await context.accounts.deprovision(carl.id, { organisationId: corp });
  const back = await context.accounts.reactivate(carl.id, { organisationId: corp });
  assert.equal(back.state, "disabled");
  assert.equal(back.operatorDisabled, true);
  assert.equal(back.deprovisionedBy, null);

  // The directory first, then the operator: the operator's disable is recorded
  // and the directory cannot lift it.
  const dina = await person("dina");
  await context.accounts.deprovision(dina.id, { organisationId: corp });
  const disabled = await disableAccount(dina.login, "fraud");
  assert.equal(disabled.alreadyDisabled, false);
  const { rowCount } = await db.query(
    "SELECT 1 FROM moderation_events WHERE account_id=$1 AND action='account.disabled'",
    [dina.id],
  );
  assert.equal(rowCount, 1);
  assert.equal((await context.accounts.reactivate(dina.id, { organisationId: corp })).state, "disabled");

  // The operator's enable does not undo the directory's deprovision.
  const egor = await person("egor");
  await disableAccount(egor.login);
  await context.accounts.deprovision(egor.id, { organisationId: corp });
  const enabled = await enableAccount(egor.login);
  assert.equal(enabled.deprovisionedBy, "sso");
  assert.equal((await context.accounts.get(egor.id))?.state, "disabled");
  assert.equal((await context.accounts.reactivate(egor.id, { organisationId: corp })).state, "active");

  // Another extension's deprovision is not this one's to lift.
  const fedor = await person("fedor");
  await db.query("UPDATE accounts SET disabled=true,deprovisioned_at=now(),deprovisioned_by='other' WHERE id=$1", [
    fedor.id,
  ]);
  assert.equal((await context.accounts.reactivate(fedor.id, { organisationId: corp }).catch((e) => e)).status, 409);
  // The database keeps the rule too.
  await assert.rejects(db.query("UPDATE accounts SET disabled=false WHERE id=$1", [fedor.id]), /disabled_while_held/);
});

const signInAs = (accountId: string, organisationId?: string) =>
  app.inject({
    method: "POST",
    url: "/api/ext/sso/acs-account",
    headers: { origin: "https://idp.example.com" },
    payload: { accountId, ...(organisationId ? { organisationId } : {}) },
  });

test("one organisation's directory never changes, disables, revives or signs in another's person", async () => {
  // Bea belongs to the other organisation; its directory deprovisions her.
  const bea = await person("bea", other, otherDomain);
  const reason = async (call: Promise<unknown>) => {
    const error = (await call.catch((e) => e)) as { status?: number; details?: { reason?: string } };
    return `${error.status}:${error.details?.reason}`;
  };
  // Taking her over with an address on corp's domain: refused, nothing changes.
  assert.equal(
    await reason(context.accounts.update(bea.id, { email: `bea-${tag}@${domain}`, organisationId: corp })),
    "403:organisation_member",
  );
  assert.equal(
    await reason(context.accounts.update(bea.id, { name: "Чужая", organisationId: corp })),
    "403:organisation_member",
  );
  assert.equal((await context.accounts.get(bea.id))?.email, bea.email);
  // Signing her in through corp's sign-in: refused; through her own: fine.
  const foreign = await signInAs(bea.id, corp);
  assert.equal(foreign.statusCode, 403, foreign.body);
  assert.equal(foreign.json().reason, "organisation_member");
  assert.equal((await signInAs(bea.id, other)).statusCode, 303);
  // No organisation named: refused, never allowed.
  assert.equal((await signInAs(bea.id)).statusCode, 400);
  assert.equal(
    (await context.accounts.reactivate(bea.id, undefined as unknown as { organisationId: string }).catch((e) => e))
      .name,
    "ZodError",
  );
  assert.equal(
    (await context.accounts.deprovision(bea.id, {} as { organisationId: string }).catch((e) => e)).name,
    "ZodError",
  );
  // Disabling her for corp: refused, she stays active.
  assert.equal(await reason(context.accounts.deprovision(bea.id, { organisationId: corp })), "403:organisation_member");
  assert.equal((await context.accounts.get(bea.id))?.state, "active");

  // Her own organisation deprovisions her; corp cannot lift that.
  assert.equal((await context.accounts.deprovision(bea.id, { organisationId: other })).state, "deprovisioned");
  assert.equal((await context.accounts.get(bea.id))?.deprovisionedOrganisationId, other);
  assert.equal(await reason(context.accounts.reactivate(bea.id, { organisationId: corp })), "403:organisation_member");
  // Even were her address on corp's domain now, only the organisation that
  // deprovisioned her brings her back.
  await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [bea.id, `bea-moved-${tag}@${domain}`]);
  assert.equal((await context.accounts.reactivate(bea.id, { organisationId: corp }).catch((e) => e)).status, 409);
  assert.equal((await context.accounts.get(bea.id))?.state, "disabled");
  await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [bea.id, bea.email]);
  const back = await context.accounts.reactivate(bea.id, { organisationId: other });
  assert.equal(back.state, "active");
  assert.equal(back.deprovisionedOrganisationId, null);

  // A deprovision recorded before migration 073 names no organisation: the
  // organisation the person belongs to now may lift it.
  const gleb = await person("gleb");
  await db.query("UPDATE accounts SET disabled=true,deprovisioned_at=now(),deprovisioned_by='sso' WHERE id=$1", [
    gleb.id,
  ]);
  assert.equal(
    await reason(context.accounts.reactivate(gleb.id, { organisationId: other })),
    "403:organisation_member",
  );
  assert.equal((await context.accounts.reactivate(gleb.id, { organisationId: corp })).state, "active");

  // An unverified address is no one's: refused.
  await db.query("UPDATE accounts SET email_verified_at=NULL WHERE id=$1", [gleb.id]);
  assert.equal(
    await reason(context.accounts.deprovision(gleb.id, { organisationId: corp })),
    "403:organisation_member",
  );
});

test("department shelves are not offered while TEAM_SHELVES is off", async () => {
  config.TEAM_SHELVES = "off";
  try {
    assert.equal((await context.teamShelves.list(corp).catch((error) => error)).status, 404);
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
