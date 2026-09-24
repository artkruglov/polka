// One person, one shelf (docs/specs/SIGN_IN_PROVIDERS.md § 1, § 8, § 10):
// a browser that remembers a shelf is asked before a provider or a code opens
// another one; the consent page names the shelf a connector will save to; a
// connector may start on a provisional shelf that shares nothing until it is
// claimed (claiming attaches, a collision merges); an OAuth agent can hand its
// owner a one-time sign-in link. Яндекс ID is played by a local mock.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createMcpServer } from "../apps/server/mcp-server.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { pendingForTests } from "../apps/server/sign-in-pending.ts";
import { providerEndpoints } from "../apps/server/sign-in-providers.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { runMaintenanceCleanup } from "../scripts/maintenance-cleanup.ts";
import { createMaintenanceObjectStore } from "../scripts/maintenance-adapters.ts";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

const app = await createApp();
const origin = config.APP_ORIGIN;
const saved = { ...config };
const password = randomBytes(24).toString("hex");
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const address = () =>
  `2001:db8:1e::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

// ---------------------------------------------------------------------------
// Яндекс ID, played locally

type Person = { sub: string; email?: string; name?: string };
const codes = new Map<string, { person: Person; challenge: string }>();
const tokens = new Map<string, Person>();
let server: Server;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (
        !grant ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== grant.challenge
      )
        return send(400, { error: "invalid_grant" });
      const access = randomBytes(16).toString("hex");
      tokens.set(access, grant.person);
      return send(200, { access_token: access });
    }
    if (url.pathname === "/info") {
      const person = tokens.get(
        String(req.headers.authorization).replace("OAuth ", ""),
      );
      if (!person) return send(401, {});
      return send(200, {
        id: person.sub,
        default_email: person.email,
        real_name: person.name,
      });
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  providerEndpoints.yandex = {
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    userInfo: `${base}/info`,
  };
  Object.assign(config, {
    YANDEX_CLIENT_ID: "ya-client",
    YANDEX_CLIENT_SECRET: "ya-secret",
    YANDEX_EMAIL_VERIFIED: true,
    SIGN_IN_PROVIDERS: ["yandex"],
    EMAIL_SIGNUP: "open",
    EMAIL_SIGNUP_DOMAINS: "any",
    EMAIL_LOGIN_DOMAINS: "any",
    EMAIL_SIGNUP_DAILY_LIMIT: 100000,
    EMAIL_SIGNUP_DAILY_PER_IP: 1000,
    MAIL_MODE: "local",
  });
});

after(async () => {
  Object.assign(config, saved);
  server.close();
  await app.close();
  await db.end();
  s3.destroy();
});

const cookieOf = (
  response: { cookies: Array<{ name: string; value: string; [key: string]: any }> },
  name: string,
) => response.cookies.find((cookie) => cookie.name === name);

/** Starts Яндекс ID sign-in (known=1 when the browser has a hint). */
async function startYandex(options: { known?: boolean; next?: string } = {}) {
  const query = new URLSearchParams({ next: options.next ?? "/start" });
  if (options.known) query.set("known", "1");
  const ip = address();
  const response = await app.inject({
    method: "GET",
    url: `/api/auth/idp/yandex/start?${query}`,
    remoteAddress: ip,
  });
  assert.equal(response.statusCode, 303, response.body);
  return {
    location: new URL(response.headers.location as string),
    flow: cookieOf(response, "polka_idp")!.value,
    ip,
  };
}

/** The mock «authorizes» `person`; Полка handles the return. */
async function returnFromYandex(
  begun: { location: URL; flow: string; ip: string },
  person: Person,
) {
  const code = randomBytes(12).toString("hex");
  codes.set(code, {
    person,
    challenge: begun.location.searchParams.get("code_challenge")!,
  });
  const query = new URLSearchParams({
    code,
    state: begun.location.searchParams.get("state")!,
  });
  const response = await app.inject({
    method: "GET",
    url: `/api/auth/idp/yandex/callback?${query}`,
    remoteAddress: begun.ip,
    headers: { cookie: `polka_idp=${begun.flow}` },
  });
  assert.equal(response.statusCode, 303, response.body);
  return response;
}

async function passwordOwner(prefix: string) {
  const account = await createAccount(
    `${prefix}-${randomBytes(4).toString("hex")}`,
    password,
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress: address(),
    headers: { origin },
    payload: { name: account.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  return {
    ...account,
    cookie: `polka_session=${cookieOf(login, "polka_session")!.value}`,
  };
}

const post = (
  url: string,
  cookie: string,
  payload: unknown = {},
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url,
    remoteAddress: address(),
    headers: { origin, cookie, "content-type": "application/json", ...headers },
    payload: JSON.stringify(payload),
  });

const accountsWithEmail = async (email: string) =>
  (await db.query("SELECT id FROM accounts WHERE email=$1", [email])).rowCount;

// ---------------------------------------------------------------------------
// 1. «Похоже, у вас уже есть полка»

test("a known browser is asked before Яндекс ID opens a new shelf; signing in to the existing one links it", async () => {
  const existing = await passwordOwner("artem");
  const sub = `ya-${randomUUID()}`;
  const email = `artem.${sub.slice(3, 11)}@yandex.ru`;
  const next = "/oauth/consent?request=4d7b2a39-8a8e-4f7f-9a0e-0d1f2f3a4b5c";
  const back = await returnFromYandex(await startYandex({ known: true, next }), {
    sub,
    email,
    name: "Артём",
  });
  // Nothing was created and the browser is not signed in.
  assert.equal(cookieOf(back, "polka_session"), undefined);
  assert.equal(await accountsWithEmail(email), 0);
  const location = back.headers.location as string;
  assert.equal(location, `/signup/choose?${new URLSearchParams({ next })}`);
  // The provider's data never reaches a URL.
  for (const secret of [sub, email, "Артём", encodeURIComponent(email)])
    assert.ok(!location.includes(secret), secret);
  const pending = cookieOf(back, "polka_idp_pending")!;
  assert.equal(pending.httpOnly, true);
  assert.equal(pending.path, "/api/auth/idp");
  assert.ok(!pending.value.includes(sub));
  const pendingCookie = `polka_idp_pending=${pending.value}`;
  const shown = await app.inject({
    method: "GET",
    url: "/api/auth/idp/pending",
    headers: { cookie: pendingCookie },
  });
  assert.equal(shown.statusCode, 200);
  assert.deepEqual(shown.json(), {
    provider: "yandex",
    providerName: "Яндекс ID",
    next,
  });
  assert.ok(!shown.body.includes(email));

  // «Войти в существующую полку»: the person signed in with the login; the
  // page then asks to link. A foreign Origin is refused like every POST.
  const foreign = await post(
    "/api/auth/idp/pending/link",
    `${existing.cookie}; ${pendingCookie}`,
    {},
    { origin: "https://evil.example" },
  );
  assert.equal(foreign.statusCode, 403);
  const linked = await post(
    "/api/auth/idp/pending/link",
    `${existing.cookie}; ${pendingCookie}`,
  );
  assert.equal(linked.statusCode, 200, linked.body);
  assert.deepEqual(linked.json(), { providerName: "Яндекс ID", next });
  const {
    rows: [identity],
  } = await db.query(
    "SELECT account_id FROM account_identities WHERE provider='yandex' AND subject=$1",
    [sub],
  );
  assert.equal(identity.account_id, existing.id);
  assert.equal(await accountsWithEmail(email), 0);
  // Used once.
  const again = await post(
    "/api/auth/idp/pending/link",
    `${existing.cookie}; ${pendingCookie}`,
  );
  assert.equal(again.statusCode, 410);
  // From now on Яндекс ID opens that shelf directly, hint or not.
  const direct = await returnFromYandex(await startYandex({ known: true }), {
    sub,
    email,
  });
  assert.equal(direct.headers.location, "/start");
  const session = cookieOf(direct, "polka_session")!.value;
  const {
    rows: [row],
  } = await db.query("SELECT account_id FROM sessions WHERE hash=$1", [
    sha256(session),
  ]);
  assert.equal(row.account_id, existing.id);
});

test("«Создать новую полку» still opens one; without the hint nothing is asked", async () => {
  const sub = `ya-${randomUUID()}`;
  const email = `new.${sub.slice(3, 11)}@yandex.ru`;
  const back = await returnFromYandex(await startYandex({ known: true }), {
    sub,
    email,
  });
  const pendingCookie = `polka_idp_pending=${cookieOf(back, "polka_idp_pending")!.value}`;
  const created = await post("/api/auth/idp/pending/create", pendingCookie);
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(created.json(), { next: "/start" });
  assert.ok(cookieOf(created, "polka_session"));
  assert.equal(await accountsWithEmail(email), 1);

  const other = `ya-${randomUUID()}`;
  const plain = await returnFromYandex(await startYandex(), {
    sub: other,
    email: `plain.${other.slice(3, 11)}@yandex.ru`,
  });
  assert.equal(plain.headers.location, "/start");
  assert.ok(cookieOf(plain, "polka_session"));
});

test("a waiting sign-in expires and cannot be used from another browser", async () => {
  const sub = `ya-${randomUUID()}`;
  const back = await returnFromYandex(await startYandex({ known: true }), {
    sub,
    email: `late.${sub.slice(3, 11)}@yandex.ru`,
  });
  const value = cookieOf(back, "polka_idp_pending")!.value;
  // Another browser has no cookie; a forged one does not open.
  assert.equal(
    (await post("/api/auth/idp/pending/create", "")).statusCode,
    410,
  );
  assert.equal(
    (
      await post(
        "/api/auth/idp/pending/create",
        `polka_idp_pending=${value.slice(0, -4)}AAAA`,
      )
    ).statusCode,
    410,
  );
  pendingForTests.expireAll();
  const late = await post(
    "/api/auth/idp/pending/create",
    `polka_idp_pending=${value}`,
  );
  assert.equal(late.statusCode, 410);
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM account_identities WHERE provider='yandex' AND subject=$1",
        [sub],
      )
    ).rowCount,
    0,
  );
});

// ---------------------------------------------------------------------------
// 2. A code for an address without a shelf, in a browser that knows one

async function challenge(email: string) {
  const id = randomUUID(),
    code = String(10_000_000 + Math.floor(Math.random() * 89_999_999)),
    browser = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at)
     VALUES($1,$2,$3,$4,'local',now()+interval '10 minutes')`,
    [
      id,
      email,
      createHmac("sha256", config.LINK_KEY)
        .update(`email:${id}:${code}`)
        .digest("hex"),
      sha256(browser),
    ],
  );
  return { id, code, cookie: `polka_email_challenge=${browser}` };
}

