// EMAIL_SIGNUP_DOMAINS / EMAIL_LOGIN_DOMAINS (docs/specs/SIGN_IN_PROVIDERS.md
// § 3): a new shelf by an emailed code opens only on allowed domains, an
// existing account keeps signing in unless the operator says otherwise, and
// the form answers the same either way.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  PUBLIC_MAIL_DOMAINS,
  RU_MAIL_DOMAINS,
  domainAllowed,
  installationDomains,
  parseSignupDomains,
} from "../apps/server/mail-domains.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const saved = {
  EMAIL_SIGNUP_DOMAINS: config.EMAIL_SIGNUP_DOMAINS,
  EMAIL_LOGIN_DOMAINS: config.EMAIL_LOGIN_DOMAINS,
  EMAIL_SIGNUP: config.EMAIL_SIGNUP,
  EMAIL_SIGNUP_ALLOW: config.EMAIL_SIGNUP_ALLOW,
};
after(async () => {
  Object.assign(config, saved);
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () =>
  `2001:db8:5d::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

/** Asks for a code; returns the answer and whether a challenge was stored. */
async function askCode(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/email/start",
    remoteAddress: address(),
    headers: { origin },
    payload: { email },
  });
  const stored = (
    await db.query("SELECT 1 FROM login_challenges WHERE email=$1", [email])
  ).rowCount;
  return { response, stored: !!stored };
}

test("ru-only is the curated Russian list plus the installation's domain", () => {
  const domains = parseSignupDomains("ru-only", "https://app.polochka.app");
  assert.ok(Array.isArray(domains));
  for (const domain of [
    "yandex.ru",
    "ya.ru",
    "mail.ru",
    "bk.ru",
    "list.ru",
    "inbox.ru",
    "internet.ru",
    "rambler.ru",
    "ro.ru",
    "vk.com",
    "app.polochka.app",
    "polochka.app",
  ])
    assert.ok((domains as string[]).includes(domain), domain);
  assert.equal(domainAllowed("someone@gmail.com", domains), false);
  assert.equal(domainAllowed("someone@Yandex.RU", domains), true);
  assert.equal(parseSignupDomains("any", "https://polochka.app"), "any");
  assert.deepEqual(
    parseSignupDomains("ru-only, company.ru", "http://127.0.0.1:4390"),
    [...RU_MAIL_DOMAINS, "company.ru"].sort(),
  );
  assert.deepEqual(installationDomains("http://127.0.0.1:4390"), []);
  assert.throws(() =>
    parseSignupDomains("any,ru-only", "https://polochka.app"),
  );
  assert.throws(() =>
    parseSignupDomains("not a domain", "https://polochka.app"),
  );
  // Organisation rules may never name a public mail service.
  for (const domain of ["gmail.com", "yandex.ru", "mail.ru"])
    assert.ok(PUBLIC_MAIL_DOMAINS.includes(domain));
});

test("a new shelf opens only on allowed domains; the answer looks the same", async () => {
  config.EMAIL_SIGNUP = "open";
  config.EMAIL_SIGNUP_DOMAINS = ["allowed.test"];
  config.EMAIL_LOGIN_DOMAINS = "any";
  const tag = randomUUID().slice(0, 8);
  const allowed = await askCode(`new-${tag}@allowed.test`);
  assert.equal(allowed.response.statusCode, 200, allowed.response.body);
  assert.equal(allowed.stored, true);
  const outside = await askCode(`new-${tag}@foreign.test`);
  assert.equal(outside.response.statusCode, 200, outside.response.body);
  assert.equal(outside.stored, false);
  assert.deepEqual(
    Object.keys(outside.response.json()).sort(),
    Object.keys(allowed.response.json()).sort(),
  );
  // An operator's invitation opens a shelf outside the list.
  config.EMAIL_SIGNUP_ALLOW = [`invited-${tag}@foreign.test`];
  assert.equal((await askCode(`invited-${tag}@foreign.test`)).stored, true);
  config.EMAIL_SIGNUP_ALLOW = [];
  // The interface learns the rule from capabilities.
  const capabilities = (
    await app.inject({ method: "GET", url: "/api/capabilities" })
  ).json();
  assert.deepEqual(capabilities.emailSignupDomains, ["allowed.test"]);
  assert.equal(capabilities.emailLoginDomains, "any");
});

test("an existing account outside the list keeps its code unless EMAIL_LOGIN_DOMAINS=signup", async () => {
  config.EMAIL_SIGNUP_DOMAINS = ["allowed.test"];
  const email = `old-${randomUUID().slice(0, 8)}@foreign.test`;
  const id = randomUUID();
  await db.query(
    "INSERT INTO accounts(id,name,password_hash,email) VALUES($1,$2,'unused',$3)",
    [id, `email-${id}`, email],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
    randomUUID(),
    id,
  ]);
  config.EMAIL_LOGIN_DOMAINS = "any";
  assert.equal((await askCode(email)).stored, true);
  await db.query("DELETE FROM login_challenges WHERE email=$1", [email]);
  config.EMAIL_LOGIN_DOMAINS = "signup";
  try {
    const refused = await askCode(email);
    assert.equal(refused.response.statusCode, 200);
    assert.equal(refused.stored, false);
  } finally {
    config.EMAIL_LOGIN_DOMAINS = "any";
  }
});

test("a code issued before the rule changed opens no new shelf", async () => {
  config.EMAIL_SIGNUP_DOMAINS = "any";
  const email = `late-${randomUUID().slice(0, 8)}@foreign.test`;
  const asked = await app.inject({
    method: "POST",
    url: "/api/auth/email/start",
    remoteAddress: address(),
    headers: { origin },
    payload: { email },
  });
  assert.equal(asked.statusCode, 200, asked.body);
  const browser = asked.cookies.find(
    (cookie) => cookie.name === "polka_email_challenge",
  )!.value;
  const { readFile } = await import("node:fs/promises");
  const { LOCAL_MAIL_DIRECTORY } = await import("../apps/server/mailer.ts");
  const { id } = asked.json();
  const letter = JSON.parse(
    await readFile(`${LOCAL_MAIL_DIRECTORY}/${id}.json`, "utf8"),
  );
  config.EMAIL_SIGNUP_DOMAINS = ["allowed.test"];
  try {
    const verify = await app.inject({
      method: "POST",
      url: "/api/auth/email/verify",
      remoteAddress: address(),
      headers: { origin, cookie: `polka_email_challenge=${browser}` },
      payload: { id, code: letter.code },
    });
    assert.equal(verify.statusCode, 401);
    assert.equal(
      (await db.query("SELECT 1 FROM accounts WHERE email=$1", [email]))
        .rowCount,
      0,
    );
  } finally {
    config.EMAIL_SIGNUP_DOMAINS = "any";
  }
});
