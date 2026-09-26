// polka_project_upload (docs/specs/PROJECTS.md): an agent asks over MCP for a
// token for the project CLI. The token uploads a project and nothing else,
// lives 30 minutes, stops with the connection that asked for it, and is not
// listed among the owner's agents.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const mcpHost = new URL(MCP_AUDIENCE).host;
const password = randomBytes(24).toString("hex");
const address = () =>
  `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

async function connect(scopes: string[]) {
  const secret = randomBytes(32).toString("base64url");
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'Claude Code',$5,$6,now()+interval '1 day')`,
    [id, owner.tenant, owner.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return { id, secret };
}

async function mcp(bearer: string, method: string, params: Record<string, unknown> = {}) {
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
  if (response.statusCode !== 200) return { status: response.statusCode, message: null as any };
  const text = String(response.headers["content-type"]).startsWith("text/event-stream")
    ? response.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("")
    : response.body;
  return { status: 200, message: JSON.parse(text) };
}

async function uploadToken(secret: string) {
  await mcp(secret, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "1.0" },
  });
  const called = await mcp(secret, "tools/call", { name: "polka_project_upload", arguments: {} });
  assert.equal(called.status, 200);
  assert.ok(!called.message.result.isError, JSON.stringify(called.message.result));
  return JSON.parse(called.message.result.content[0].text);
}

const readme = Buffer.from("# Исследование\n\nПервая страница проекта.\n");
const api = (bearer: string, method: any, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": Buffer.isBuffer(payload) ? "application/octet-stream" : "application/json",
    },
    payload: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload ?? {}),
  });

const beginProject = (bearer: string) =>
  api(bearer, "POST", "/api/v1/projects", {
    key: randomUUID(),
    title: "Исследование",
    manifest: {
      version: 1,
      entrypoint: "README.md",
      runtime: "project-v1",
      files: [
        {
          path: "README.md",
          mime: "text/markdown",
          size: readme.length,
          sha256: createHash("sha256").update(readme).digest("hex"),
        },
      ],
      provenance: { kind: "file", sourceUrl: null, capturedAt: new Date().toISOString(), attribution: "unknown", license: "unknown" },
      dependencies: { status: "unknown", unresolved: [] },
    },
  });

before(async () => {
  owner = await createAccount(`project-token-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});

after(async () => {
  await Promise.allSettled([app.close()]);
  await db.end();
  s3.destroy();
});

test("an agent gets a token and the command, and the token uploads a project", async () => {
  const parent = await connect(["context", "capture"]);
  const issued = await uploadToken(parent.secret);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(issued.command.includes(`POLKA_TOKEN=${issued.token}`));
  assert.ok(issued.command.includes(`${origin}/api/v1/cli/polka-publish-project.mjs`));
  const minutes = (new Date(issued.expiresAt).getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 29 && minutes <= 30, String(minutes));
  const begun = await beginProject(issued.token);
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId, files } = begun.json();
  const put = await api(issued.token, "PUT", `/api/v1/projects/${uploadId}/files/${files[0].index}`, readme);
  assert.equal(put.statusCode, 200, put.body);
  const done = await api(issued.token, "POST", `/api/v1/projects/${uploadId}/finalize`);
  assert.equal(done.statusCode, 200, done.body);
  const { rows: [work] } = await db.query("SELECT tenant_id FROM artifacts WHERE id=$1", [done.json().artifactId]);
  assert.equal(work.tenant_id, owner.tenant);
  // One page or component from disk goes through the same token
  // (polka-publish.mjs), so the agent never pastes a file into a tool call.
  assert.ok(issued.pageCommand.includes(`${origin}/api/v1/cli/polka-publish.mjs`));
  const publish = await api(issued.token, "POST", "/api/v1/publish", {
    key: randomUUID(),
    title: "Страница с диска",
    html: "<!doctype html><title>x</title><p>x</p>",
  });
  assert.equal(publish.statusCode, 200, publish.body);
  // The parent had no link permission, so neither has its token.
  assert.equal(publish.json().url, null);
  // Nothing else: no status, no MCP.
  assert.equal((await api(issued.token, "GET", `/api/v1/status/${done.json().artifactId}`)).statusCode, 401);
  assert.equal((await mcp(issued.token, "tools/list")).status, 401);
  // The owner's agents page lists the connection, not its tokens.
  const listed = await app.inject({ method: "GET", url: "/api/agent-connections", headers: { origin, cookie } });
  assert.ok(listed.json().every((item: any) => !item.name.startsWith("Загрузка проекта")));
});

test("the token stops with the connection that asked for it", async () => {
  const parent = await connect(["context", "capture"]);
  const issued = await uploadToken(parent.secret);
  assert.equal((await beginProject(issued.token)).statusCode, 200);
  await db.query("UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1", [parent.id]);
  assert.equal((await beginProject(issued.token)).statusCode, 401);
});

test("a read-only connection is not offered the tool; the database keeps tokens short", async () => {
  const reader = await connect(["context", "read"]);
  await mcp(reader.secret, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "1.0" },
  });
  const tools = (await mcp(reader.secret, "tools/list")).message.result.tools.map((tool: any) => tool.name);
  assert.ok(!tools.includes("polka_project_upload"));
  const parent = await connect(["context", "capture"]);
  await assert.rejects(
    db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,parent_id)
       VALUES($1,$2,$3,$4,'x',ARRAY['capture'],$5,now()+interval '2 hours',$6)`,
      [randomUUID(), owner.tenant, owner.id, sha256(randomBytes(32).toString("base64url")), `${origin}/api/v1/projects`, parent.id],
    ),
    /agent_connections_child_shape/,
  );
});
