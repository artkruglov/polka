import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
  withServiceActorTransaction,
} from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let otherCookie = "";
let oldestActiveId = "";

async function call(
  method: any,
  url: string,
  body?: any,
  cookie = ownerCookie,
  csrf?: string,
  origin = config.APP_ORIGIN,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-polka-csrf": csrf } : {}),
    },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function csrf(cookie = ownerCookie) {
  const response = await call(
    "POST",
    "/api/agent-connections/csrf",
    {},
    cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.json().csrfToken, /^[A-Za-z0-9_-]{43}$/);
  return response.json().csrfToken as string;
}

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`service-a-${suffix}`, password);
  other = await createAccount(`service-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  otherCookie = await login(other.name);
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("owner issues a one-time-visible tenant-bound token with default TTL", async () => {
  assert.equal(
    (
      await call(
        "POST",
        "/api/agent-connections/csrf",
        {},
        ownerCookie,
        undefined,
        "https://wrong.example",
      )
    ).statusCode,
    403,
  );
  const ownerCsrf = await csrf();
  assert.equal(
    (
      await call("POST", "/api/agent-connections", {
        name: "Codex CLI",
        scopes: ["context"],
        audience: MCP_AUDIENCE,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/agent-connections",
        {
          name: "Wrong endpoint",
          scopes: ["context"],
          audience: "https://wrong.example/mcp",
        },
        ownerCookie,
        ownerCsrf,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/agent-connections",
        {
          name: "Unknown scope",
          scopes: ["admin"],
          audience: MCP_AUDIENCE,
        },
        ownerCookie,
        ownerCsrf,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/agent-connections",
        {
          name: "Long lived",
          scopes: ["context"],
          audience: MCP_AUDIENCE,
          ttlDays: 31,
        },
        ownerCookie,
        ownerCsrf,
      )
    ).statusCode,
    400,
  );

  const issued = await call(
    "POST",
    "/api/agent-connections",
    {
      name: "Codex CLI",
      scopes: ["read", "context", "read"],
      audience: MCP_AUDIENCE,
    },
    ownerCookie,
    ownerCsrf,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  const { connection, token } = issued.json();
  oldestActiveId = connection.id;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(connection.scopes, ["context", "read"]);
  assert.equal(connection.status, "issued");
  const ttl =
    Date.parse(connection.expiresAt) - Date.parse(connection.createdAt);
  assert.ok(ttl > 6.99 * 86400_000 && ttl <= 7 * 86400_000);

  const stored = (
    await db.query("SELECT * FROM agent_connections WHERE id=$1", [
      connection.id,
    ])
  ).rows[0];
  assert.equal(stored.tenant_id, owner.tenant);
  assert.equal(stored.account_id, owner.id);
  assert.equal(stored.token_hash, sha256(token));
  assert.notEqual(stored.token_hash, token);

  const listed = await call("GET", "/api/agent-connections");
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json()[0].id, connection.id);
  assert.equal(JSON.stringify(listed.json()).includes(token), false);
  assert.equal(
    JSON.stringify(listed.json()).includes(stored.token_hash),
    false,
  );
  assert.equal(
    (await call("GET", "/api/agent-connections", undefined, otherCookie)).json()
      .length,
    0,
  );
});

test("listing always retains every active connection beyond bounded history", async () => {
  await Promise.all(
    Array.from({ length: 101 }, async (_, index) => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO agent_connections(
           id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,revoked_at,created_at
         ) VALUES($1,$2,$3,$4,$5,ARRAY['context'],$6,now()+interval '1 day',now(),now())`,
        [
          id,
          owner.tenant,
          owner.id,
          sha256(randomBytes(32)),
          `revoked-${index}`,
          MCP_AUDIENCE,
        ],
      );
    }),
  );
  const list = await call("GET", "/api/agent-connections");
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().some((item: any) => item.id === oldestActiveId));
  assert.ok(list.json().length <= 120);
  const ownerCsrf = await csrf();
  assert.equal(
    (
      await call(
        "POST",
        `/api/agent-connections/${oldestActiveId}/revoke`,
        {},
        ownerCookie,
        ownerCsrf,
      )
    ).statusCode,
    200,
  );
  await db.query(
    "DELETE FROM agent_connections WHERE tenant_id=$1 AND name LIKE 'revoked-%'",
    [owner.tenant],
  );
});