test("a code for a new address asks first when the browser knows a shelf", async () => {
  const email = `fresh-${randomUUID()}@example.test`;
  const pending = await challenge(email);
  const asked = await post("/api/auth/email/verify", pending.cookie, {
    id: pending.id,
    code: pending.code,
    knownShelf: true,
  });
  assert.equal(asked.statusCode, 409, asked.body);
  assert.equal(asked.json().reason, "new_shelf");
  assert.equal(cookieOf(asked, "polka_session"), undefined);
  assert.equal(await accountsWithEmail(email), 0);
  // «Создать новую полку»: the same code, now with the answer.
  const created = await post("/api/auth/email/verify", pending.cookie, {
    id: pending.id,
    code: pending.code,
    knownShelf: true,
    createNew: true,
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().created, true);
  assert.equal(await accountsWithEmail(email), 1);
  // An address that has a shelf is never asked.
  const known = await challenge(email);
  const signedIn = await post("/api/auth/email/verify", known.cookie, {
    id: known.id,
    code: known.code,
    knownShelf: true,
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  assert.equal(signedIn.json().created, false);
});

// ---------------------------------------------------------------------------
// 3. The consent page names the shelf; provisional shelves

async function oauthClient() {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/register",
    remoteAddress: address(),
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { client_id: string }).client_id;
}

/** The connector sends the browser to /oauth/authorize. */
async function authorizeRequest(clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const response = await app.inject({
    method: "GET",
    url: `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "s1",
      resource: MCP_AUDIENCE,
    })}`,
    remoteAddress: address(),
  });
  assert.equal(response.statusCode, 302, response.body);
  const location = new URL(response.headers.location as string, origin);
  return {
    clientId,
    verifier,
    requestId: location.searchParams.get("request")!,
    browser: `polka_oauth=${cookieOf(response, "polka_oauth")!.value}`,
  };
}

const details = (cookie: string, requestId: string) =>
  app.inject({
    method: "GET",
    url: `/oauth/authorize/details?request=${requestId}`,
    remoteAddress: address(),
    headers: { cookie },
  });

/** Approves the request and exchanges the code: an OAuth access token. */
async function approve(
  cookie: string,
  request: Awaited<ReturnType<typeof authorizeRequest>>,
  scopes: string[] = ["context", "capture", "share"],
) {
  const csrf = await post("/api/agent-connections/csrf", cookie);
  assert.equal(csrf.statusCode, 200, csrf.body);
  const decided = await post(
    "/oauth/authorize/decision",
    `${cookie}; ${request.browser}`,
    {
      request: request.requestId,
      decision: "approve",
      scopes,
    },
    { "x-polka-csrf": csrf.json().csrfToken },
  );
  assert.equal(decided.statusCode, 200, decided.body);
  const code = new URL(decided.json().redirectTo).searchParams.get("code")!;
  const exchanged = await app.inject({
    method: "POST",
    url: "/oauth/token",
    remoteAddress: address(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: request.verifier,
      client_id: request.clientId,
      resource: MCP_AUDIENCE,
    }).toString(),
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  return exchanged.json().access_token as string;
}

const page = (heading: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head><body><h1>${heading}</h1><p>${randomUUID()}</p></body></html>`;

const publish = (bearer: string, title: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    payload: JSON.stringify({
      key: randomUUID(),
      title,
      html: page(title),
      expiresInDays: 7,
    }),
  });

test("the consent page says which shelf the connector will save to", async () => {
  const owner = await passwordOwner("consent");
  const request = await authorizeRequest(await oauthClient());
  const shown = await details(`${owner.cookie}; ${request.browser}`, request.requestId);
  assert.equal(shown.statusCode, 200, shown.body);
  assert.deepEqual(shown.json().account, {
    name: owner.name,
    methods: [`логин ${owner.name}`],
    provisional: false,
  });
});

/** «Начать без регистрации» on the consent page. */
async function startProvisional() {
  const request = await authorizeRequest(await oauthClient());
  const started = await post(
    "/oauth/authorize/provisional",
    request.browser,
    { request: request.requestId },
  );
  assert.equal(started.statusCode, 200, started.body);
  const session = cookieOf(started, "polka_session")!;
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, "Strict");
  assert.equal(session.maxAge, 30 * 86_400);
  const cookie = `polka_session=${session.value}`;
  const {
    rows: [row],
  } = await db.query(
    "SELECT a.id,t.id AS tenant FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN tenants t ON t.owner_id=a.id WHERE s.hash=$1",
    [sha256(session.value)],
  );
  return { request, cookie, id: row.id as string, tenant: row.tenant as string };
}

test("«Начать без регистрации» needs a real consent request; the second agent lands in the same shelf", async () => {
  const request = await authorizeRequest(await oauthClient());
  // No Origin, no browser cookie of the request, an unknown request: refused.
  const noOrigin = await app.inject({
    method: "POST",
    url: "/oauth/authorize/provisional",
    remoteAddress: address(),
    headers: { cookie: request.browser, "content-type": "application/json" },
    payload: JSON.stringify({ request: request.requestId }),
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal(
    (await post("/oauth/authorize/provisional", "", { request: request.requestId }))
      .statusCode,
    410,
  );
  assert.equal(
    (
      await post("/oauth/authorize/provisional", request.browser, {
        request: randomUUID(),
      })
    ).statusCode,
    410,
  );

  const shelf = await startProvisional();
  const session = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { cookie: shelf.cookie },
  });
  assert.equal(session.json().account.provisional, true);
  assert.equal(session.json().account.name, "Временная полка");
  const shown = await details(
    `${shelf.cookie}; ${shelf.request.browser}`,
    shelf.request.requestId,
  );
  assert.equal(shown.statusCode, 200, shown.body);
  assert.deepEqual(shown.json().account, {
    name: "Временная полка",
    methods: [],
    provisional: true,
  });
  const first = await approve(shelf.cookie, shelf.request);
  // A second agent in the same browser: no new shelf.
  const second = await authorizeRequest(await oauthClient());
  const again = await post("/oauth/authorize/provisional", `${shelf.cookie}; ${second.browser}`, {
    request: second.requestId,
  });
  assert.equal(again.statusCode, 409);
  const secondToken = await approve(shelf.cookie, second);
  const saved = [await publish(first, "Первое"), await publish(secondToken, "Второе")];
  for (const response of saved) {
    assert.equal(response.statusCode, 200, response.body);
    const {
      rows: [artifact],
    } = await db.query("SELECT tenant_id FROM artifacts WHERE id=$1", [
      response.json().artifactId,
    ]);
    assert.equal(artifact.tenant_id, shelf.tenant);
  }
  const {
    rows: [signup],
  } = await db.query(
    "SELECT props FROM analytics_events WHERE name='signup_completed' AND props->>'method'='provisional' LIMIT 1",
  );
  assert.ok(signup);
});

test("a provisional shelf saves privately but gives no link until it is claimed", async () => {
  const shelf = await startProvisional();
  const bearer = await approve(shelf.cookie, shelf.request);
  const published = await publish(bearer, "Черновик");
  assert.equal(published.statusCode, 200, published.body);
  const body = published.json();
  assert.equal(body.state, "saved");
  assert.equal(body.url, null);
  assert.equal(body.claimUrl, `${origin}/claim`);
  assert.match(body.linkUnavailableReason, /не закреплена/);
  // The web share button says the same, with the address.
  const {
    rows: [artifact],
  } = await db.query("SELECT latest_revision_id FROM artifacts WHERE id=$1", [
    body.artifactId,
  ]);
  const shared = await post(`/api/artifacts/${body.artifactId}/share`, shelf.cookie, {
    expectedRevisionId: artifact.latest_revision_id,
    expiresInDays: 7,
  });
  assert.equal(shared.statusCode, 403);
  assert.equal(shared.json().claimUrl, `${origin}/claim`);
  assert.equal(
    (await db.query("SELECT 1 FROM shares WHERE artifact_id=$1", [body.artifactId]))
      .rowCount,
    0,
  );

  // Claiming with Яндекс ID attaches it to THIS shelf.
  const link = await post("/api/auth/idp/yandex/link", shelf.cookie);
  assert.equal(link.statusCode, 200, link.body);
  const sub = `ya-${randomUUID()}`;
  const email = `claim.${sub.slice(3, 11)}@yandex.ru`;
  const begun = {
    location: new URL(link.json().location),
    flow: cookieOf(link, "polka_idp")!.value,
    ip: address(),
  };
  const back = await returnFromYandex(begun, { sub, email, name: "Вера" });
  assert.equal(back.headers.location, "/?claimed=1");
  const {
    rows: [claimed],
  } = await db.query(
    "SELECT email,claimed_at,display_name FROM accounts WHERE id=$1",
    [shelf.id],
  );
  assert.equal(claimed.email, email);
  assert.ok(claimed.claimed_at);
  assert.equal(claimed.display_name, "Вера");
  assert.equal(await accountsWithEmail(email), 1);
  const now = await publish(bearer, "Теперь со ссылкой");
  assert.equal(now.statusCode, 200, now.body);
  assert.equal(now.json().claimUrl, undefined);
  assert.ok(now.json().url);
});

test("a code to a new address claims the provisional shelf in the same browser", async () => {
  const shelf = await startProvisional();
  const email = `claim-${randomUUID()}@example.test`;
  const pending = await challenge(email);
  const verified = await post(
    "/api/auth/email/verify",
    `${shelf.cookie}; ${pending.cookie}`,
    { id: pending.id, code: pending.code },
  );
  assert.equal(verified.statusCode, 200, verified.body);
  assert.deepEqual(verified.json(), { ok: true, claimed: true });
  const {
    rows: [account],
  } = await db.query("SELECT email,claimed_at FROM accounts WHERE id=$1", [
    shelf.id,
  ]);
  assert.equal(account.email, email);
  assert.ok(account.claimed_at);
  assert.equal(await accountsWithEmail(email), 1);
});

test("a claim that meets an existing shelf offers to merge, and the merge keeps the agent", async () => {
  const existing = await passwordOwner("owner");
  const sub = `ya-${randomUUID()}`;
  await db.query(
    `INSERT INTO account_identities(id,account_id,provider,subject,email,email_verified)
     VALUES($1,$2,'yandex',$3,NULL,false)`,
    [randomUUID(), existing.id, sub],
  );
  const shelf = await startProvisional();
  const bearer = await approve(shelf.cookie, shelf.request);
  const work = (await publish(bearer, "Из Claude")).json();
  const link = await post("/api/auth/idp/yandex/link", shelf.cookie);
  const back = await returnFromYandex(
    {
      location: new URL(link.json().location),
      flow: cookieOf(link, "polka_idp")!.value,
      ip: address(),
    },
    { sub },
  );
  assert.equal(back.headers.location, "/claim?collision=1");
  assert.equal(cookieOf(back, "polka_session"), undefined);
  const claimCookie = `polka_claim=${cookieOf(back, "polka_claim")!.value}`;
  const shown = await app.inject({
    method: "GET",
    url: "/api/account/claim",
    headers: { cookie: `${shelf.cookie}; ${claimCookie}` },
  });
  assert.equal(shown.statusCode, 200, shown.body);
  const { connections, ...collision } = shown.json().collision;
  assert.deepEqual(collision, {
    method: "yandex",
    methodName: "Яндекс ID",
    targetName: existing.name,
    works: 1,
  });
  // Every agent that would move is its own line; the person ticks theirs.
  assert.equal(connections.length, 1);
  assert.equal(connections[0].name, "Claude");
  const merged = await post(
    "/api/account/claim/merge",
    `${shelf.cookie}; ${claimCookie}`,
    { connections: [connections[0].id] },
  );
  assert.equal(merged.statusCode, 200, merged.body);
  const session = cookieOf(merged, "polka_session")!.value;
  const {
    rows: [row],
  } = await db.query("SELECT account_id FROM sessions WHERE hash=$1", [
    sha256(session),
  ]);
  assert.equal(row.account_id, existing.id);
  const {
    rows: [artifact],
  } = await db.query("SELECT tenant_id FROM artifacts WHERE id=$1", [
    work.artifactId,
  ]);
  assert.equal(artifact.tenant_id, existing.tenant);
  // The connector now saves to the existing shelf, and links work there.
  const after = await publish(bearer, "После объединения");
  assert.equal(after.statusCode, 200, after.body);
  assert.ok(after.json().url);
  const {
    rows: [event],
  } = await db.query(
    "SELECT actor FROM moderation_events WHERE action='account.merged' AND account_id=$1",
    [shelf.id],
  );
  assert.equal(event.actor, "signup");
  const {
    rows: [provisional],
  } = await db.query(
    "SELECT disabled,deletion_requested_at FROM accounts WHERE id=$1",
    [shelf.id],
  );
  assert.equal(provisional.disabled, true);
  assert.ok(provisional.deletion_requested_at, "the emptied source is deleted");
});

test("unticked agents do not move; a source claimed meanwhile is not merged", async () => {
  const existing = await passwordOwner("unticked");
  const sub = `ya-${randomUUID()}`;
  await db.query(
    `INSERT INTO account_identities(id,account_id,provider,subject,email,email_verified)
     VALUES($1,$2,'yandex',$3,NULL,false)`,
    [randomUUID(), existing.id, sub],
  );
  const collide = async () => {
    const shelf = await startProvisional();
    const bearer = await approve(shelf.cookie, shelf.request);
    assert.equal((await publish(bearer, "Работа")).statusCode, 200);
    const link = await post("/api/auth/idp/yandex/link", shelf.cookie);
    const back = await returnFromYandex(
      {
        location: new URL(link.json().location),
        flow: cookieOf(link, "polka_idp")!.value,
        ip: address(),
      },
      { sub },
    );
    return {
      shelf,
      bearer,
      claimCookie: `polka_claim=${cookieOf(back, "polka_claim")!.value}`,
    };
  };
  const first = await collide();
  const merged = await post(
    "/api/account/claim/merge",
    `${first.shelf.cookie}; ${first.claimCookie}`,
  );
  assert.equal(merged.statusCode, 200, merged.body);
  // Nobody ticked the agent: its token no longer works anywhere.
  assert.equal((await publish(first.bearer, "После")).statusCode, 401);

  const second = await collide();
  // Claimed in another tab meanwhile: «Объединить» refuses (В6).
  await db.query(
    "UPDATE accounts SET claimed_at=now() WHERE id=$1",
    [second.shelf.id],
  );
  const refused = await post(
    "/api/account/claim/merge",
    `${second.shelf.cookie}; ${second.claimCookie}`,
  );
  assert.equal(refused.statusCode, 409, refused.body);
  const {
    rows: [still],
  } = await db.query("SELECT disabled FROM accounts WHERE id=$1", [
    second.shelf.id,
  ]);
  assert.equal(still.disabled, false);
});

test("a password sign-in from a provisional browser with works asks too; cancel keeps things as they were", async () => {
  const existing = await passwordOwner("pw");
  const shelf = await startProvisional();
  const bearer = await approve(shelf.cookie, shelf.request);
  assert.equal((await publish(bearer, "Сохранено")).statusCode, 200);
  const login = await post("/api/login", shelf.cookie, {
    name: existing.name,
    password,
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.deepEqual(login.json(), { ok: true, collision: true });
  assert.equal(cookieOf(login, "polka_session"), undefined);
  const claimCookie = `polka_claim=${cookieOf(login, "polka_claim")!.value}`;
  const sessions = async () =>
    (await db.query("SELECT 1 FROM sessions WHERE account_id=$1", [existing.id]))
      .rowCount;
  const held = await sessions();
  const cancelled = await post(
    "/api/account/claim/cancel",
    `${shelf.cookie}; ${claimCookie}`,
  );
  assert.equal(cancelled.statusCode, 200);
  assert.equal(await sessions(), held! - 1);
  const me = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { cookie: shelf.cookie },
  });
  assert.equal(me.json().account.id, shelf.id);
});

function maintenanceScope() {
  return {
    signal: new AbortController().signal,
    transaction: async <R>(operation: (client: any) => Promise<R>) => {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const value = await operation(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

test("without the deletion pipeline maintenance deletes an idle provisional shelf, objects included", async () => {
  const idle = await startProvisional();
  const bearer = await approve(idle.cookie, idle.request);
  const saved = (await publish(bearer, "Забытая работа")).json();
  const {
    rows: [revision],
  } = await db.query(
    "SELECT object_key,object_version FROM revisions WHERE artifact_id=$1",
    [saved.artifactId],
  );
  assert.ok(revision.object_key.startsWith(`${idle.tenant}/`));
  await db.query(
    "UPDATE accounts SET provisional_at=now()-interval '40 days' WHERE id=$1",
    [idle.id],
  );
  await db.query(
    `UPDATE agent_connections SET created_at=now()-interval '40 days',
            last_seen_at=now()-interval '35 days' WHERE account_id=$1`,
    [idle.id],
  );
  await db.query(
    "UPDATE revisions SET created_at=now()-interval '35 days' WHERE tenant_id=$1",
    [idle.tenant],
  );
  await db.query("DELETE FROM sessions WHERE account_id=$1", [idle.id]);
  const storage = createMaintenanceObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: "us-east-1",
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  });
  try {
    const result = await runMaintenanceCleanup(maintenanceScope(), storage, {
      provisionalIdleDays: 30,
    });
    assert.ok(result.provisionalShelvesRetired >= 1);
  } finally {
    storage.close();
  }
  await assert.rejects(
    s3.send(
      new HeadObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: revision.object_key,
        VersionId: revision.object_version,
      }),
    ),
  );
  const {
    rows: [left],
  } = await db.query(
    `SELECT a.disabled,a.deletion_requested_at IS NOT NULL AS deleting,
            (SELECT count(*) FROM artifacts WHERE tenant_id=$2) AS works,
            (SELECT count(*) FROM agent_connections WHERE tenant_id=$2) AS connections
       FROM accounts a WHERE a.id=$1`,
    [idle.id, idle.tenant],
  );
  assert.equal(left.disabled, true);
  assert.equal(left.deleting, true);
  assert.equal(Number(left.works), 0);
  assert.equal(Number(left.connections), 0);
  // The agent's token is dead.
  assert.equal((await publish(bearer, "Ещё")).statusCode, 401);
});

test("maintenance deletes an idle provisional shelf and leaves a live one", async () => {
  const idle = await startProvisional();
  const live = await startProvisional();
  await db.query(
    "UPDATE accounts SET provisional_at=now()-interval '40 days' WHERE id=ANY($1::uuid[])",
    [[idle.id, live.id]],
  );
  await db.query(
    "UPDATE agent_connections SET created_at=now()-interval '40 days' WHERE account_id=$1",
    [idle.id],
  );
  await db.query("DELETE FROM sessions WHERE account_id=$1", [idle.id]);
  const result = await runMaintenanceCleanup(
    maintenanceScope(),
    {
      listVersions: async () => ({ versions: [], deleteMarkers: [], truncated: false }),
      deleteVersion: async () => undefined,
    },
    {
      provisionalRetirement: {
        idleDays: 30,
        policyVersion: "test-1",
        purgeMaxHours: 24,
        backupRetentionMaxDays: 30,
      },
    },
  );
  assert.ok(result.provisionalShelvesRetired >= 1);
  const rows = (
    await db.query(
      `SELECT a.id,a.disabled,d.state FROM accounts a
         LEFT JOIN account_deletions d ON d.account_id=a.id
        WHERE a.id=ANY($1::uuid[])`,
      [[idle.id, live.id]],
    )
  ).rows;
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId[idle.id].disabled, true);
  assert.equal(byId[idle.id].state, "access_revoked_pending_purge");
  assert.equal(byId[live.id].disabled, false);
  assert.equal(byId[live.id].state, null);
  const {
    rows: [job],
  } = await db.query("SELECT phase FROM account_purge_jobs WHERE account_id=$1", [
    idle.id,
  ]);
  assert.equal(job.phase, "awaiting_revoke_ledger");
});

// ---------------------------------------------------------------------------
// 4. A sign-in link from the agent

const signInLink = (bearer: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/sign-in-link",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: "{}",
  });

test("for a claimed shelf the agent gets a sign-in hint without a secret", async () => {
  const owner = await passwordOwner("hint");
  const request = await authorizeRequest(await oauthClient());
  // Even with the sign_in permission: a claimed shelf is never entered by link.
  const bearer = await approve(`${owner.cookie}; ${request.browser}`, request, [
    "context",
    "sign_in",
  ]);
  const issued = await signInLink(bearer);
  assert.equal(issued.statusCode, 200, issued.body);
  const body = issued.json();
  assert.equal(body.kind, "hint");
  const url = new URL(body.url);
  assert.equal(`${url.origin}${url.pathname}`, `${origin}/signin`);
  assert.equal(url.hash, "");
  assert.equal(
    (
      await db.query(
        `SELECT 1 FROM agent_sign_in_links l JOIN agent_connections c ON c.id=l.connection_id
          WHERE c.account_id=$1`,
        [owner.id],
      )
    ).rowCount,
    0,
  );
  const hint = await app.inject({
    method: "GET",
    url: `/api/auth/shelf-hint?${new URLSearchParams({ h: url.searchParams.get("shelf")! })}`,
    remoteAddress: address(),
  });
  assert.equal(hint.statusCode, 200, hint.body);
  assert.deepEqual(hint.json(), {
    displayName: owner.name,
    providers: [],
    email: null,
    password: true,
  });
  // A forged hint opens nothing.
  const forged = await app.inject({
    method: "GET",
    url: `/api/auth/shelf-hint?h=${"A".repeat(80)}`,
    remoteAddress: address(),
  });
  assert.equal(forged.statusCode, 410);
});

test("a context-only grant gets no sign-in token; new connections start without the permission", async () => {
  const shelf = await startProvisional();
  const bearer = await approve(shelf.cookie, shelf.request, [
    "context",
    "capture",
  ]);
  const refused = await signInLink(bearer);
  assert.equal(refused.statusCode, 403, refused.body);
  const {
    rows: [connection],
  } = await db.query(
    "SELECT sign_in_links FROM agent_connections WHERE account_id=$1",
    [shelf.id],
  );
  assert.equal(connection.sign_in_links, false);
  // The migration's default: a connection that existed before is off too.
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'old',ARRAY['context','sign_in'],$5,now()+interval '1 day')`,
    [id, shelf.tenant, shelf.id, sha256(randomUUID()), MCP_AUDIENCE],
  );
  const {
    rows: [old],
  } = await db.query("SELECT sign_in_links FROM agent_connections WHERE id=$1", [
    id,
  ]);
  assert.equal(old.sign_in_links, false);
});

/** A provisional shelf whose agent was granted «Давать ссылку для входа». */
async function linkingShelf() {
  const shelf = await startProvisional();
  const bearer = await approve(shelf.cookie, shelf.request, [
    "context",
    "capture",
    "sign_in",
  ]);
  return { ...shelf, bearer };
}

test("a link's weak session does not survive the claim and never hands out links (Б1)", async () => {
  const shelf = await linkingShelf();
  const saved = (await publish(shelf.bearer, "Работа для ссылки")).json();
  const token = new URL((await signInLink(shelf.bearer)).json().url).hash.slice(1);
  const entered = await post("/api/auth/enter", "", { token });
  assert.equal(entered.statusCode, 200, entered.body);
  const weak = `polka_session=${cookieOf(entered, "polka_session")!.value}`;
  assert.equal(cookieOf(entered, "polka_session")!.maxAge, 86_400, "a day");
  const {
    rows: [artifact],
  } = await db.query("SELECT latest_revision_id FROM artifacts WHERE id=$1", [
    saved.artifactId,
  ]);
  const share = (cookie: string) =>
    post(`/api/artifacts/${saved.artifactId}/share`, cookie, {
      expectedRevisionId: artifact.latest_revision_id,
      expiresInDays: 7,
    });
  // Before the claim: refused as a weak session.
  const before = await share(weak);
  assert.equal(before.statusCode, 403, before.body);
  assert.equal(before.json().reason, "agent_link_session");
  // The owner claims from the browser that opened the shelf.
  const email = `b1-${randomUUID()}@example.test`;
  const pending = await challenge(email);
  const claimed = await post(
    "/api/auth/email/verify",
    `${shelf.cookie}; ${pending.cookie}`,
    { id: pending.id, code: pending.code },
  );
  assert.deepEqual(claimed.json(), { ok: true, claimed: true });
  // The link's session is gone: no share, no session at all.
  const after = await share(weak);
  assert.equal(after.statusCode, 401, after.body);
  assert.equal(
    (
      await app.inject({ method: "GET", url: "/api/me", headers: { cookie: weak } })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM sessions WHERE account_id=$1 AND assurance='agent_link'",
        [shelf.id],
      )
    ).rowCount,
    0,
  );
  // The owner's own session still works and now shares.
  const owner = await share(shelf.cookie);
  assert.equal(owner.statusCode, 200, owner.body);
});

