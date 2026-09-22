import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import { s3 } from "../apps/server/storage.ts";
import { publishToolDescription } from "../apps/server/agent-publish.ts";

// The default suite runs static-only (HTML_LIVE_MODE=disabled), like the
// hosted installation a chat connector talks to.
const app = await createApp();
const origin = config.APP_ORIGIN;
const mcpHost = new URL(MCP_AUDIENCE).host;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const password = randomBytes(24).toString("hex");
const address = () =>
  `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Owner = { id: string; tenant: string; name: string; cookie: string };
let owner: Owner;

async function newOwner(prefix: string): Promise<Owner> {
  const account = await createAccount(
    `${prefix}-${randomBytes(5).toString("hex")}`,
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
    cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
  };
}

const form = (params: Record<string, string>) =>
  new URLSearchParams(params).toString();

async function register(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/oauth/register",
    remoteAddress: address(),
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
}

async function publicClient(name = "Claude", redirect = CLAUDE_CALLBACK) {
  const response = await register({
    client_name: name,
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { client_id: string; client_secret?: string };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function authorize(query: Record<string, string>) {
  const response = await app.inject({
    method: "GET",
    url: `/oauth/authorize?${form(query)}`,
    remoteAddress: address(),
  });
  assert.equal(response.statusCode, 302, response.body);
  const location = new URL(response.headers.location as string, origin);
  const browser = response.cookies.find((c) => c.name === "polka_oauth");
  return {
    location,
    requestId: location.searchParams.get("request"),
    browser: browser ? `polka_oauth=${browser.value}` : "",
  };
}

async function csrf(who: Owner) {
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-connections/csrf",
    remoteAddress: address(),
    headers: { origin, cookie: who.cookie, "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { csrfToken: string }).csrfToken;
}

async function decide(
  who: Owner,
  started: { requestId: string | null; browser: string },
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/oauth/authorize/decision",
    remoteAddress: address(),
    headers: {
      origin,
      cookie: `${who.cookie}; ${started.browser}`,
      "content-type": "application/json",
      "x-polka-csrf": await csrf(who),
      ...headers,
    },
    payload: { request: started.requestId, ...body },
  });
}

async function token(params: Record<string, string>, headers = {}) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    remoteAddress: address(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    payload: form(params),
  });
}

/** Register → authorize → approve → code, as Claude.ai drives it. */
async function approvedCode(
  who: Owner,
  options: { scope?: string; grant?: string[]; clientId?: string } = {},
) {
  const clientId = options.clientId ?? (await publicClient()).client_id;
  const { verifier, challenge } = pkce();
  const state = randomBytes(12).toString("base64url");
  const started = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: MCP_AUDIENCE,
    ...(options.scope ? { scope: options.scope } : {}),
  });
  assert.equal(started.location.pathname, "/oauth/consent");
  assert.ok(started.requestId);
  assert.ok(started.browser);
  const decided = await decide(who, started, {
    decision: "approve",
    scopes: options.grant ?? ["context", "capture", "read", "share"],
  });
  assert.equal(decided.statusCode, 200, decided.body);
  const redirect = new URL((decided.json() as any).redirectTo);
  assert.equal(`${redirect.origin}${redirect.pathname}`, CLAUDE_CALLBACK);
  assert.equal(redirect.searchParams.get("state"), state);
  assert.equal(redirect.searchParams.get("iss"), origin);
  return {
    clientId,
    verifier,
    code: redirect.searchParams.get("code")!,
  };
}

async function connect(
  who: Owner,
  options: Parameters<typeof approvedCode>[1] = {},
) {
  const grant = await approvedCode(who, options);
  const response = await token({
    grant_type: "authorization_code",
    code: grant.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: grant.verifier,
    client_id: grant.clientId,
    resource: MCP_AUDIENCE,
  });
  assert.equal(response.statusCode, 200, response.body);
  return { ...grant, tokens: response.json() as any };
}

async function mcp(
  bearer: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: address(),
    headers: {
      host: mcpHost,
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  if (response.statusCode !== 200)
    return { status: response.statusCode, response };
  const text = String(response.headers["content-type"]).startsWith(
    "text/event-stream",
  )
    ? response.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("")
    : response.body;
  return { status: 200, response, message: JSON.parse(text) };
}

const initialize = (bearer: string) =>
  mcp(bearer, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-ai", version: "1.0" },
  });

const htmlArtifact = (heading: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title><style>body{font-family:system-ui;margin:40px}h1{color:#1f4fff}</style></head><body><h1>${heading}</h1><p>A self-contained report produced in a chat conversation for the owner.</p></body></html>`;

