// The first administrator of a new installation (migration 074,
// apps/server/operator-sign-in-links.ts): the operator command creates the
// account with a verified address, makes it the company admin and prints a
// one-time link; the link opens a full session once, within the hour, and a
// new link spends the old one. No mail involved.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { bootstrapAccount } from "../apps/server/operator-sign-in-links.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const scope = config.TEAM_SHELVES_SCOPE;

after(async () => {
  config.TEAM_SHELVES_SCOPE = scope;
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () => `admin-${randomBytes(5).toString("hex")}@company.test`;
const tokenOf = (url: string) => url.slice(url.indexOf("#") + 1);
const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: "POST", url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload: payload as any });

test("bootstrap creates a verified company admin and a link that opens a full session once", async () => {
  const email = address();
  const result = await transaction((c) => bootstrapAccount(c, email.toUpperCase()));
  assert.equal(result.created, true);
  assert.equal(result.companyAdmin, true);
  assert.match(result.url, new RegExp(`^${origin}/welcome#[A-Za-z0-9_-]{43}$`));
  const expires = Date.parse(result.expiresAt) - Date.now();
  assert.ok(expires > 3500_000 && expires <= 3600_000, String(expires));
  const {
    rows: [account],
  } = await db.query("SELECT name,email,email_verified_at,trusted_at,company_admin FROM accounts WHERE id=$1", [
    result.accountId,
  ]);
  assert.equal(account.email, email);
  assert.ok(account.email_verified_at && account.trusted_at);
  assert.equal(account.company_admin, true);
  assert.match(account.name, /^email-[0-9a-f-]{36}$/);
  // Only the hash is stored.
  const token = tokenOf(result.url);
  assert.equal((await db.query("SELECT 1 FROM operator_sign_in_links WHERE token_hash=$1", [token])).rowCount, 0);
  assert.equal(
    (await db.query("SELECT 1 FROM operator_sign_in_links WHERE token_hash=$1", [sha256(token)])).rowCount,
    1,
  );

  // Looking spends nothing.
  for (let i = 0; i < 2; i++) {
    const preview = await post("/api/auth/welcome/preview", { token });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().email, email);
    assert.equal(preview.json().companyAdmin, true);
    assert.equal(preview.json().current, null);
  }
  const entered = await post("/api/auth/welcome", { token });
  assert.equal(entered.statusCode, 200, entered.body);
  const cookie = `polka_session=${entered.cookies.find((c) => c.name === "polka_session")!.value}`;
  const session = await app.inject({ method: "GET", url: "/api/session", headers: { cookie } });
  assert.equal(session.statusCode, 200, session.body);
  // A full session, not an agent link's: it may manage agents.
  const { rows } = await db.query("SELECT assurance FROM sessions WHERE account_id=$1", [result.accountId]);
  assert.deepEqual(
    rows.map((row) => row.assurance),
    ["full"],
  );

  assert.equal((await post("/api/auth/welcome", { token })).statusCode, 410);
  assert.equal((await post("/api/auth/welcome/preview", { token })).statusCode, 410);
});

test("a new link spends the old one; an existing account keeps its shelf", async () => {
  const email = address();
  const first = await transaction((c) => bootstrapAccount(c, email, { admin: false }));
  assert.equal(first.companyAdmin, false);
  const second = await transaction((c) => bootstrapAccount(c, email, { admin: false }));
  assert.equal(second.created, false);
  assert.equal(second.accountId, first.accountId);
  assert.equal((await post("/api/auth/welcome", { token: tokenOf(first.url) })).statusCode, 410);
  const company = (await db.query("SELECT company_admin FROM accounts WHERE id=$1", [first.accountId])).rows[0];
  assert.equal(company.company_admin, false);
  // A browser signed in elsewhere is asked first.
  const other = await transaction((c) => bootstrapAccount(c, address(), { admin: false }));
  const otherSession = await post("/api/auth/welcome", { token: tokenOf(other.url) });
  const cookie = `polka_session=${otherSession.cookies.find((c) => c.name === "polka_session")!.value}`;
  const refused = await post("/api/auth/welcome", { token: tokenOf(second.url) }, cookie);
  assert.equal(refused.statusCode, 409);
  const switched = await post("/api/auth/welcome", { token: tokenOf(second.url), replace: true }, cookie);
  assert.equal(switched.statusCode, 200, switched.body);
});

test("an expired link, a blocked account and a garbled token are refused alike", async () => {
  const expired = await transaction((c) => bootstrapAccount(c, address(), { admin: false }));
  await db.query(
    "UPDATE operator_sign_in_links SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE account_id=$1",
    [expired.accountId],
  );
  assert.equal((await post("/api/auth/welcome", { token: tokenOf(expired.url) })).statusCode, 410);

  const blocked = await transaction((c) => bootstrapAccount(c, address(), { admin: false }));
  await db.query("UPDATE accounts SET disabled=true,operator_disabled_at=now() WHERE id=$1", [blocked.accountId]);
  assert.equal((await post("/api/auth/welcome", { token: tokenOf(blocked.url) })).statusCode, 410);
  const email = (await db.query("SELECT email FROM accounts WHERE id=$1", [blocked.accountId])).rows[0].email;
  await assert.rejects(
    transaction((c) => bootstrapAccount(c, email)),
    /blocked or being deleted/,
  );

  assert.equal((await post("/api/auth/welcome", { token: "x".repeat(43) })).statusCode, 410);
  assert.equal((await post("/api/auth/welcome", { token: "short" })).statusCode, 410);
});

test("a shared cloud needs the organisation named", async () => {
  config.TEAM_SHELVES_SCOPE = "organisation";
  try {
    await assert.rejects(
      transaction((c) => bootstrapAccount(c, address())),
      /TEAM_SHELVES_SCOPE=organisation/,
    );
    await assert.rejects(
      transaction((c) => bootstrapAccount(c, address(), { org: `Нет такой ${randomBytes(3).toString("hex")}` })),
      /No organisation/,
    );
  } finally {
    config.TEAM_SHELVES_SCOPE = scope;
  }
});

test("the command refuses bad arguments before it touches the database", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/admin.ts", "account", "bootstrap", ...args], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" },
    });
  for (const args of [[], ["not-an-email"], ["a@b.test", "--org"], ["a@b.test", "--org", "X", "--no-admin"]]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /account bootstrap <email>/);
  }
});

test("the command prints a working link", async () => {
  const email = address();
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/admin.ts", "account", "bootstrap", email, "--no-admin"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Created the account of ${email}.`), result.stdout);
  const url = result.stdout.match(/https?:\/\/\S+\/welcome#[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(url, result.stdout);
  assert.equal((await post("/api/auth/welcome", { token: tokenOf(url) })).statusCode, 200);
});
