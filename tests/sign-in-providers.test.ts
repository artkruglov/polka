// External sign-in (docs/specs/SIGN_IN_PROVIDERS.md): Яндекс ID, VK ID and a
// generic OIDC provider, each played by a local mock. The flow must refuse a
// foreign state, a missing cookie, a PKCE mismatch, a wrong nonce or
// signature; an unverified address never links an existing shelf; organisation
// access joins configured libraries once and never overrides a revocation.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  openFlow,
  providerEndpoints,
  resetOidcCache,
  safeReturnPath,
  sealFlow,
} from "../apps/server/sign-in-providers.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const saved = { ...config };

// ---------------------------------------------------------------------------
// The mock provider

type Person = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
};
/** code → who signs in and the PKCE challenge the authorize URL carried. */
const codes = new Map<
  string,
  {
    person: Person;
    challenge: string;
    nonce?: string;
    forgeSignature?: boolean;
  }
>();
const tokens = new Map<string, Person>();
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const { privateKey: strangerKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "k1",
  alg: "RS256",
  use: "sig",
};
let base = "";

function idToken(claims: Record<string, unknown>, forge = false) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "k1" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(forge ? strangerKey : privateKey).toString("base64url")}`;
}

async function readForm(req: import("node:http").IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

const pkceOk = (verifier: string | undefined, challenge: string) =>
  !!verifier &&
  createHash("sha256").update(verifier).digest("base64url") === challenge;

let server: Server;
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const issueToken = (
      code: string | undefined,
      verifier: string | undefined,
    ) => {
      const grant = code ? codes.get(code) : undefined;
      if (!grant) return null;
      codes.delete(code!);
      if (!pkceOk(verifier, grant.challenge)) return null;
      const access = randomBytes(16).toString("hex");
      tokens.set(access, grant.person);
      return { access, grant };
    };
    if (url.pathname === "/yandex/token" && req.method === "POST") {
      const form = await readForm(req);
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from("ya-client:ya-secret").toString("base64")}`
      )
        return send(401, { error: "invalid_client" });
      const issued = issueToken(form.code, form.code_verifier);
      if (!issued) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: issued.access, token_type: "bearer" });
    }
    if (url.pathname === "/yandex/info") {
      const person = tokens.get(
        String(req.headers.authorization).replace("OAuth ", ""),
      );
      if (!person) return send(401, {});
      return send(200, {
        id: person.sub,
        login: "someone",
        default_email: person.email,
        real_name: person.name,
      });
    }
    if (url.pathname === "/vk/token" && req.method === "POST") {
      const form = await readForm(req);
      if (form.client_id !== "vk-client" || !form.device_id)
        return send(400, { error: "invalid_request" });
      const issued = issueToken(form.code, form.code_verifier);
      if (!issued) return send(400, { error: "invalid_grant" });
      return send(200, {
        access_token: issued.access,
        user_id: Number(issued.grant.person.sub),
        state: form.state,
      });
    }
    if (url.pathname === "/vk/user_info" && req.method === "POST") {
      const form = await readForm(req);
      const person = tokens.get(form.access_token);
      if (!person) return send(401, {});
      return send(200, {
        user: {
          user_id: person.sub,
          first_name: "Вера",
          last_name: "Кузнецова",
          email: person.email,
        },
      });
    }
    if (url.pathname === "/oidc/.well-known/openid-configuration")
      return send(200, {
        issuer: `${base}/oidc`,
        authorization_endpoint: `${base}/oidc/authorize`,
        token_endpoint: `${base}/oidc/token`,
        jwks_uri: `${base}/oidc/jwks`,
      });
    if (url.pathname === "/oidc/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/oidc/token" && req.method === "POST") {
      const form = await readForm(req);
      const issued = issueToken(form.code, form.code_verifier);
      if (
        !issued ||
        form.redirect_uri !== `${origin}/api/auth/idp/oidc/callback`
      )
        return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      return send(200, {
        access_token: issued.access,
        id_token: idToken(
          {
            iss: `${base}/oidc`,
            aud: "oidc-client",
            sub: issued.grant.person.sub,
            email: issued.grant.person.email,
            email_verified: issued.grant.person.email_verified,
            name: issued.grant.person.name,
            groups: issued.grant.person.groups,
            nonce: issued.grant.nonce,
            iat: now,
            exp: now + 300,
          },
          issued.grant.forgeSignature,
        ),
      });
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  providerEndpoints.yandex = {
    authorize: `${base}/yandex/authorize`,
    token: `${base}/yandex/token`,
    userInfo: `${base}/yandex/info`,
  };
  providerEndpoints.vk = {
    authorize: `${base}/vk/authorize`,
    token: `${base}/vk/token`,
    userInfo: `${base}/vk/user_info`,
  };
  Object.assign(config, {
    YANDEX_CLIENT_ID: "ya-client",
    YANDEX_CLIENT_SECRET: "ya-secret",
    YANDEX_EMAIL_VERIFIED: true,
    VK_CLIENT_ID: "vk-client",
    VK_EMAIL_VERIFIED: false,
    OIDC_DISCOVERY_URL: `${base}/oidc/.well-known/openid-configuration`,
    OIDC_CLIENT_ID: "oidc-client",
    OIDC_CLIENT_SECRET: "oidc-secret",
    OIDC_NAME: "Вход компании",
    SIGN_IN_PROVIDERS: ["yandex", "vk", "oidc"],
    EMAIL_SIGNUP: "open",
    EMAIL_SIGNUP_DAILY_LIMIT: 100000,
    EMAIL_SIGNUP_DAILY_PER_IP: 1000,
  });
  resetOidcCache();
});