test("temporary shelves have their own daily budget with a clear refusal (П5)", async () => {
  const ip = address();
  await db.query(
    `INSERT INTO login_limits VALUES($1,$2,now()+interval '24 hours')
     ON CONFLICT(key) DO UPDATE SET attempts=$2,reset_at=now()+interval '24 hours'`,
    [sha256(`provisional-ip-day:${ip}`), 20],
  );
  const request = await authorizeRequest(await oauthClient());
  const refused = await app.inject({
    method: "POST",
    url: "/oauth/authorize/provisional",
    remoteAddress: ip,
    headers: { origin, cookie: request.browser, "content-type": "application/json" },
    payload: JSON.stringify({ request: request.requestId }),
  });
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().reason, "provisional_limit");
  assert.match(refused.json().message, /временных полок/);
  // The sign-up budget of that address is untouched by temporary shelves.
  const {
    rows: [signups],
  } = await db.query("SELECT attempts FROM login_limits WHERE key=$1", [
    sha256(`email-signup-ip:${ip}`),
  ]);
  assert.equal(signups, undefined);
});

test("a provisional shelf's link: the page shows it first, spends it on a click, and gives a weak session", async () => {
  const shelf = await linkingShelf();
  const issued = await signInLink(shelf.bearer);
  assert.equal(issued.statusCode, 200, issued.body);
  const { url, expiresAt, kind } = issued.json();
  assert.equal(kind, "link");
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, `${origin}/enter`);
  assert.equal(parsed.search, "");
  const token = parsed.hash.slice(1);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const minutes = (Date.parse(expiresAt) - Date.now()) / 60_000;
  assert.ok(minutes > 4.9 && minutes <= 5.01, String(minutes));
  assert.equal(
    (await db.query("SELECT 1 FROM agent_sign_in_links WHERE token_hash=$1", [token]))
      .rowCount,
    0,
  );
  // Loading the page (and a link scanner) only looks: twice, nothing spent.
  for (let i = 0; i < 2; i++) {
    const preview = await post("/api/auth/enter/preview", "", { token });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json(), {
      shelfName: "Временная полка",
      clientName: "Claude",
      current: null,
    });
  }
  assert.equal(
    (
      await db.query(
        "SELECT consumed_at FROM agent_sign_in_links WHERE token_hash=$1",
        [sha256(token)],
      )
    ).rows[0].consumed_at,
    null,
  );
  // A browser signed in elsewhere is never switched silently.
  const other = await passwordOwner("other");
  const shown = await post("/api/auth/enter/preview", other.cookie, { token });
  assert.equal(shown.json().current.name, other.name);
  const silent = await post("/api/auth/enter", other.cookie, { token });
  assert.equal(silent.statusCode, 409);
  assert.equal(silent.json().reason, "signed_in");
  // A foreign page cannot post it.
  const foreign = await app.inject({
    method: "POST",
    url: "/api/auth/enter",
    remoteAddress: address(),
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    payload: JSON.stringify({ token }),
  });
  assert.equal(foreign.statusCode, 403);
  // The click.
  const entered = await post("/api/auth/enter", other.cookie, {
    token,
    replace: true,
  });
  assert.equal(entered.statusCode, 200, entered.body);
  assert.equal(entered.json().clientName, "Claude");
  const session = cookieOf(entered, "polka_session")!;
  const weak = `polka_session=${session.value}`;
  const {
    rows: [row],
  } = await db.query("SELECT account_id,assurance FROM sessions WHERE hash=$1", [
    sha256(session.value),
  ]);
  assert.equal(row.account_id, shelf.id);
  assert.equal(row.assurance, "agent_link");
  assert.equal(
    (await post("/api/auth/enter", "", { token })).statusCode,
    410,
    "once",
  );
  // The weak session browses...
  const me = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { cookie: weak },
  });
  assert.equal(me.json().account.assurance, "agent_link");
  // ...but cannot claim, link, manage agents or delete.
  for (const [path, body] of [
    ["/api/auth/idp/yandex/link", {}],
    ["/api/agent-connections/csrf", {}],
    ["/api/account/deletion-csrf", {}],
  ] as const) {
    const refused = await post(path, weak, body);
    assert.equal(refused.statusCode, 403, `${path}: ${refused.body}`);
  }
  // A code to a new address signs in for real and does not attach it here.
  const email = `weak-${randomUUID()}@example.test`;
  const pending = await challenge(email);
  const verified = await post(
    "/api/auth/email/verify",
    `${weak}; ${pending.cookie}`,
    { id: pending.id, code: pending.code },
  );
  assert.equal(verified.statusCode, 200, verified.body);
  assert.notEqual(verified.json().claimed, true);
  const {
    rows: [account],
  } = await db.query("SELECT email,claimed_at FROM accounts WHERE id=$1", [
    shelf.id,
  ]);
  assert.equal(account.email, null);
  assert.equal(account.claimed_at, null);
  // The journal names the connection, never the token.
  const everything = JSON.stringify(
    (await db.query("SELECT * FROM audit_outbox WHERE tenant_id=$1", [shelf.tenant]))
      .rows,
  );
  assert.match(everything, /auth\.agent_link_used/);
  assert.ok(!everything.includes(token));
});

