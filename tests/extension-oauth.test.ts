// The «На Полку» browser extension as an OAuth client (extensions/chrome):
// a public DCR client whose redirect is https://<id>.chromiumapp.org/, PKCE,
// the consent page naming it as a browser extension, and the publish API
// accepting its chrome-extension:// Origin.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  browserExtensionId,
  validRedirectUri,
  vettedExtensionName,
} from "../apps/server/oauth.ts";
import { oauthClientKind } from "../apps/server/analytics.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";
const redirectFor = (id: string) => `https://${id}.chromiumapp.org/polka`;
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

async function registerExtension(id: string, name = "На Полку") {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/register",
    remoteAddress: address(),
    // What Chrome sends from the extension's service worker.
    headers: {
      "content-type": "application/json",
      origin: `chrome-extension://${id}`,
    },
    payload: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectFor(id)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { client_id: string; client_name: string };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function start(clientId: string, id: string) {
  const { verifier, challenge } = pkce();
  const state = randomBytes(12).toString("base64url");
  const response = await app.inject({
    method: "GET",
    url: `/oauth/authorize?${form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectFor(id),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "context capture share",
      resource: MCP_AUDIENCE,
    })}`,
    remoteAddress: address(),
  });
  assert.equal(response.statusCode, 302, response.body);
  const location = new URL(response.headers.location as string, origin);
  assert.equal(location.pathname, "/oauth/consent");
  const browser = response.cookies.find((c) => c.name === "polka_oauth")!;
  return {
    verifier,
    state,
    requestId: location.searchParams.get("request")!,
    browser: `polka_oauth=${browser.value}`,
  };
}

async function details(started: { requestId: string; browser: string }) {
  const response = await app.inject({
    method: "GET",
    url: `/oauth/authorize/details?request=${started.requestId}`,
    remoteAddress: address(),
    headers: { cookie: `${owner.cookie}; ${started.browser}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as {
    client: {
      name: string;
      redirectHost: string;
      extension: { id: string; official: boolean } | null;
    };
  };
}

async function approve(started: { requestId: string; browser: string }) {
  const csrf = await app.inject({
    method: "POST",
    url: "/api/agent-connections/csrf",
    remoteAddress: address(),
    headers: {
      origin,
      cookie: owner.cookie,
      "content-type": "application/json",
    },
    payload: "{}",
  });
  const decided = await app.inject({
    method: "POST",
    url: "/oauth/authorize/decision",
    remoteAddress: address(),
    headers: {
      origin,
      cookie: `${owner.cookie}; ${started.browser}`,
      "content-type": "application/json",
      "x-polka-csrf": csrf.json().csrfToken,
    },
    payload: {
      request: started.requestId,
      decision: "approve",
      scopes: ["context", "capture", "share"],
    },
  });
  assert.equal(decided.statusCode, 200, decided.body);
  return new URL(decided.json().redirectTo);
}

before(async () => {
  owner = await newOwner("extension");
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("chromiumapp.org redirects: an extension ID is 32 letters a–p on that host only", () => {
  assert.equal(browserExtensionId(redirectFor(EXTENSION_ID)), EXTENSION_ID);
  assert.equal(
    browserExtensionId(`https://${EXTENSION_ID}.chromiumapp.org/`),
    EXTENSION_ID,
  );
  for (const uri of [
    `http://${EXTENSION_ID}.chromiumapp.org/`,
    `https://${EXTENSION_ID.toUpperCase()}.chromiumapp.org/`,
    `https://${EXTENSION_ID.slice(1)}.chromiumapp.org/`,
    `https://${EXTENSION_ID.slice(1)}q.chromiumapp.org/`,
    `https://${EXTENSION_ID}.chromiumapp.org.evil.example/`,
    `https://x.${EXTENSION_ID}.chromiumapp.org/`,
    `https://evil.example/${EXTENSION_ID}.chromiumapp.org/`,
    `https://${EXTENSION_ID}.chromiumapp.org`,
  ])
    assert.equal(browserExtensionId(uri), null, uri);
  // Registration accepts it as an ordinary https redirect.
  assert.equal(validRedirectUri(redirectFor(EXTENSION_ID)), true);
  assert.equal(
    validRedirectUri(`https://${EXTENSION_ID}.chromiumapp.org/cb#x`),
    false,
  );
  assert.equal(
    oauthClientKind("На Полку", [redirectFor(EXTENSION_ID)]),
    "browser-extension",
  );
});

test("the name «На Полку» is confirmed only for an official extension ID", () => {
  const saved = [...config.BROWSER_EXTENSION_IDS];
  try {
    config.BROWSER_EXTENSION_IDS.splice(0, Infinity, EXTENSION_ID);
    assert.equal(
      vettedExtensionName("На Полку", [redirectFor(EXTENSION_ID)]),
      "На Полку",
    );
    for (const [name, uris] of [
      ["На Полку", [redirectFor(OTHER_ID)]],
      ["на  полку!", [redirectFor(OTHER_ID)]],
      ["НА ПОЛКУ", ["https://evil.example/cb"]],
      ["Na Polku", [redirectFor(OTHER_ID)]],
      ["На Полку", [redirectFor(EXTENSION_ID), "https://evil.example/cb"]],
    ] as const)
      assert.match(
        vettedExtensionName(name, [...uris]),
        /\(имя не подтверждено\)$/,
        `${name} ${uris.join(" ")}`,
      );
    // Other names are left alone, including ones that mention Полка.
    assert.equal(
      vettedExtensionName("Claude Code (polka)", ["http://127.0.0.1:3000/cb"]),
      "Claude Code (polka)",
    );
  } finally {
    config.BROWSER_EXTENSION_IDS.splice(0, Infinity, ...saved);
  }
});

test("an unlisted extension: consent names it by ID, its name unconfirmed", async () => {
  const client = await registerExtension(OTHER_ID);
  assert.equal(client.client_name, "На Полку (имя не подтверждено)");
  const started = await start(client.client_id, OTHER_ID);
  const shown = await details(started);
  assert.deepEqual(shown.client.extension, { id: OTHER_ID, official: false });
  assert.equal(shown.client.name, "На Полку (имя не подтверждено)");
});

test("official extension: consent, PKCE token, refresh, publish with its Origin", async () => {
  const saved = [...config.BROWSER_EXTENSION_IDS];
  config.BROWSER_EXTENSION_IDS.splice(0, Infinity, EXTENSION_ID);
  try {
    const client = await registerExtension(EXTENSION_ID);
    assert.equal(client.client_name, "На Полку");
    const started = await start(client.client_id, EXTENSION_ID);
    const shown = await details(started);
    assert.deepEqual(shown.client.extension, {
      id: EXTENSION_ID,
      official: true,
    });
    const redirect = await approve(started);
    assert.equal(
      `${redirect.origin}${redirect.pathname}`,
      redirectFor(EXTENSION_ID),
    );
    assert.equal(redirect.searchParams.get("state"), started.state);
    const exchange = (params: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        remoteAddress: address(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: `chrome-extension://${EXTENSION_ID}`,
        },
        payload: form(params),
      });
    const issued = await exchange({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      redirect_uri: redirectFor(EXTENSION_ID),
      code_verifier: started.verifier,
      client_id: client.client_id,
      resource: MCP_AUDIENCE,
    });
    assert.equal(issued.statusCode, 200, issued.body);
    const tokens = issued.json();
    assert.equal(tokens.scope, "context capture share");

    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: MCP_AUDIENCE,
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const access = refreshed.json().access_token as string;

    const publish = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/publish",
        remoteAddress: address(),
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
          ...headers,
        },
        payload: {
          key: randomUUID(),
          title: "Из расширения",
          html: "<!doctype html><title>Из расширения</title><h1>Привет</h1>",
        },
      });
    const saved = await publish({ origin: `chrome-extension://${EXTENSION_ID}` });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().state, "shared");
    assert.match(saved.json().url, new RegExp(`^${origin}/s#`));
    // Not an extension origin: still refused, as for any other site.
    for (const foreign of [
      "https://evil.example",
      "chrome-extension://not-an-id",
      `moz-extension://${EXTENSION_ID}`,
      `chrome-extension://${EXTENSION_ID}.evil.example`,
    ]) {
      const refused = await publish({ origin: foreign });
      assert.equal(refused.statusCode, 403, foreign);
    }
  } finally {
    config.BROWSER_EXTENSION_IDS.splice(0, Infinity, ...saved);
  }
});