after(async () => {
  Object.assign(config, saved);
  server.close();
  await app.close();
  await db.end();
  s3.destroy();
});

// ---------------------------------------------------------------------------
// Driving the browser side

const address = () =>
  `2001:db8:1d::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

function cookieFrom(
  response: { cookies: Array<{ name: string; value: string }> },
  name: string,
) {
  return response.cookies.find((cookie) => cookie.name === name)?.value;
}

/** GET /start; returns the provider URL and the sealed flow cookie. */
async function start(provider: string, next = "/start", ip = address()) {
  const response = await app.inject({
    method: "GET",
    url: `/api/auth/idp/${provider}/start?next=${encodeURIComponent(next)}`,
    remoteAddress: ip,
  });
  assert.equal(response.statusCode, 303, response.body);
  const location = new URL(response.headers.location as string);
  const flow = cookieFrom(response, "polka_idp");
  assert.ok(flow, "flow cookie");
  return { location, flow: flow!, ip };
}

/** The provider "authorizes" `person` and sends the browser back. */
async function authorize(
  provider: string,
  person: Person,
  options: {
    next?: string;
    state?: (real: string) => string;
    cookie?: (real: string) => string | undefined;
    wrongChallenge?: boolean;
    nonce?: (real: string | null) => string | undefined;
    forgeSignature?: boolean;
    start?: { location: URL; flow: string; ip: string };
  } = {},
) {
  const begun = options.start ?? (await start(provider, options.next));
  const params = begun.location.searchParams;
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(
    params.get("redirect_uri"),
    `${origin}/api/auth/idp/${provider}/callback`,
  );
  const code = randomBytes(12).toString("hex");
  codes.set(code, {
    person,
    challenge: options.wrongChallenge
      ? createHash("sha256").update("another verifier").digest("base64url")
      : params.get("code_challenge")!,
    nonce: options.nonce
      ? options.nonce(params.get("nonce"))
      : (params.get("nonce") ?? undefined),
    forgeSignature: options.forgeSignature,
  });
  const state = options.state
    ? options.state(params.get("state")!)
    : params.get("state")!;
  const query = new URLSearchParams({ code, state });
  if (provider === "vk") query.set("device_id", "device-1");
  const cookie = options.cookie ? options.cookie(begun.flow) : begun.flow;
  const response = await app.inject({
    method: "GET",
    url: `/api/auth/idp/${provider}/callback?${query}`,
    remoteAddress: begun.ip,
    headers: cookie ? { cookie: `polka_idp=${cookie}` } : {},
  });
  assert.equal(response.statusCode, 303, response.body);
  const session = cookieFrom(response, "polka_session");
  return {
    location: response.headers.location as string,
    session,
    accountId: session
      ? ((
          await db.query("SELECT account_id FROM sessions WHERE hash=$1", [
            sha256(session),
          ])
        ).rows[0]?.account_id as string)
      : null,
  };
}

const identities = async (provider: string, subject: string) =>
  (
    await db.query(
      "SELECT account_id,email,email_verified FROM account_identities WHERE provider=$1 AND subject=$2",
      [provider, subject],
    )
  ).rows;

async function emailAccount(email: string) {
  const id = randomUUID(),
    tenant = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,email_verified_at)
     VALUES($1,$2,'unused',$3,now())`,
    [id, `email-${id}`, email],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
    tenant,
    id,
  ]);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(token), id],
  );
  return { id, tenant, cookie: `polka_session=${token}` };
}