test("from a link's weak session a real sign-in offers to carry works over, never attaching the identity", async () => {
  const shelf = await linkingShelf();
  assert.equal((await publish(shelf.bearer, "Черновик")).statusCode, 200);
  const token = new URL((await signInLink(shelf.bearer)).json().url).hash.slice(1);
  const entered = await post("/api/auth/enter", "", { token });
  const weak = `polka_session=${cookieOf(entered, "polka_session")!.value}`;
  // Яндекс ID from the weak session: an ordinary sign-in (a new shelf here).
  const query = new URLSearchParams({ next: "/" });
  const ip = address();
  const started = await app.inject({
    method: "GET",
    url: `/api/auth/idp/yandex/start?${query}`,
    remoteAddress: ip,
    headers: { cookie: weak },
  });
  assert.equal(started.statusCode, 303);
  const sub = `ya-${randomUUID()}`;
  const back = await returnFromYandex(
    {
      location: new URL(started.headers.location as string),
      flow: cookieOf(started, "polka_idp")!.value,
      ip,
    },
    { sub, email: `carry.${sub.slice(3, 11)}@yandex.ru` },
  );
  assert.equal(back.headers.location, "/claim?collision=1");
  assert.equal(cookieOf(back, "polka_session"), undefined);
  const {
    rows: [identity],
  } = await db.query(
    "SELECT account_id FROM account_identities WHERE provider='yandex' AND subject=$1",
    [sub],
  );
  assert.notEqual(identity.account_id, shelf.id, "not attached to the provisional shelf");
  const claimCookie = `polka_claim=${cookieOf(back, "polka_claim")!.value}`;
  const merged = await post("/api/account/claim/merge", `${weak}; ${claimCookie}`);
  assert.equal(merged.statusCode, 200, merged.body);
  const {
    rows: [work],
  } = await db.query(
    "SELECT t.owner_id FROM artifacts a JOIN tenants t ON t.id=a.tenant_id WHERE a.title='Черновик' AND t.owner_id=$1",
    [identity.account_id],
  );
  assert.ok(work, "the works moved to the shelf signed in to");
});

