// Sign in with Google (docs/specs/SIGN_IN_PROVIDERS.md, «Google»), Google
// played by a local OpenID provider. The id_token is checked in full; an
// address counts only with email_verified === true; the Workspace `hd` is
// stored when present; linking and unlinking keep a way in; GOOGLE_SIGNUP=
// link-only opens, links by address and claims nothing; erasure takes Google
// identities with the rest.
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
import { SIGNED_UP_SQL } from "../apps/server/share-moderation.ts";
import {
  IdpError,
  providerEndpoints,
  resetOidcCache,
  verifyIdToken,
} from "../apps/server/sign-in-providers.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const saved = { ...config };
const savedEndpoints = { ...providerEndpoints.google };
const CLIENT = "google-client.apps.googleusercontent.com";
const SECRET = "GOCSPX-test-secret";

// ---------------------------------------------------------------------------
// The mock Google

type Person = {
  sub: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  given_name?: string;
  family_name?: string;
  hd?: string;
};
type Tamper = {
  aud?: string;
  iss?: string;
  exp?: number;
  forge?: boolean;
  nonce?: string;
};
const codes = new Map<
  string,
  { person: Person; challenge: string; nonce: string; tamper: Tamper }
>();
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const { privateKey: strangerKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "g1",
  alg: "RS256",
  use: "sig",
};
let base = "";
let issuer = "";
/** What Google's token endpoint last received (client auth, redirect). */
let lastTokenRequest: { authorization?: string; form: Record<string, string> } =
  { form: {} };

function sign(claims: Record<string, unknown>, forge = false) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "g1", typ: "JWT" }),
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

let server: Server;
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/google/.well-known/openid-configuration")
      return send(200, {
        issuer,
        authorization_endpoint: `${base}/google/o/oauth2/v2/auth`,
        token_endpoint: `${base}/google/token`,
        jwks_uri: `${base}/google/certs`,
      });
    if (url.pathname === "/google/certs") return send(200, { keys: [jwk] });
    if (url.pathname === "/google/token" && req.method === "POST") {
      const form = await readForm(req);
      lastTokenRequest = { authorization: req.headers.authorization, form };
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`
      )
        return send(401, { error: "invalid_client" });
      const grant = codes.get(form.code);
      codes.delete(form.code);
      if (
        !grant ||
        form.redirect_uri !== `${origin}/api/auth/idp/google/callback` ||
        createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !==
          grant.challenge
      )
        return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const { tamper, person } = grant;
      return send(200, {
        access_token: randomBytes(16).toString("hex"),
        token_type: "Bearer",
        id_token: sign(
          {
            iss: tamper.iss ?? issuer,
            azp: CLIENT,
            aud: tamper.aud ?? CLIENT,
            ...person,
            picture: "https://lh3.googleusercontent.com/a/avatar",
            nonce: tamper.nonce ?? grant.nonce,
            iat: now,
            exp: tamper.exp ?? now + 3600,
          },
          tamper.forge,
        ),
      });
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  issuer = `${base}/google`;
  providerEndpoints.google = {
    discovery: `${base}/google/.well-known/openid-configuration`,
  };
  Object.assign(config, {
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: SECRET,
    GOOGLE_SIGNUP: "on",
    SIGN_IN_PROVIDERS: ["google"],
    EMAIL_SIGNUP: "open",
    EMAIL_SIGNUP_DAILY_LIMIT: 100000,
    EMAIL_SIGNUP_DAILY_PER_IP: 1000,
  });
  resetOidcCache();
});

after(async () => {
  Object.assign(config, saved);
  providerEndpoints.google = savedEndpoints;
  resetOidcCache();
  server.close();
  await app.close();
  await db.end();
  s3.destroy();
});

// ---------------------------------------------------------------------------
// Driving the browser

const address = () =>
  `2001:db8:9e::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

const cookieFrom = (
  response: { cookies: Array<{ name: string; value: string }> },
  name: string,
) => response.cookies.find((cookie) => cookie.name === name)?.value;

type Begun = { location: URL; flow: string; ip: string };

async function start(query = "", ip = address()): Promise<Begun> {
  const response = await app.inject({
    method: "GET",
    url: `/api/auth/idp/google/start?next=%2Fstart${query}`,
    remoteAddress: ip,
  });
  assert.equal(response.statusCode, 303, response.body);
  return {
    location: new URL(response.headers.location as string),
    flow: cookieFrom(response, "polka_idp")!,
    ip,
  };
}

async function linkStart(cookie: string): Promise<Begun> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/idp/google/link",
    headers: { origin, cookie },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  return {
    location: new URL(response.json().location),
    flow: cookieFrom(response, "polka_idp")!,
    ip: address(),
  };
}