// ---------------------------------------------------------------------------

test("capabilities list configured providers; a disabled provider has no routes", async () => {
  const capabilities = (
    await app.inject({ method: "GET", url: "/api/capabilities" })
  ).json();
  assert.deepEqual(
    capabilities.signInProviders.map((provider: { id: string }) => provider.id),
    ["yandex", "vk", "oidc"],
  );
  config.SIGN_IN_PROVIDERS = ["yandex"];
  try {
    const off = await app.inject({
      method: "GET",
      url: "/api/auth/idp/vk/start",
    });
    assert.equal(off.statusCode, 404);
  } finally {
    config.SIGN_IN_PROVIDERS = ["yandex", "vk", "oidc"];
  }
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/auth/idp/google/start" }))
      .statusCode,
    404,
  );
});

test("Яндекс ID: a new person gets a shelf and returns to the agent consent page", async () => {
  const sub = String(Date.now());
  const next = "/oauth/consent?request=4d7b2a39-8a8e-4f7f-9a0e-0d1f2f3a4b5c";
  const result = await authorize(
    "yandex",
    { sub, email: `Anna.${sub}@Yandex.ru`, name: "Анна" },
    { next },
  );
  assert.equal(result.location, next);
  assert.ok(result.session && result.accountId);
  const [account] = (
    await db.query(
      "SELECT email,email_verified_at,display_name FROM accounts WHERE id=$1",
      [result.accountId],
    )
  ).rows;
  assert.equal(account.email, `anna.${sub}@yandex.ru`);
  assert.ok(account.email_verified_at);
  assert.equal(account.display_name, "Анна");
  const [identity] = await identities("yandex", sub);
  assert.equal(identity.account_id, result.accountId);
  // The session works; signing in again opens the same shelf.
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie: `polka_session=${result.session}` },
  });
  assert.equal(me.statusCode, 200);
  const again = await authorize("yandex", {
    sub,
    email: `anna.${sub}@yandex.ru`,
  });
  assert.equal(again.accountId, result.accountId);
  assert.equal((await identities("yandex", sub)).length, 1);
});

test("a foreign state, a missing or forged cookie and a replayed callback are refused", async () => {
  const sub = `s-${randomUUID()}`;
  const person = { sub, email: `${sub}@yandex.ru` };
  const wrongState = await authorize("yandex", person, {
    state: () => randomBytes(32).toString("base64url"),
  });
  assert.match(wrongState.location, /^\/signup\?idp_error=state/);
  assert.equal(wrongState.session, undefined);
  const noCookie = await authorize("yandex", person, {
    cookie: () => undefined,
  });
  assert.match(noCookie.location, /idp_error=state/);
  const forged = await authorize("yandex", person, {
    cookie: (real) =>
      real.slice(0, -4) + (real.endsWith("AAAA") ? "BBBB" : "AAAA"),
  });
  assert.match(forged.location, /idp_error=state/);
  // A flow for one provider cannot finish at another's callback.
  const yandexStart = await start("yandex");
  const crossed = await app.inject({
    method: "GET",
    url: `/api/auth/idp/vk/callback?code=x&state=${yandexStart.location.searchParams.get("state")}&device_id=d`,
    headers: { cookie: `polka_idp=${yandexStart.flow}` },
  });
  assert.match(crossed.headers.location as string, /idp_error=state/);
  // An expired flow is gone.
  const flow = openFlow(yandexStart.flow)!;
  assert.equal(openFlow(sealFlow({ ...flow, expires: Date.now() - 1 })), null);
  // The provider says no.
  const denied = await app.inject({
    method: "GET",
    url: `/api/auth/idp/yandex/callback?error=access_denied&state=${yandexStart.location.searchParams.get("state")}`,
    headers: { cookie: `polka_idp=${yandexStart.flow}` },
  });
  assert.match(denied.headers.location as string, /idp_error=denied/);
  assert.equal((await identities("yandex", sub)).length, 0);
});