async function publish(bearer: string, heading = "Chat report") {
  const called = await mcp(bearer, "tools/call", {
    name: "polka_publish",
    arguments: {
      key: randomUUID(),
      title: heading,
      html: htmlArtifact(heading),
    },
  });
  assert.equal(called.status, 200);
  assert.equal(called.message.error, undefined, JSON.stringify(called.message));
  assert.notEqual(
    called.message.result.isError,
    true,
    JSON.stringify(called.message),
  );
  return called.message.result.structuredContent as any;
}

before(async () => {
  owner = await newOwner("oauth");
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("discovery documents describe the MCP resource and its authorization server", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const response = await app.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200, path);
    assert.equal(response.headers["access-control-allow-origin"], "*");
    const body = response.json();
    assert.equal(body.resource, MCP_AUDIENCE);
    assert.deepEqual(body.authorization_servers, [origin]);
    assert.ok(body.scopes_supported.includes("capture"));
  }
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/oauth-authorization-server",
  });
  assert.equal(response.statusCode, 200);
  const metadata = response.json();
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${origin}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
  assert.equal(metadata.revocation_endpoint, `${origin}/oauth/revoke`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.response_types_supported, ["code"]);
  assert.deepEqual(metadata.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
});

test("unauthenticated /mcp answers 401 with a resource_metadata challenge", async () => {
  const missing = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { host: mcpHost, "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(missing.statusCode, 401);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  assert.equal(
    missing.headers["www-authenticate"],
    `Bearer resource_metadata="${metadataUrl}"`,
  );
  const invalid = await mcp(
    randomBytes(32).toString("base64url"),
    "tools/list",
  );
  assert.equal(invalid.status, 401);
  assert.equal(
    invalid.response.headers["www-authenticate"],
    `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
  );
});

test("dynamic client registration accepts https and loopback redirects only", async () => {
  const claude = await register(
    {
      client_name: "Claude",
      redirect_uris: [
        CLAUDE_CALLBACK,
        "https://claude.com/api/mcp/auth_callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      logo_uri: "https://claude.ai/logo.png",
    },
    // Server-to-server calls may carry any Origin; no browser session is read.
    { origin: "https://claude.ai" },
  );
  assert.equal(claude.statusCode, 201, claude.body);
  const registered = claude.json();
  assert.match(registered.client_id, /^pc_[A-Za-z0-9_-]{22}$/);
  assert.equal(registered.client_secret, undefined);
  assert.equal(registered.token_endpoint_auth_method, "none");
  assert.equal(registered.client_name, "Claude");

  const chatgpt = await register({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal(chatgpt.statusCode, 201, chatgpt.body);
  assert.match(chatgpt.json().client_secret, /^[A-Za-z0-9_-]{43}$/);

  const loopback = await register({
    redirect_uris: ["http://127.0.0.1:33418/callback"],
  });
  assert.equal(loopback.statusCode, 201, loopback.body);
  assert.equal(
    loopback.json().token_endpoint_auth_method,
    "client_secret_basic",
  );
  assert.equal(loopback.json().client_name, "MCP-клиент");

  for (const [body, error] of [
    [
      { redirect_uris: ["http://evil.example/callback"] },
      "invalid_redirect_uri",
    ],
    [{ redirect_uris: ["myapp://callback"] }, "invalid_redirect_uri"],
    [
      { redirect_uris: ["https://claude.ai/cb#fragment"] },
      "invalid_redirect_uri",
    ],
    [
      { redirect_uris: ["https://user:pw@claude.ai/cb"] },
      "invalid_redirect_uri",
    ],
    [{ redirect_uris: [] }, "invalid_client_metadata"],
    [
      { redirect_uris: [CLAUDE_CALLBACK], grant_types: ["password"] },
      "invalid_client_metadata",
    ],
    [
      { redirect_uris: [CLAUDE_CALLBACK], grant_types: ["refresh_token"] },
      "invalid_client_metadata",
    ],
    [
      { redirect_uris: [CLAUDE_CALLBACK], response_types: ["token"] },
      "invalid_client_metadata",
    ],
    [
      {
        redirect_uris: [CLAUDE_CALLBACK],
        token_endpoint_auth_method: "private_key_jwt",
      },
      "invalid_client_metadata",
    ],
  ] as const) {
    const response = await register(body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json().error, error, JSON.stringify(body));
  }
});

test("authorization request errors never redirect to an unregistered URI", async () => {
  const { client_id } = await publicClient();
  const { challenge } = pkce();
  const unknown = await authorize({
    response_type: "code",
    client_id: "pc_" + "x".repeat(22),
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  assert.equal(unknown.location.href, `${origin}/oauth/consent?error=client`);
  const foreign = await authorize({
    response_type: "code",
    client_id,
    redirect_uri: "https://evil.example/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  assert.equal(foreign.location.href, `${origin}/oauth/consent?error=redirect`);
  assert.equal(foreign.browser, "");

  for (const [query, error] of [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://evil.example/mcp" }, "invalid_target"],
  ] as const) {
    const started = await authorize({
      response_type: "code",
      client_id,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s-1",
      ...query,
    });
    // Pre-consent errors stay on Polka: a registered redirect is not trusted
    // enough for an automatic bounce (RFC 9700 §4.11.2).
    assert.equal(
      started.location.href,
      `${origin}/oauth/consent?error=${error}`,
    );
    assert.equal(started.browser, "");
  }
});

test("consent requires the owner's session, the starting browser, CSRF and same Origin", async () => {
  const { client_id } = await publicClient("Claude");
  const { challenge } = pkce();
  const started = await authorize({
    response_type: "code",
    client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "context capture share unknown:scope",
  });
  const details = (cookie: string) =>
    app.inject({
      method: "GET",
      url: `/oauth/authorize/details?request=${started.requestId}`,
      remoteAddress: address(),
      headers: { cookie },
    });
  assert.equal((await details(started.browser)).statusCode, 401);
  assert.equal((await details(owner.cookie)).statusCode, 410);
  const shown = await details(`${owner.cookie}; ${started.browser}`);
  assert.equal(shown.statusCode, 200, shown.body);
  const consent = shown.json();
  assert.equal(consent.client.name, "Claude");
  assert.equal(consent.client.redirectHost, "claude.ai");
  assert.deepEqual(consent.scopes, ["context", "capture", "share"]);
  assert.deepEqual(consent.defaultScopes, ["context", "capture", "share"]);

  const foreignOrigin = await decide(
    owner,
    started,
    { decision: "approve", scopes: ["context"] },
    { origin: "https://evil.example" },
  );
  assert.equal(foreignOrigin.statusCode, 403);
  const noCsrf = await decide(
    owner,
    started,
    { decision: "approve", scopes: ["context"] },
    { "x-polka-csrf": randomBytes(32).toString("base64url") },
  );
  assert.equal(noCsrf.statusCode, 403);
  const otherBrowser = await decide(
    owner,
    {
      ...started,
      browser: `polka_oauth=${randomBytes(32).toString("base64url")}`,
    },
    { decision: "approve", scopes: ["context"] },
  );
  assert.equal(otherBrowser.statusCode, 410);
  const widened = await decide(owner, started, {
    decision: "approve",
    scopes: ["context", "manage"],
  });
  assert.equal(widened.statusCode, 400);
  const withoutContext = await decide(owner, started, {
    decision: "approve",
    scopes: ["capture"],
  });
  assert.equal(withoutContext.statusCode, 400);

  const denied = await decide(owner, started, { decision: "deny" });
  assert.equal(denied.statusCode, 200, denied.body);
  const redirect = new URL(denied.json().redirectTo);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("code"), null);
  const again = await decide(owner, started, {
    decision: "approve",
    scopes: ["context"],
  });
  assert.equal(again.statusCode, 410);
});

test("full Claude.ai flow: code + PKCE → token → MCP publish → resolvable share link", async () => {
  const connected = await connect(owner);
  const tokens = connected.tokens;
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.match(tokens.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.scope, "context read capture share");

  const init = await initialize(tokens.access_token);
  assert.equal(init.status, 200);
  assert.equal(init.message.result.serverInfo.name, "polka");

  const listed = await mcp(tokens.access_token, "tools/list");
  const names = listed.message.result.tools.map((tool: any) => tool.name);
  for (const name of [
    "polka_context",
    "polka_list",
    "polka_capture",
    "polka_publish",
    "polka_share",
  ])
    assert.ok(names.includes(name), name);
  assert.ok(!names.includes("polka_trash"));
  const publishTool = listed.message.result.tools.find(
    (tool: any) => tool.name === "polka_publish",
  );
  assert.equal(publishTool.description, publishToolDescription());
  assert.match(publishTool.description, /React/);

  const published = await publish(tokens.access_token, "Quarterly chat report");
  assert.equal(published.state, "shared");
  assert.equal(published.htmlProfile, "static");
  assert.equal(published.scriptsRunForRecipients, false);
  assert.match(published.url, new RegExp(`^${origin}/s#[A-Za-z0-9_-]{43}$`));
  assert.equal(published.shelfUrl, `${origin}/works/${published.artifactId}`);
  const resolved = await app.inject({
    method: "POST",
    url: "/api/resolve",
    remoteAddress: address(),
    headers: { origin },
    payload: { token: new URL(published.url).hash.slice(1) },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().title, "Quarterly chat report");

  // The connection is an ordinary agent connection on the agents page.
  const listing = await app.inject({
    method: "GET",
    url: "/api/agent-connections",
    headers: { cookie: owner.cookie },
  });
  const connection = listing
    .json()
    .find((item: any) => item.kind === "oauth" && item.status === "seen");
  assert.ok(connection, listing.body);
  assert.equal(connection.name, "Claude");
  assert.equal(connection.audience, MCP_AUDIENCE);
  assert.deepEqual(connection.scopes, ["context", "read", "capture", "share"]);
  // Tokens are audience-bound to this MCP endpoint.
  await assert.rejects(
    authenticateServiceToken(tokens.access_token, "https://wrong.example/mcp"),
  );
  const stored = (
    await db.query(
      `SELECT
         (SELECT count(*)::int FROM agent_connections WHERE token_hash=$1) AS access_plain,
         (SELECT count(*)::int FROM oauth_refresh_tokens WHERE token_hash=$2) AS refresh_plain`,
      [tokens.access_token, tokens.refresh_token],
    )
  ).rows[0];
  assert.deepEqual(stored, { access_plain: 0, refresh_plain: 0 });
});

test("publish retries with the same key return the same saved work and link", async () => {
  const { tokens } = await connect(owner);
  const key = randomUUID();
  const call = () =>
    mcp(tokens.access_token, "tools/call", {
      name: "polka_publish",
      arguments: { key, title: "Retry", html: htmlArtifact("Retry") },
    });
  const first = (await call()).message.result.structuredContent;
  const second = (await call()).message.result.structuredContent;
  assert.equal(first.state, "shared");
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.shareId, first.shareId);
  assert.equal(second.url, first.url);
});

test("a wrong PKCE verifier fails and uses the code up", async () => {
  const grant = await approvedCode(owner);
  const exchange = (verifier: string) =>
    token({
      grant_type: "authorization_code",
      code: grant.code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      client_id: grant.clientId,
    });
  const wrong = await exchange(pkce().verifier);
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error, "invalid_grant");
  const right = await exchange(grant.verifier);
  assert.equal(right.statusCode, 400);
  assert.equal(right.json().error, "invalid_grant");
});