test("service authentication enforces audience, scopes, tenant and disabled account", async () => {
  const ownerCsrf = await csrf();
  const issued = await call(
    "POST",
    "/api/agent-connections",
    {
      name: "Claude Code",
      scopes: ["context", "capture"],
      audience: MCP_AUDIENCE,
      ttlDays: 30,
    },
    ownerCookie,
    ownerCsrf,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  const { connection, token } = issued.json();

  await assert.rejects(
    authenticateServiceToken(token, "https://wrong.example/mcp", "context"),
    (error: any) => error.status === 401,
  );
  await assert.rejects(
    authenticateServiceToken(token, MCP_AUDIENCE, "share"),
    (error: any) => error.status === 403,
  );
  const actor = await authenticateServiceToken(token, MCP_AUDIENCE, "context");
  assert.deepEqual(
    {
      accountId: actor.accountId,
      tenantId: actor.tenantId,
      connectionId: actor.connectionId,
    },
    {
      accountId: owner.id,
      tenantId: owner.tenant,
      connectionId: connection.id,
    },
  );
  assert.equal(
    await withServiceActorTransaction(
      actor,
      "capture",
      async (_c, verified) => verified.connectionId,
    ),
    connection.id,
  );
  await assert.rejects(
    withServiceActorTransaction(actor, "share", async () => true),
    (error: any) => error.status === 403,
  );
  await assert.rejects(
    withServiceActorTransaction(
      { ...actor, tenantId: other.tenant },
      "context",
      async () => true,
    ),
    (error: any) => error.status === 401,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/agent-connections/${connection.id}/revoke`,
        {},
        otherCookie,
        await csrf(otherCookie),
      )
    ).statusCode,
    404,
  );

  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  await assert.rejects(
    authenticateServiceToken(token, MCP_AUDIENCE, "context"),
    (error: any) => error.status === 401,
  );
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [owner.id]);
});

test("revoke and expiry block both fresh authentication and transactional replay", async () => {
  const ownerCsrf = await csrf();
  const issued = await call(
    "POST",
    "/api/agent-connections",
    {
      name: "Revoked agent",
      scopes: ["context", "capture"],
      audience: MCP_AUDIENCE,
    },
    ownerCookie,
    ownerCsrf,
  );
  const actor = await authenticateServiceToken(
    issued.json().token,
    MCP_AUDIENCE,
    "capture",
  );
  const revoke = await call(
    "POST",
    `/api/agent-connections/${issued.json().connection.id}/revoke`,
    {},
    ownerCookie,
    ownerCsrf,
  );
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal(
    (
      await call(
        "POST",
        `/api/agent-connections/${issued.json().connection.id}/revoke`,
        {},
        ownerCookie,
        ownerCsrf,
      )
    ).statusCode,
    200,
  );
  await assert.rejects(
    authenticateServiceToken(issued.json().token, MCP_AUDIENCE, "capture"),
    (error: any) => error.status === 401,
  );
  await assert.rejects(
    withServiceActorTransaction(actor, "capture", async () => "replayed"),
    (error: any) => error.status === 401,
  );

  const freshCsrf = await csrf();
  const expiring = await call(
    "POST",
    "/api/agent-connections",
    {
      name: "Expired agent",
      scopes: ["context"],
      audience: MCP_AUDIENCE,
      ttlDays: 1,
    },
    ownerCookie,
    freshCsrf,
  );
  await db.query(
    `UPDATE agent_connections
     SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day'
     WHERE id=$1`,
    [expiring.json().connection.id],
  );
  await assert.rejects(
    authenticateServiceToken(expiring.json().token, MCP_AUDIENCE, "context"),
    (error: any) => error.status === 401,
  );
  const list = await call("GET", "/api/agent-connections");
  const expired = list
    .json()
    .find((item: any) => item.id === expiring.json().connection.id);
  assert.equal(expired.status, "expired");

  await db.query(
    `UPDATE agent_connection_csrf
     SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute'
     WHERE session_hash=(SELECT hash FROM sessions WHERE account_id=$1 ORDER BY expires_at DESC LIMIT 1)`,
    [owner.id],
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/agent-connections",
        {
          name: "Expired CSRF",
          scopes: ["context"],
          audience: MCP_AUDIENCE,
        },
        ownerCookie,
        freshCsrf,
      )
    ).statusCode,
    403,
  );
});