test("a PKCE mismatch is refused by the token exchange", async () => {
  const sub = `p-${randomUUID()}`;
  const result = await authorize(
    "yandex",
    { sub, email: `${sub}@yandex.ru` },
    { wrongChallenge: true },
  );
  assert.match(result.location, /idp_error=provider/);
  assert.equal(result.session, undefined);
  assert.equal((await identities("yandex", sub)).length, 0);
});

test("a verified address links the existing shelf; an unverified one never does", async () => {
  const email = `vera-${randomUUID().slice(0, 8)}@mail.ru`;
  const existing = await emailAccount(email);
  // VK ID reports no verification (VK_EMAIL_VERIFIED=false): a new shelf,
  // and the address stays with its owner.
  const vk = await authorize("vk", {
    sub: String(Math.floor(Math.random() * 1e9)),
    email,
  });
  assert.ok(vk.accountId);
  assert.notEqual(vk.accountId, existing.id);
  const [fresh] = (
    await db.query("SELECT email,email_verified_at FROM accounts WHERE id=$1", [
      vk.accountId,
    ])
  ).rows;
  assert.equal(fresh.email, null);
  assert.equal(fresh.email_verified_at, null);
  const [vkIdentity] = (
    await db.query(
      "SELECT email,email_verified FROM account_identities WHERE account_id=$1",
      [vk.accountId],
    )
  ).rows;
  assert.deepEqual(vkIdentity, { email, email_verified: false });
  // Яндекс ID vouches for the address: the existing shelf is opened.
  const sub = `v-${randomUUID()}`;
  const yandex = await authorize("yandex", { sub, email });
  assert.equal(yandex.accountId, existing.id);
  // OIDC with email_verified=false: a new shelf again.
  const oidc = await authorize("oidc", {
    sub: `o-${randomUUID()}`,
    email,
    email_verified: false,
  });
  assert.ok(oidc.accountId);
  assert.notEqual(oidc.accountId, existing.id);
});

test("OIDC: nonce and signature are checked; allowed domains and the org claim restrict sign-in", async () => {
  const email = `ivan-${randomUUID().slice(0, 8)}@company.test`;
  const ok = await authorize("oidc", {
    sub: `o-${randomUUID()}`,
    email,
    email_verified: true,
    name: "Иван",
  });
  assert.equal(ok.location, "/start");
  assert.ok(ok.accountId);
  const badNonce = await authorize(
    "oidc",
    { sub: `o-${randomUUID()}`, email },
    { nonce: () => "not-the-nonce" },
  );
  assert.match(badNonce.location, /idp_error=state/);
  const forged = await authorize(
    "oidc",
    { sub: `o-${randomUUID()}`, email },
    { forgeSignature: true },
  );
  assert.match(forged.location, /idp_error=provider/);
  config.OIDC_ALLOWED_DOMAINS = ["company.test"];
  config.OIDC_ORG_CLAIM = "groups";
  config.OIDC_ORG_VALUE = "polka-users";
  try {
    const outside = await authorize("oidc", {
      sub: `o-${randomUUID()}`,
      email: "someone@elsewhere.test",
      email_verified: true,
      groups: ["polka-users"],
    });
    assert.match(outside.location, /idp_error=domain/);
    const notInGroup = await authorize("oidc", {
      sub: `o-${randomUUID()}`,
      email,
      email_verified: true,
      groups: ["other"],
    });
    assert.match(notInGroup.location, /idp_error=domain/);
    const member = await authorize("oidc", {
      sub: `o-${randomUUID()}`,
      email: `m-${randomUUID().slice(0, 6)}@company.test`,
      email_verified: true,
      groups: ["polka-users"],
    });
    assert.ok(member.accountId);
  } finally {
    config.OIDC_ALLOWED_DOMAINS = [];
    config.OIDC_ORG_CLAIM = undefined;
    config.OIDC_ORG_VALUE = undefined;
  }
});