test("expired links, static tokens, a switched-off connection and the hourly limit are refused", async () => {
  const shelf = await linkingShelf();
  const owner = { cookie: shelf.cookie, id: shelf.id, tenant: shelf.tenant };
  // Expired.
  const token = new URL((await signInLink(shelf.bearer)).json().url).hash.slice(1);
  await db.query(
    `UPDATE agent_sign_in_links SET created_at=now()-interval '10 minutes',
            expires_at=now()-interval '5 minutes' WHERE token_hash=$1`,
    [sha256(token)],
  );
  assert.equal((await post("/api/auth/enter", "", { token })).statusCode, 410);
  // A static token.
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,sign_in_links)
     VALUES($1,$2,$3,$4,'script',ARRAY['context','sign_in'],$5,now()+interval '1 day',true)`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), MCP_AUDIENCE],
  );
  const refused = await signInLink(secret);
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().message, /OAuth/);
  // The owner switches links off: new ones are refused, an unused one dies.
  const unusedIssued = await signInLink(shelf.bearer);
  assert.equal(unusedIssued.statusCode, 200, unusedIssued.body);
  const unused = new URL(unusedIssued.json().url).hash.slice(1);
  const {
    rows: [connection],
  } = await db.query(
    "SELECT id FROM agent_connections WHERE tenant_id=$1 AND oauth_client_id IS NOT NULL",
    [owner.tenant],
  );
  const listed = await app.inject({
    method: "GET",
    url: "/api/agent-connections",
    headers: { cookie: owner.cookie },
  });
  assert.equal(
    listed.json().find((item: { id: string }) => item.id === connection.id)
      .signInLinks,
    true,
  );
  const csrf = (await post("/api/agent-connections/csrf", owner.cookie)).json()
    .csrfToken;
  const off = await post(
    `/api/agent-connections/${connection.id}/sign-in-links`,
    owner.cookie,
    { enabled: false },
    { "x-polka-csrf": csrf },
  );
  assert.equal(off.statusCode, 200, off.body);
  assert.equal((await signInLink(shelf.bearer)).statusCode, 403);
  assert.equal(
    (await post("/api/auth/enter", "", { token: unused })).statusCode,
    410,
  );
  const on = await post(
    `/api/agent-connections/${connection.id}/sign-in-links`,
    owner.cookie,
    { enabled: true },
    { "x-polka-csrf": csrf },
  );
  assert.equal(on.statusCode, 200);
  // At most 5 links an hour per connection (3 were asked for above).
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await signInLink(shelf.bearer)).statusCode);
  assert.deepEqual(statuses.slice(0, 1), [200]);
  assert.ok(statuses.includes(429), statuses.join(","));
});

test("polka_open_shelf is offered to OAuth connections only", () => {
  const nil = "00000000-0000-0000-0000-000000000000";
  const tools = (oauth: boolean) =>
    Object.keys(
      (
        createMcpServer({
          accountId: nil,
          tenantId: nil,
          connectionId: nil,
          scopes: ["context"],
          audience: MCP_AUDIENCE,
          expiresAt: 0,
          oauth,
        }) as unknown as { _registeredTools: Record<string, unknown> }
      )._registeredTools,
    );
  assert.ok(tools(true).includes("polka_open_shelf"));
  assert.ok(!tools(false).includes("polka_open_shelf"));
});
