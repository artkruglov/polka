// Extensions of the open core (docs/specs/EXTENSIONS.md): a link policy that
// refuses and one that asks recipients to sign in, events after the commit,
// routes of their own, and loading by path. Without extensions the core
// behaves as alone (every other test runs without them).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { ExtensionContext, PolkaEvent, PolkaExtension } from "../packages/extension-api/index.ts";
import { loadExtensions, useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { createRedactor, prepareSession } from "../scripts/polka-sessions.mjs";
import { FAKE, claudeSession } from "./agent-sessions-fixtures.ts";

const events: PolkaEvent[] = [];
let extensionContext: ExtensionContext;
const policy: PolkaExtension = {
  name: "policy",
  web: { script: fileURLToPath(new URL("./fixtures/extension-web.js", import.meta.url)) },
  machinePaths: ["/api/ext/policy/agent/ping"],
  register(app, context) {
    extensionContext = context;
    app.post("/api/ext/policy/agent/ping", async (req, reply) => ({
      tenantId: (await context.agent(req, reply, "sessions")).tenantId,
    }));
    app.get("/api/ext/policy/agent/ping", async (req) => ({ name: (await context.identity(req)).name }));
    app.post("/api/ext/policy/browser", async (req, reply) => ({
      tenantId: (await context.agent(req, reply, "sessions")).tenantId,
    }));
    app.get("/api/ext/policy/whoami", async (req) => ({ name: (await context.identity(req)).name }));
  },
  policies: {
    async linkIssue(issue) {
      return issue.expiresInDays > 7
        ? { allow: false, message: "Ссылки дольше 7 дней в компании запрещены." }
        : { allow: true };
    },
    async linkOpen(open) {
      return open.viewer
        ? { allow: true }
        : { allow: false, signIn: true, message: "Ссылка только для сотрудников компании." };
    },
  },
  onEvent(event) {
    events.push(event);
  },
};
useExtensions([policy]);
const { createApp } = await import("../apps/server/app.ts");
const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

const call = (method: any, url: string, body?: unknown, withCookie = true) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      ...(withCookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body as any,
  });