test("a blocked shelf cannot sign in through its provider", async () => {
  const sub = `b-${randomUUID()}`;
  const first = await authorize("yandex", { sub, email: `${sub}@ya.ru` });
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [
    first.accountId,
  ]);
  const refused = await authorize("yandex", { sub, email: `${sub}@ya.ru` });
  assert.match(refused.location, /idp_error=blocked/);
  assert.equal(refused.session, undefined);
});

test("invite mode and the daily budget apply to new shelves from providers", async () => {
  config.EMAIL_SIGNUP = "invite";
  try {
    const refused = await authorize("yandex", {
      sub: `i-${randomUUID()}`,
      email: `x-${randomUUID().slice(0, 6)}@yandex.ru`,
    });
    assert.match(refused.location, /idp_error=signup/);
    config.EMAIL_SIGNUP_ALLOW = ["@invited.test"];
    const invited = await authorize("yandex", {
      sub: `i-${randomUUID()}`,
      email: `x-${randomUUID().slice(0, 6)}@invited.test`,
    });
    assert.ok(invited.accountId);
  } finally {
    config.EMAIL_SIGNUP = "open";
    config.EMAIL_SIGNUP_ALLOW = [];
  }
});

test("linking from settings binds the provider to the signed-in shelf, once", async () => {
  const owner = await emailAccount(`g-${randomUUID().slice(0, 8)}@gmail.test`);
  const linkStart = await app.inject({
    method: "POST",
    url: "/api/auth/idp/yandex/link",
    headers: { origin, cookie: owner.cookie },
    payload: {},
  });
  assert.equal(linkStart.statusCode, 200, linkStart.body);
  // Without the Origin check passing, no link starts.
  const foreign = await app.inject({
    method: "POST",
    url: "/api/auth/idp/yandex/link",
    headers: { origin: "https://evil.example", cookie: owner.cookie },
    payload: {},
  });
  assert.equal(foreign.statusCode, 403);
  const sub = `l-${randomUUID()}`;
  const begun = {
    location: new URL(linkStart.json().location),
    flow: cookieFrom(linkStart, "polka_idp")!,
    ip: address(),
  };
  const linked = await authorize(
    "yandex",
    { sub, email: `${sub}@yandex.ru` },
    { start: begun },
  );
  assert.equal(linked.location, "/settings/agents?linked=1#sign-in");
  // Linking keeps the current session rather than issuing another.
  assert.equal(linked.session, undefined);
  assert.equal((await identities("yandex", sub))[0].account_id, owner.id);
  // The same provider account cannot be linked to a second shelf.
  const other = await emailAccount(`h-${randomUUID().slice(0, 8)}@gmail.test`);
  const again = await app.inject({
    method: "POST",
    url: "/api/auth/idp/yandex/link",
    headers: { origin, cookie: other.cookie },
    payload: {},
  });
  const second = await authorize(
    "yandex",
    { sub, email: `${sub}@yandex.ru` },
    {
      start: {
        location: new URL(again.json().location),
        flow: cookieFrom(again, "polka_idp")!,
        ip: address(),
      },
    },
  );
  assert.match(second.location, /idp_error=linked/);
  // Settings list it; unlinking works while the email remains a way in.
  const listed = await app.inject({
    method: "GET",
    url: "/api/account/identities",
    headers: { cookie: owner.cookie },
  });
  assert.deepEqual(
    listed.json().identities.map((item: any) => item.provider),
    ["yandex"],
  );
  const unlinked = await app.inject({
    method: "POST",
    url: "/api/account/identities/yandex/unlink",
    headers: { origin, cookie: owner.cookie },
    payload: {},
  });
  assert.equal(unlinked.statusCode, 200, unlinked.body);
  assert.equal((await identities("yandex", sub)).length, 0);
});