/** Google "authorizes" `person` and sends the browser back. */
async function signIn(
  person: Person,
  options: { tamper?: Tamper; begun?: Begun } = {},
) {
  const begun = options.begun ?? (await start());
  const params = begun.location.searchParams;
  const code = randomBytes(12).toString("hex");
  codes.set(code, {
    person,
    challenge: params.get("code_challenge")!,
    nonce: params.get("nonce")!,
    tamper: options.tamper ?? {},
  });
  const response = await app.inject({
    method: "GET",
    url: `/api/auth/idp/google/callback?${new URLSearchParams({ code, state: params.get("state")!, scope: "email profile openid" })}`,
    remoteAddress: begun.ip,
    headers: { cookie: `polka_idp=${begun.flow}` },
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

const googleIdentities = async (subject: string) =>
  (
    await db.query(
      `SELECT account_id,email,email_verified,hosted_domain
         FROM account_identities WHERE provider='google' AND subject=$1`,
      [subject],
    )
  ).rows;

async function emailAccount(email: string | null, provisional = false) {
  const id = randomUUID(),
    tenant = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,email_verified_at,display_name,provisional_at)
     VALUES($1,$2,'unused',$3,CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,$4,
            CASE WHEN $5 THEN now() END)`,
    [
      id,
      provisional ? `guest-${id}` : `email-${id}`,
      email,
      provisional ? "Временная полка" : null,
      provisional,
    ],
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
  return { id, cookie: `polka_session=${token}` };
}

const sub = () => String(100000000000000000000n + BigInt(Math.floor(Math.random() * 1e15)));

// ---------------------------------------------------------------------------

test("the Google button follows its client: listed when configured, 404 when not", async () => {
  const capabilities = (
    await app.inject({ method: "GET", url: "/api/capabilities" })
  ).json();
  assert.deepEqual(capabilities.signInProviders, [
    { id: "google", name: "Google", signup: true },
  ]);
  config.SIGN_IN_PROVIDERS = [];
  try {
    for (const url of [
      "/api/auth/idp/google/start",
      "/api/auth/idp/google/callback?code=x&state=y",
    ])
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
    assert.deepEqual(
      (await app.inject({ method: "GET", url: "/api/capabilities" })).json()
        .signInProviders,
      [],
    );
  } finally {
    config.SIGN_IN_PROVIDERS = ["google"];
  }
});

test("start: standard OIDC with PKCE, state, nonce and only the basic scopes", async () => {
  const { location, flow } = await start();
  const params = location.searchParams;
  assert.equal(location.origin + location.pathname, `${base}/google/o/oauth2/v2/auth`);
  assert.equal(params.get("client_id"), CLIENT);
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("scope"), "openid email profile");
  assert.equal(params.get("redirect_uri"), `${origin}/api/auth/idp/google/callback`);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.ok((params.get("state") ?? "").length >= 43);
  assert.ok((params.get("nonce") ?? "").length >= 43);
  assert.equal(params.get("prompt"), "select_account");
  assert.ok(flow);
  // Nothing about the flow is in the URL beyond what Google needs.
  assert.equal(params.get("code_verifier"), null);
});

test("a new person gets a shelf; the verified address, name and Workspace domain are kept", async () => {
  const subject = sub();
  const email = `Anna.${subject}@Company.test`;
  const first = await signIn({
    sub: subject,
    email,
    email_verified: true,
    name: "Анна Петрова",
    hd: "Company.test",
  });
  assert.equal(first.location, "/start");
  assert.ok(first.session && first.accountId);
  // Client authentication by HTTP Basic with the secret, PKCE verifier sent.
  assert.equal(lastTokenRequest.form.grant_type, "authorization_code");
  assert.ok(lastTokenRequest.form.code_verifier);
  assert.equal(lastTokenRequest.form.client_secret, undefined);
  const [account] = (
    await db.query(
      "SELECT name,email,email_verified_at,display_name FROM accounts WHERE id=$1",
      [first.accountId],
    )
  ).rows;
  assert.equal(account.name, `google-${first.accountId}`);
  assert.equal(account.email, email.toLowerCase());
  assert.ok(account.email_verified_at);
  assert.equal(account.display_name, "Анна Петрова");
  assert.deepEqual(await googleIdentities(subject), [
    {
      account_id: first.accountId,
      email: email.toLowerCase(),
      email_verified: true,
      hosted_domain: "company.test",
    },
  ]);
  // A self-signed-up Google shelf is a new account for moderation, not an
  // operator-created one.
  const [row] = (
    await db.query(
      `SELECT ${SIGNED_UP_SQL("account")} AS signed_up FROM accounts account WHERE id=$1`,
      [first.accountId],
    )
  ).rows;
  assert.equal(row.signed_up, true);
  // Again: the same shelf, one identity. A personal account has no hd.
  const again = await signIn({ sub: subject, email, email_verified: true });
  assert.equal(again.accountId, first.accountId);
  assert.equal((await googleIdentities(subject))[0].hosted_domain, null);
  const personal = sub();
  await signIn({
    sub: personal,
    email: `p-${personal}@gmail.test`,
    email_verified: true,
    given_name: "Пётр",
    family_name: "Иванов",
  });
  const [identity] = await googleIdentities(personal);
  assert.equal(identity.hosted_domain, null);
  const [named] = (
    await db.query("SELECT display_name FROM accounts WHERE id=$1", [
      identity.account_id,
    ])
  ).rows;
  assert.equal(named.display_name, "Пётр Иванов");
});

test("the id_token is refused with a foreign signature, audience, issuer, nonce or when expired", async () => {
  const cases: Array<[Tamper, RegExp]> = [
    [{ forge: true }, /idp_error=provider/],
    [{ aud: "someone-else.apps.googleusercontent.com" }, /idp_error=state/],
    [{ iss: "https://accounts.evil.test" }, /idp_error=state/],
    [{ nonce: "not-the-nonce" }, /idp_error=state/],
    [{ exp: Math.floor(Date.now() / 1000) - 600 }, /idp_error=state/],
  ];
  for (const [tamper, expected] of cases) {
    const subject = sub();
    const result = await signIn(
      { sub: subject, email: `${subject}@gmail.test`, email_verified: true },
      { tamper },
    );
    assert.match(result.location, expected, JSON.stringify(tamper));
    assert.equal(result.session, undefined);
    assert.equal((await googleIdentities(subject)).length, 0);
  }
});

test("Google's issuer is accepted with and without the scheme, nothing else", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expected = {
    issuer: "https://accounts.google.com",
    audience: CLIENT,
    nonce: "n-1",
    jwksUri: `${base}/google/certs`,
  };
  const claims = (iss: string) => ({
    iss,
    aud: CLIENT,
    azp: CLIENT,
    sub: "1",
    nonce: "n-1",
    iat: now,
    exp: now + 60,
  });
  for (const iss of ["https://accounts.google.com", "accounts.google.com"])
    assert.equal((await verifyIdToken(sign(claims(iss)), expected)).iss, iss);
  for (const iss of ["http://accounts.google.com", "accounts.google.com.evil.test"])
    await assert.rejects(
      verifyIdToken(sign(claims(iss)), expected),
      (error: unknown) => error instanceof IdpError && error.code === "state",
    );
  // The alias belongs to Google only: another issuer keeps its exact name.
  await assert.rejects(
    verifyIdToken(sign(claims("accounts.google.com")), {
      ...expected,
      issuer: "https://sso.company.test",
    }),
    IdpError,
  );
});

test("email_verified false (or anything but true) never links a shelf or gives it the address", async () => {
  const email = `vera-${randomUUID().slice(0, 8)}@gmail.test`;
  const existing = await emailAccount(email);
  for (const flag of [false, "true", undefined]) {
    const subject = sub();
    const result = await signIn({ sub: subject, email, email_verified: flag });
    assert.ok(result.accountId, String(flag));
    assert.notEqual(result.accountId, existing.id, String(flag));
    const [fresh] = (
      await db.query("SELECT email,email_verified_at FROM accounts WHERE id=$1", [
        result.accountId,
      ])
    ).rows;
    assert.deepEqual(fresh, { email: null, email_verified_at: null });
    const [identity] = await googleIdentities(subject);
    assert.equal(identity.email, email);
    assert.equal(identity.email_verified, false);
  }
  // Verified: the existing shelf opens and gets Google linked.
  const subject = sub();
  const verified = await signIn({ sub: subject, email, email_verified: true });
  assert.equal(verified.accountId, existing.id);
  assert.equal((await googleIdentities(subject))[0].account_id, existing.id);
});

test("linking from settings and unlinking; the last way in stays", async () => {
  const owner = await emailAccount(`l-${randomUUID().slice(0, 8)}@yandex.ru`);
  const subject = sub();
  const linked = await signIn(
    { sub: subject, email: `${subject}@gmail.test`, email_verified: true },
    { begun: await linkStart(owner.cookie) },
  );
  assert.equal(linked.location, "/settings/agents?linked=1#sign-in");
  assert.equal(linked.session, undefined);
  assert.equal((await googleIdentities(subject))[0].account_id, owner.id);
  const listed = (
    await app.inject({
      method: "GET",
      url: "/api/account/identities",
      headers: { cookie: owner.cookie },
    })
  ).json();
  assert.deepEqual(
    listed.identities.map((item: { provider: string; name: string }) => [
      item.provider,
      item.name,
    ]),
    [["google", "Google"]],
  );
  assert.deepEqual(listed.available, [
    { provider: "google", name: "Google", signup: true },
  ]);
  // The same Google account cannot be linked to a second shelf.
  const other = await emailAccount(`o-${randomUUID().slice(0, 8)}@yandex.ru`);
  const second = await signIn(
    { sub: subject, email: `${subject}@gmail.test`, email_verified: true },
    { begun: await linkStart(other.cookie) },
  );
  assert.match(second.location, /idp_error=linked/);
  // The address remains a way in: unlinking works.
  const unlink = (cookie: string) =>
    app.inject({
      method: "POST",
      url: "/api/account/identities/google/unlink",
      headers: { origin, cookie },
      payload: {},
    });
  assert.equal((await unlink(owner.cookie)).statusCode, 200);
  assert.equal((await googleIdentities(subject)).length, 0);
  // A shelf whose only way in is Google keeps it.
  const alone = sub();
  const shelf = await signIn({ sub: alone, email_verified: false });
  const refused = await unlink(`polka_session=${shelf.session}`);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().message, /единственный способ/);
  assert.equal((await googleIdentities(alone)).length, 1);
});

test("GOOGLE_SIGNUP=link-only: no new shelf, no link by address, no claim; a linked Google signs in", async () => {
  config.GOOGLE_SIGNUP = "link-only";
  try {
    const capabilities = (
      await app.inject({ method: "GET", url: "/api/capabilities" })
    ).json();
    assert.deepEqual(capabilities.signInProviders, [
      { id: "google", name: "Google", signup: false },
    ]);
    const accounts = async () =>
      Number((await db.query("SELECT count(*) FROM accounts")).rows[0].count);
    // A newcomer: refused, nothing created.
    const before = await accounts();
    const newcomer = sub();
    const refused = await signIn({
      sub: newcomer,
      email: `${newcomer}@gmail.test`,
      email_verified: true,
    });
    assert.match(refused.location, /^\/signup\?idp_error=link_only/);
    assert.equal(refused.session, undefined);
    assert.equal(await accounts(), before);
    assert.equal((await googleIdentities(newcomer)).length, 0);
    // A browser that knows a shelf is not asked «войти или создать»: the
    // answer is the same refusal.
    const known = await signIn(
      { sub: newcomer, email: `${newcomer}@gmail.test`, email_verified: true },
      { begun: await start("&known=1") },
    );
    assert.match(known.location, /idp_error=link_only/);
    // A verified address of an existing shelf does not link it either.
    const email = `k-${randomUUID().slice(0, 8)}@gmail.test`;
    const owner = await emailAccount(email);
    const byAddress = sub();
    const noLink = await signIn({ sub: byAddress, email, email_verified: true });
    assert.match(noLink.location, /idp_error=link_only/);
    assert.equal((await googleIdentities(byAddress)).length, 0);
    // The signed-in owner links it; then Google signs in to that shelf.
    const linked = await signIn(
      { sub: byAddress, email, email_verified: true },
      { begun: await linkStart(owner.cookie) },
    );
    assert.equal(linked.location, "/settings/agents?linked=1#sign-in");
    const signedIn = await signIn({ sub: byAddress, email, email_verified: true });
    assert.equal(signedIn.accountId, owner.id);
    assert.ok(signedIn.session);
    // A provisional shelf cannot be claimed by Google: refused before the
    // browser leaves, and at the callback too.
    const guest = await emailAccount(null, true);
    const claim = await app.inject({
      method: "POST",
      url: "/api/auth/idp/google/link",
      headers: { origin, cookie: guest.cookie },
      payload: {},
    });
    assert.equal(claim.statusCode, 403, claim.body);
    assert.equal(claim.json().reason, "link_only");
    config.GOOGLE_SIGNUP = "on";
    const begun = await linkStart(guest.cookie);
    config.GOOGLE_SIGNUP = "link-only";
    const late = sub();
    const lateClaim = await signIn(
      { sub: late, email: `${late}@gmail.test`, email_verified: true },
      { begun },
    );
    assert.match(lateClaim.location, /idp_error=link_only/);
    const [still] = (
      await db.query("SELECT claimed_at FROM accounts WHERE id=$1", [guest.id])
    ).rows;
    assert.equal(still.claimed_at, null);
    assert.equal((await googleIdentities(late)).length, 0);
    // «Закрепите полку» names no link-only provider.
    config.SIGN_IN_PROVIDERS = ["google"];
    const { claimMethods } = await import("../apps/server/provisional.ts");
    assert.doesNotMatch(claimMethods(), /Google/);
  } finally {
    config.GOOGLE_SIGNUP = "on";
  }
  // With GOOGLE_SIGNUP=on Google claims like any provider would.
  const { claimMethods } = await import("../apps/server/provisional.ts");
  assert.match(claimMethods(), /Google/);
});

test("erasure takes the Google identity and its Workspace domain; the column is Google's only", async () => {
  const subject = sub();
  const shelf = await signIn({
    sub: subject,
    email: `${subject}@erase.test`,
    email_verified: true,
    hd: "erase.test",
  });
  assert.equal((await googleIdentities(subject))[0].hosted_domain, "erase.test");
  await db.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1",
    [shelf.accountId],
  );
  assert.equal((await googleIdentities(subject)).length, 0);
  // Signing in with the same Google account again does not reach the shelf
  // being deleted, and no identity reappears for it.
  const [gone] = (
    await db.query(
      "SELECT count(*)::int AS n FROM account_identities WHERE account_id=$1",
      [shelf.accountId],
    )
  ).rows;
  assert.equal(gone.n, 0);
  const again = await signIn({
    sub: subject,
    email: `${subject}@erase.test`,
    email_verified: true,
  });
  assert.match(again.location, /idp_error=blocked/);
  assert.equal(again.session, undefined);
  assert.equal((await googleIdentities(subject)).length, 0);
  const other = await emailAccount(`c-${randomUUID().slice(0, 8)}@yandex.ru`);
  await assert.rejects(
    db.query(
      `INSERT INTO account_identities(id,account_id,provider,subject,hosted_domain)
       VALUES($1,$2,'yandex',$3,'company.test')`,
      [randomUUID(), other.id, `y-${randomUUID()}`],
    ),
    /account_identities_hosted_domain_check/,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO account_identities(id,account_id,provider,subject)
       VALUES($1,$2,'chatgpt',$3)`,
      [randomUUID(), other.id, `c-${randomUUID()}`],
    ),
    /account_identities_provider_check/,
  );
});