before(async () => {
  owner = await createAccount(`ext-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  cookie = `polka_session=${login.cookies[0].value}`;
});

after(async () => {
  useExtensions([]);
  await app.close();
  await db.end();
  s3.destroy();
});

test("an extension's policy refuses a link and asks recipients to sign in; events follow the commit", async () => {
  const body = Buffer.from("<!doctype html><title>Отчёт</title><h1>Отчёт</h1><p>Текст.</p>");
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Отчёт",
    filename: "r.html",
    mime: "text/html",
    size: body.length,
    sha256: sha256(body),
  });
  assert.equal(start.statusCode, 200, start.body);
  await call("PUT", `/api/uploads/${start.json().uploadId}/bytes`, body);
  const saved = (await call("POST", `/api/uploads/${start.json().uploadId}/finalize`, {})).json();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "revision.saved" && event.revisionId === saved.revisionId));

  const refused = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId,
    expiresInDays: 30,
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.json().message, /дольше 7 дней/);
  const shared = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId,
    expiresInDays: 7,
  });
  assert.equal(shared.statusCode, 200, shared.body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "share.created" && event.shareId === shared.json().share.id));

  const token = new URL(shared.json().share.url).hash.slice(1);
  const anonymous = await call("POST", "/api/resolve", { token }, false);
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  assert.equal(anonymous.json().reason, "sign_in_required");
  assert.match(anonymous.json().message, /только для сотрудников/);
  const signedIn = await call("POST", "/api/resolve", { token });
  assert.equal(signedIn.statusCode, 200, signedIn.body);

  const whoami = await call("GET", "/api/ext/policy/whoami");
  assert.equal(whoami.json().name, owner.name);
});

test("an extension's web module is served from this origin and named in capabilities", async () => {
  const capabilities = (await call("GET", "/api/capabilities", undefined, false)).json();
  assert.deepEqual(capabilities.extensions, ["policy"]);
  const module = await call("GET", "/ext/policy.js", undefined, false);
  assert.equal(module.statusCode, 200);
  assert.match(String(module.headers["content-type"]), /text\/javascript/);
  assert.match(module.body, /addSection\("company-admin"/);
  assert.match(module.body, /addSection\("share-dialog"/);
  assert.equal((await call("GET", "/ext/other.js", undefined, false)).statusCode, 404);
  assert.equal((await call("GET", "/ext/..%2Fsecret.js", undefined, false)).statusCode, 404);
});

async function agentToken(scopes: string[]) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'ext',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}

test("an extension's machine route takes an agent token with a permission and no Origin, never a cookie", async () => {
  const ping = (authorization?: string) =>
    app.inject({
      method: "POST",
      url: "/api/ext/policy/agent/ping",
      headers: authorization ? { authorization } : {},
      payload: {},
    });
  assert.equal((await ping()).statusCode, 401);
  assert.equal((await ping(`Bearer ${randomBytes(32).toString("base64url")}`)).statusCode, 401);
  assert.equal((await ping(`Bearer ${await agentToken(["context"])}`)).statusCode, 403);
  const ok = await ping(`Bearer ${await agentToken(["sessions"])}`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().tenantId, owner.tenant);
  // A cookie on a machine path is refused: no Origin check guards it there.
  assert.equal((await call("GET", "/api/ext/policy/agent/ping")).statusCode, 403);
  // Any other extension route keeps the browser Origin rule.
  const browser = await app.inject({
    method: "POST",
    url: "/api/ext/policy/browser",
    headers: { authorization: `Bearer ${await agentToken(["sessions"])}` },
    payload: {},
  });
  assert.equal(browser.statusCode, 403);
  assert.match(browser.json().message, /из Полки/);
});

test("context.redact replaces a secret as the sessions CLI does, with an uploaded session's fingerprint", async () => {
  const was = config.AGENT_SESSION_FINGERPRINTS;
  config.AGENT_SESSION_FINGERPRINTS = "installation";
  const scratch = await mkdtemp(join(tmpdir(), "polka-ext-redact-"));
  try {
    // A session uploaded the CLI's way: key from the server, redacted on the machine.
    await db.query(`UPDATE tenants SET session_quota_bytes=$2 WHERE id=$1`, [owner.tenant, 50 * 1024 * 1024]);
    const secret = await agentToken(["sessions"]);
    const headers = { authorization: `Bearer ${secret}` };
    const key = await app.inject({ method: "GET", url: "/api/v1/sessions/key", headers });
    assert.equal(key.statusCode, 200, key.body);
    const id = randomUUID();
    const path = join(scratch, `${id}.jsonl`);
    await writeFile(path, claudeSession(id));
    const prepared = await prepareSession({ source: "claude-code", path, id }, Buffer.from(key.json().key, "hex"));
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: gzipSync(Buffer.from(JSON.stringify(prepared.body))),
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const { rows } = await db.query(
      `SELECT fingerprint FROM agent_session_secrets WHERE session_id=$1 AND type='github-token'`,
      [saved.json().id],
    );
    assert.equal(rows.length, 1);

    const text = `git push https://x:${FAKE.github}@github.com/acme/app.git; export GITHUB_TOKEN=${FAKE.github}`;
    const result = extensionContext.redact(text);
    assert.ok(!result.text.includes(FAKE.github), result.text);
    assert.equal(result.text, createRedactor(Buffer.from(key.json().key, "hex")).redact(text));
    assert.ok(result.text.includes(`[REDACTED:github-token:${rows[0].fingerprint}]`), result.text);
    assert.deepEqual(result.secrets, [{ type: "github-token", fingerprint: rows[0].fingerprint }]);
    assert.deepEqual(extensionContext.redact("ls -la /tmp && echo done"), {
      text: "ls -la /tmp && echo done",
      secrets: [],
    });
  } finally {
    config.AGENT_SESSION_FINGERPRINTS = was;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an extension loads by path and must name itself", async () => {
  const [hello] = await loadExtensions("./tests/fixtures/extension-hello.mjs");
  assert.equal(hello!.name, "hello");
  await assert.rejects(
    loadExtensions("./tests/fixtures/extension-hello.mjs,./tests/fixtures/extension-hello.mjs"),
    /loaded twice/,
  );
  useExtensions([policy]);
});