test("the only way in cannot be unlinked", async () => {
  const sub = String(Math.floor(Math.random() * 1e9));
  const shelf = await authorize("vk", { sub });
  const cookie = `polka_session=${shelf.session}`;
  const refused = await app.inject({
    method: "POST",
    url: "/api/account/identities/vk/unlink",
    headers: { origin, cookie },
    payload: {},
  });
  assert.equal(refused.statusCode, 409);
});

test("a deletion request erases the account's identities", async () => {
  const sub = `d-${randomUUID()}`;
  const shelf = await authorize("yandex", { sub, email: `${sub}@yandex.ru` });
  assert.equal((await identities("yandex", sub)).length, 1);
  await db.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1",
    [shelf.accountId],
  );
  assert.equal((await identities("yandex", sub)).length, 0);
});

test("organisation access: a verified domain joins the library once; a revoked member stays out", async () => {
  const admin = await emailAccount(
    `admin-${randomUUID().slice(0, 8)}@example.test`,
  );
  const created = await app.inject({
    method: "POST",
    url: "/api/template-libraries",
    headers: { origin, cookie: admin.cookie },
    payload: { name: "Шаблоны компании" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const libraryId = created.json().id as string;
  const domain = `org-${randomUUID().slice(0, 6)}.test`;
  config.ORG_DOMAINS = [{ domain, libraryId, role: "reader" }];
  try {
    const members = async () =>
      (
        await db.query(
          "SELECT account_id,role,state FROM template_library_members WHERE library_id=$1 AND role<>'admin' ORDER BY joined_at",
          [libraryId],
        )
      ).rows;
    const sub = `org-${randomUUID()}`;
    const employee = await authorize("yandex", { sub, email: `e@${domain}` });
    assert.deepEqual(await members(), [
      { account_id: employee.accountId, role: "reader", state: "active" },
    ]);
    const [event] = (
      await db.query(
        "SELECT action,new_role FROM template_library_events WHERE library_id=$1 AND target_account_id=$2",
        [libraryId, employee.accountId],
      )
    ).rows;
    assert.deepEqual(event, {
      action: "template_library.domain_joined",
      new_role: "reader",
    });
    // An unverified address of the same domain (VK) joins nothing.
    const unverified = await authorize("vk", {
      sub: String(Math.floor(Math.random() * 1e9)),
      email: `u@${domain}`,
    });
    assert.ok(unverified.accountId);
    assert.equal((await members()).length, 1);
    // The administrator revokes the employee; the next sign-in does not undo it.
    await db.query(
      "UPDATE template_library_members SET state='revoked',revoked_at=now() WHERE library_id=$1 AND account_id=$2",
      [libraryId, employee.accountId],
    );
    await authorize("yandex", { sub, email: `e@${domain}` });
    assert.deepEqual(
      (await members()).map((row: any) => row.state),
      ["revoked"],
    );
    // The installation's own IdP can grant a library to everyone it lets in.
    config.OIDC_ORG_LIBRARY = { libraryId, role: "curator" };
    const staff = await authorize("oidc", { sub: `o-${randomUUID()}` });
    assert.ok(
      (await members()).some(
        (row: any) =>
          row.account_id === staff.accountId && row.role === "curator",
      ),
    );
  } finally {
    config.ORG_DOMAINS = [];
    config.OIDC_ORG_LIBRARY = null;
  }
});

test("return paths stay on this installation", () => {
  assert.equal(
    safeReturnPath("/oauth/consent?request=1"),
    "/oauth/consent?request=1",
  );
  for (const bad of [
    "//evil.example",
    "https://evil.example",
    "/\\evil",
    "/./\\evil",
    "javascript:alert(1)",
    " /x",
  ])
    assert.equal(safeReturnPath(bad), null, bad);
});