test("a replayed code is refused and revokes the tokens it issued", async () => {
  const connected = await connect(owner);
  assert.equal((await initialize(connected.tokens.access_token)).status, 200);
  const replay = await token({
    grant_type: "authorization_code",
    code: connected.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: connected.verifier,
    client_id: connected.clientId,
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error, "invalid_grant");
  assert.equal((await initialize(connected.tokens.access_token)).status, 401);
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: connected.tokens.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(refreshed.statusCode, 400);
  assert.equal(refreshed.json().error, "invalid_grant");
});

test("the code is bound to its redirect URI, client, lifetime and resource", async () => {
  const wrongRedirect = await approvedCode(owner);
  const redirected = await token({
    grant_type: "authorization_code",
    code: wrongRedirect.code,
    redirect_uri: "https://claude.com/api/mcp/auth_callback",
    code_verifier: wrongRedirect.verifier,
    client_id: wrongRedirect.clientId,
  });
  assert.equal(redirected.json().error, "invalid_grant");

  const otherClient = await approvedCode(owner);
  const stranger = await publicClient("Stranger");
  const stolen = await token({
    grant_type: "authorization_code",
    code: otherClient.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: otherClient.verifier,
    client_id: stranger.client_id,
  });
  assert.equal(stolen.json().error, "invalid_grant");

  const expired = await approvedCode(owner);
  await db.query(
    "UPDATE oauth_authorizations SET code_expires_at=now()-interval '1 second' WHERE code_hash=$1",
    [createHash("sha256").update(expired.code).digest("hex")],
  );
  const late = await token({
    grant_type: "authorization_code",
    code: expired.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: expired.verifier,
    client_id: expired.clientId,
  });
  assert.equal(late.json().error, "invalid_grant");

  const audience = await approvedCode(owner);
  const foreign = await token({
    grant_type: "authorization_code",
    code: audience.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: audience.verifier,
    client_id: audience.clientId,
    resource: "https://evil.example/mcp",
  });
  assert.equal(foreign.statusCode, 400);
  assert.equal(foreign.json().error, "invalid_target");

  const unsupported = await token({
    grant_type: "password",
    client_id: audience.clientId,
  });
  assert.equal(unsupported.json().error, "unsupported_grant_type");
  const unknownClient = await token({
    grant_type: "authorization_code",
    client_id: "pc_" + "y".repeat(22),
  });
  assert.equal(unknownClient.statusCode, 401);
  assert.equal(unknownClient.json().error, "invalid_client");
});

test("refresh tokens rotate; reusing a rotated one revokes the grant", async () => {
  const connected = await connect(owner);
  const first = connected.tokens;
  const rotated = await token({
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(rotated.statusCode, 200, rotated.body);
  const second = rotated.json();
  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal((await initialize(first.access_token)).status, 401);
  assert.equal((await initialize(second.access_token)).status, 200);

  const widened = await token({
    grant_type: "refresh_token",
    refresh_token: second.refresh_token,
    client_id: connected.clientId,
    scope: "context manage",
  });
  assert.equal(widened.json().error, "invalid_scope");

  // An immediate retry of the rotated token (a lost response, a parallel
  // refresh) is refused but does not end the grant.
  const retry = await token({
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(retry.statusCode, 400);
  assert.equal(retry.json().error, "invalid_grant");
  assert.equal((await initialize(second.access_token)).status, 200);

  // Outside the grace window the same reuse is treated as theft.
  await db.query(
    `UPDATE oauth_refresh_tokens
     SET created_at=created_at-interval '5 minutes',
         expires_at=expires_at-interval '5 minutes',
         rotated_at=rotated_at-interval '2 minutes'
     WHERE token_hash=$1`,
    [createHash("sha256").update(first.refresh_token).digest("hex")],
  );
  const reuse = await token({
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(reuse.statusCode, 400);
  assert.equal(reuse.json().error, "invalid_grant");
  assert.equal((await initialize(second.access_token)).status, 401);
  const afterTheft = await token({
    grant_type: "refresh_token",
    refresh_token: second.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(afterTheft.json().error, "invalid_grant");
});

test("the grace window covers only the live token's immediate predecessor", async () => {
  const connected = await connect(owner);
  const refresh = (value: string) =>
    token({
      grant_type: "refresh_token",
      refresh_token: value,
      client_id: connected.clientId,
    });
  const second = (await refresh(connected.tokens.refresh_token)).json();
  const third = (await refresh(second.refresh_token)).json();
  assert.ok(third.access_token);
  // The first token is two rotations old: reuse revokes even within 60 s.
  const stale = await refresh(connected.tokens.refresh_token);
  assert.equal(stale.json().error, "invalid_grant");
  assert.equal((await initialize(third.access_token)).status, 401);
  assert.equal(
    (await refresh(third.refresh_token)).json().error,
    "invalid_grant",
  );
});

test("form endpoints refuse JSON posing as form data and non-string values", async () => {
  const connected = await connect(owner);
  for (const url of ["/oauth/token", "/oauth/revoke"]) {
    const posing = await app.inject({
      method: "POST",
      url,
      remoteAddress: address(),
      headers: { "content-type": "application/json" },
      payload: {
        params: {
          grant_type: "refresh_token",
          refresh_token: connected.tokens.refresh_token,
          token: connected.tokens.refresh_token,
          client_id: connected.clientId,
          code_verifier: ["x".repeat(43)],
          scope: ["context"],
        },
        duplicate: false,
      },
    });
    assert.equal(posing.statusCode, 400, `${url} ${posing.body}`);
    assert.equal(posing.json().error, "invalid_request");
  }
  // Nothing above was applied: the grant still refreshes.
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: connected.tokens.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
});

test("a refused re-authorization over the quota keeps the previous connection", async () => {
  const crowded = await newOwner("oauth-quota");
  const { client_id } = await publicClient("Claude");
  const first = await connect(crowded, { clientId: client_id });
  // Twenty other live connections: more than the quota already (e.g. a race).
  for (let index = 0; index < 20; index++)
    await db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
       VALUES($1,$2,$3,$4,'filler',ARRAY['context'],$5,now()+interval '1 day')`,
      [
        randomUUID(),
        crowded.tenant,
        crowded.id,
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        MCP_AUDIENCE,
      ],
    );
  const grant = await approvedCode(crowded, { clientId: client_id });
  const refused = await token({
    grant_type: "authorization_code",
    code: grant.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: grant.verifier,
    client_id,
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, "invalid_grant");
  assert.equal((await initialize(first.tokens.access_token)).status, 200);
});

test("vendor names are reserved for the vendors' own redirect hosts", async () => {
  const name = async (client_name: string, redirect_uris: string[]) => {
    const response = await register({
      client_name,
      redirect_uris,
      token_endpoint_auth_method: "none",
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().client_name as string;
  };
  const unverified = " (имя не подтверждено)";
  assert.equal(await name("Claude", [CLAUDE_CALLBACK]), "Claude");
  assert.equal(
    await name("ChatGPT", [
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ]),
    "ChatGPT",
  );
  assert.equal(
    await name("Claude", ["https://evil.example/callback"]),
    `Claude${unverified}`,
  );
  assert.equal(
    await name("anthropic  helper", [
      CLAUDE_CALLBACK,
      "https://evil.example/cb",
    ]),
    `anthropic helper${unverified}`,
  );
  // Cyrillic lookalike letters do not get around the check.
  const lookalike = String.fromCharCode(0x0421) + "laude";
  assert.equal(
    await name(lookalike, ["https://evil.example/callback"]),
    `${lookalike}${unverified}`,
  );
  assert.equal(
    await name("Open AI", ["https://claude.ai/api/mcp/auth_callback"]),
    `Open AI${unverified}`,
  );
  assert.equal(await name("My agent", ["https://evil.example/cb"]), "My agent");
});

test("an expired access token needs a refresh", async () => {
  const connected = await connect(owner);
  await db.query(
    "UPDATE agent_connections SET access_expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [createHash("sha256").update(connected.tokens.access_token).digest("hex")],
  );
  assert.equal((await initialize(connected.tokens.access_token)).status, 401);
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: connected.tokens.refresh_token,
    client_id: connected.clientId,
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal((await initialize(refreshed.json().access_token)).status, 200);
});

test("revocation through /oauth/revoke and through the agents page ends the grant", async () => {
  const viaEndpoint = await connect(owner);
  const unknown = await app.inject({
    method: "POST",
    url: "/oauth/revoke",
    remoteAddress: address(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      token: randomBytes(32).toString("base64url"),
      client_id: viaEndpoint.clientId,
    }),
  });
  assert.equal(unknown.statusCode, 200);
  const revoked = await app.inject({
    method: "POST",
    url: "/oauth/revoke",
    remoteAddress: address(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      token: viaEndpoint.tokens.refresh_token,
      token_type_hint: "refresh_token",
      client_id: viaEndpoint.clientId,
    }),
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await initialize(viaEndpoint.tokens.access_token)).status, 401);
  const dead = await token({
    grant_type: "refresh_token",
    refresh_token: viaEndpoint.tokens.refresh_token,
    client_id: viaEndpoint.clientId,
  });
  assert.equal(dead.json().error, "invalid_grant");

  const viaPage = await connect(owner);
  const connectionId = (
    await db.query("SELECT id FROM agent_connections WHERE token_hash=$1", [
      createHash("sha256").update(viaPage.tokens.access_token).digest("hex"),
    ])
  ).rows[0].id;
  const pageRevoke = await app.inject({
    method: "POST",
    url: `/api/agent-connections/${connectionId}/revoke`,
    remoteAddress: address(),
    headers: {
      origin,
      cookie: owner.cookie,
      "content-type": "application/json",
      "x-polka-csrf": await csrf(owner),
    },
    payload: "{}",
  });
  assert.equal(pageRevoke.statusCode, 200, pageRevoke.body);
  assert.equal((await initialize(viaPage.tokens.access_token)).status, 401);
  const afterPage = await token({
    grant_type: "refresh_token",
    refresh_token: viaPage.tokens.refresh_token,
    client_id: viaPage.clientId,
  });
  assert.equal(afterPage.json().error, "invalid_grant");
});

test("without the link permission publish saves privately and says why", async () => {
  const limited = await newOwner("oauth-scope");
  const { tokens } = await connect(limited, { grant: ["context", "capture"] });
  assert.equal(tokens.scope, "context capture");
  const listed = await mcp(tokens.access_token, "tools/list");
  const names = listed.message.result.tools.map((tool: any) => tool.name);
  assert.ok(names.includes("polka_publish"));
  assert.ok(!names.includes("polka_share"));
  assert.ok(!names.includes("polka_list"));
  const result = await publish(tokens.access_token, "Private only");
  assert.equal(result.state, "saved");
  assert.equal(result.url, null);
  assert.match(result.linkUnavailableReason, /link permission/);
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM shares WHERE artifact_id=$1", [
          result.artifactId,
        ])
      ).rows[0].count,
    ),
    0,
  );
  const readOnly = await newOwner("oauth-read");
  const reader = await connect(readOnly, { grant: ["context", "read"] });
  const readerTools = (
    await mcp(reader.tokens.access_token, "tools/list")
  ).message.result.tools.map((tool: any) => tool.name);
  assert.ok(!readerTools.includes("polka_publish"));
});

test("a page that needs the network is saved but not linked", async () => {
  const { tokens } = await connect(owner);
  const called = await mcp(tokens.access_token, "tools/call", {
    name: "polka_publish",
    arguments: {
      key: randomUUID(),
      title: "CDN app",
      html: '<!doctype html><html><body><div id="root"></div><script src="https://cdn.example/react.js"></script></body></html>',
    },
  });
  const result = called.message.result.structuredContent;
  assert.equal(result.state, "saved");
  assert.equal(result.htmlProfile, "unsupported");
  assert.equal(result.url, null);
  assert.ok(result.linkUnavailableReason);
  if (config.HTML_LIVE_ENABLED) {
    // The build this call ran explains the refusal, not a request to run it.
    assert.equal(result.interactiveReady, false);
    assert.match(result.linkUnavailableReason, /script reference is not local/);
    assert.doesNotMatch(result.linkUnavailableReason, /polka_prepare_preview/);
  }
});

test("the publish guidance follows the interactive viewer setting", () => {
  const live = publishToolDescription(true);
  const staticOnly = publishToolDescription(false);
  assert.match(live, /JavaScript inline/);
  assert.match(live, /isolated sandbox on a separate viewer domain/);
  assert.match(live, /interactiveUnavailableReason/);
  assert.doesNotMatch(live, /static HTML snapshot/);
  assert.match(staticOnly, /static HTML snapshot/);
  assert.match(staticOnly, /scripts do not run/);
  assert.doesNotMatch(staticOnly, /JavaScript inline/);
  for (const text of [live, staticOnly]) assert.match(text, /under 5 MB/);
});

const scriptedArtifact = (extra = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Workbench</title><style>body{font-family:system-ui;margin:40px}</style></head><body><h1>Workbench prototype</h1><p>A small interactive prototype with a counter, produced in a chat conversation for the owner.</p>${extra}<button id="count">0</button><script>let n=0;document.getElementById("count").onclick=(event)=>{event.target.textContent=String(++n)}</script></body></html>`;

test("a scripted page is published interactive where the viewer is enabled", async () => {
  const { tokens } = await connect(owner);
  const key = randomUUID();
  const call = async () => {
    const called = await mcp(tokens.access_token, "tools/call", {
      name: "polka_publish",
      arguments: { key, title: "Workbench", html: scriptedArtifact() },
    });
    assert.equal(called.status, 200);
    return called.message.result.structuredContent as any;
  };
  const published = await call();
  assert.equal(published.state, "shared");
  assert.equal(published.htmlProfile, "limited");
  const {
    rows: [share],
  } = await db.query(
    `SELECT share.derivative_id,derivative.state FROM shares share
     LEFT JOIN revision_derivatives derivative ON derivative.id=share.derivative_id
     WHERE share.id=$1`,
    [published.shareId],
  );
  if (config.HTML_LIVE_ENABLED) {
    assert.equal(published.interactiveReady, true);
    assert.equal(published.interactiveUnavailableReason, undefined);
    assert.equal(published.scriptsRunForRecipients, true);
    assert.ok(share.derivative_id);
    assert.equal(share.state, "ready");
    const resolved = await app.inject({
      method: "POST",
      url: "/api/resolve",
      remoteAddress: address(),
      headers: { origin },
      payload: { token: new URL(published.url).hash.slice(1) },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().revision.inlineBuild.state, "ready");
  } else {
    // Static-only installation: the scripted page is linked as a static copy.
    assert.equal(published.interactiveReady, undefined);
    assert.equal(published.scriptsRunForRecipients, false);
    assert.equal(share.derivative_id, null);
  }
  // A retry replays the same save and the same link.
  const again = await call();
  assert.equal(again.artifactId, published.artifactId);
  assert.equal(again.shareId, published.shareId);
  assert.equal(again.url, published.url);
  assert.equal(again.scriptsRunForRecipients, published.scriptsRunForRecipients);
});

test("a failed interactive build keeps the save and a static link, with the reason", async () => {
  const { tokens } = await connect(owner);
  const called = await mcp(tokens.access_token, "tools/call", {
    name: "polka_publish",
    arguments: {
      key: randomUUID(),
      title: "Workbench with a link",
      html: scriptedArtifact('<a href="#count">To the counter</a>'),
    },
  });
  const result = called.message.result.structuredContent;
  assert.equal(result.state, "shared");
  assert.equal(result.scriptsRunForRecipients, false);
  if (config.HTML_LIVE_ENABLED) {
    assert.equal(result.interactiveReady, false);
    assert.match(
      result.interactiveUnavailableReason,
      /unhandled resource-bearing HTML attribute/,
    );
  } else assert.equal(result.interactiveUnavailableReason, undefined);
});

test("re-authorizing a client replaces its previous connection", async () => {
  const owner2 = await newOwner("oauth-replace");
  const { client_id } = await publicClient("Claude");
  const first = await connect(owner2, { clientId: client_id });
  const second = await connect(owner2, { clientId: client_id });
  assert.equal((await initialize(first.tokens.access_token)).status, 401);
  assert.equal((await initialize(second.tokens.access_token)).status, 200);
  const active = await db.query(
    `SELECT count(*)::int AS count FROM agent_connections
     WHERE tenant_id=$1 AND oauth_client_id=$2 AND revoked_at IS NULL`,
    [owner2.tenant, client_id],
  );
  assert.equal(active.rows[0].count, 1);
});

test("confidential clients authenticate with client_secret_post or client_secret_basic", async () => {
  const response = await register({
    client_name: "ChatGPT",
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "client_secret_post",
  });
  const { client_id, client_secret } = response.json();
  const grant = await approvedCode(owner, { clientId: client_id });
  const params = {
    grant_type: "authorization_code",
    code: grant.code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: grant.verifier,
  };
  const noSecret = await token({ ...params, client_id });
  assert.equal(noSecret.statusCode, 401);
  const badSecret = await token({
    ...params,
    client_id,
    client_secret: "x".repeat(43),
  });
  assert.equal(badSecret.statusCode, 401);
  const basic = await token(params, {
    authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString("base64")}`,
  });
  assert.equal(basic.statusCode, 200, basic.body);
  const rotated = await token({
    grant_type: "refresh_token",
    refresh_token: basic.json().refresh_token,
    client_id,
    client_secret,
  });
  assert.equal(rotated.statusCode, 200, rotated.body);
});

test("the token endpoint takes form bodies only, once per parameter", async () => {
  const json = await app.inject({
    method: "POST",
    url: "/oauth/token",
    remoteAddress: address(),
    headers: { "content-type": "application/json" },
    payload: { grant_type: "refresh_token" },
  });
  assert.equal(json.statusCode, 400);
  assert.equal(json.json().error, "invalid_request");
  const duplicate = await app.inject({
    method: "POST",
    url: "/oauth/token",
    remoteAddress: address(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "grant_type=refresh_token&grant_type=authorization_code",
  });
  assert.equal(duplicate.json().error, "invalid_request");
  // Browser routes still demand the app Origin; OAuth machine routes do not.
  const logout = await app.inject({
    method: "POST",
    url: "/api/logout",
    headers: { origin: "https://claude.ai" },
  });
  assert.equal(logout.statusCode, 403);
});

test("manually issued bearer tokens keep working on /mcp", async () => {
  const issued = await app.inject({
    method: "POST",
    url: "/api/agent-connections",
    remoteAddress: address(),
    headers: {
      origin,
      cookie: owner.cookie,
      "content-type": "application/json",
      "x-polka-csrf": await csrf(owner),
    },
    payload: {
      name: "Codex CLI",
      scopes: ["context", "capture"],
      audience: MCP_AUDIENCE,
      ttlDays: 7,
    },
  });
  assert.equal(issued.statusCode, 200, issued.body);
  const { token: bearer, connection } = issued.json();
  assert.equal(connection.kind, "token");
  assert.equal((await initialize(bearer)).status, 200);
  const listed = await mcp(bearer, "tools/list");
  assert.ok(
    listed.message.result.tools.some(
      (tool: any) => tool.name === "polka_capture",
    ),
  );
  // A manual token is not an OAuth refresh or revocation credential.
  const asRefresh = await token({
    grant_type: "refresh_token",
    refresh_token: bearer,
    client_id: (await publicClient()).client_id,
  });
  assert.equal(asRefresh.json().error, "invalid_grant");
  assert.equal((await initialize(bearer)).status, 200);
});
