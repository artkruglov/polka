import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { AgentScope } from "../packages/contracts/index.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createMcpServer } from "../apps/server/mcp-server.ts";
import { MCP_AUDIENCE, authenticateServiceToken } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { main, prepareSession } from "../scripts/polka-sessions.mjs";
import { FAKE, claudeSession } from "./agent-sessions-fixtures.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
type Owner = { id: string; tenant: string; name: string };
let scratch: string;

const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

async function owner(prefix: string, quota = 50 * 1024 * 1024): Promise<Owner> {
  const who = await createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
  await db.query(`UPDATE tenants SET session_quota_bytes=$2 WHERE id=$1`, [who.tenant, quota]);
  return who;
}

async function token(who: Owner, scopes: AgentScope[] = ["context", "sessions"]) {
  const id = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'sessions',$5,$6,now()+interval '1 day')`,
    [id, who.tenant, who.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}

async function cookie(who: Owner) {
  const response = await app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress: address(),
    headers: { origin },
    payload: { name: who.name, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const session = response.cookies.find((c) => c.name === "polka_session");
  return `polka_session=${session!.value}`;
}

const web = (method: "GET" | "DELETE", url: string, cookieHeader: string) =>
  app.inject({ method, url, remoteAddress: address(), headers: { origin, cookie: cookieHeader } });

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function upload(secret: string, file: { source: "claude-code" | "codex"; path: string; id: string }) {
  const key = await app.inject({ method: "GET", url: "/api/v1/sessions/key", remoteAddress: address(), headers: bearer(secret) });
  assert.equal(key.statusCode, 200, key.body);
  const prepared = await prepareSession(file, Buffer.from(key.json().key, "hex"));
  const saved = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    remoteAddress: address(),
    headers: { ...bearer(secret), "content-type": "application/octet-stream" },
    payload: gzipSync(Buffer.from(JSON.stringify(prepared.body))),
  });
  return { saved, prepared };
}

async function putTranscript(secret: string, id: string, bytes: Buffer) {
  return app.inject({
    method: "PUT",
    url: `/api/v1/sessions/${id}/transcript`,
    remoteAddress: address(),
    headers: { ...bearer(secret), "content-type": "application/octet-stream" },
    payload: bytes,
  });
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "polka-agent-sessions-"));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await app.close();
  await db.end();
  s3.destroy();
});

async function sessionFile(workId?: string) {
  const id = randomUUID();
  const path = join(scratch, `${id}.jsonl`);
  await writeFile(path, claudeSession(id, { workId }));
  return { source: "claude-code" as const, path, id };
}

test("uploads a session, shows it to its owner only, replaces it on a new upload and deletes it", async () => {
  const person = await owner("sessions");
  const secret = await token(person);
  // A work of this shelf the session saved through Полка's tools.
  const { rows: [work] } = await db.query(
    `INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Report') RETURNING id`,
    [randomUUID(), person.tenant, person.id],
  );
  const file = await sessionFile(work.id);
  const { saved, prepared } = await upload(secret, file);
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json();
  assert.equal(body.created, true);
  assert.equal(body.transcriptNeeded, true);
  assert.equal(body.secretsStatus, "sent_out");
  assert.deepEqual(body.alerts.sort(), ["destructive_command", "no_approvals", "pipe_to_shell", "secret_sent_out"]);
  assert.equal(body.url, `${origin}/sessions/${body.id}`);
  const put = await putTranscript(secret, body.id, prepared.transcriptGz);
  assert.equal(put.statusCode, 200, put.body);

  // The audit event names the session, never its content.
  const { rows: events } = await db.query(`SELECT action, payload FROM audit_outbox WHERE target_id=$1`, [body.id]);
  assert.deepEqual(events.map((e) => e.action), ["session.saved"]);
  assert.ok(!JSON.stringify(events).includes("demo-app"));

  const own = await cookie(person);
  const list = await web("GET", "/api/sessions", own);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().enabled, true);
  assert.equal(list.json().sessions.length, 1);
  assert.equal(list.json().sessions[0].projectLabel, "demo-app");
  assert.ok(list.json().usedBytes >= prepared.transcriptGz.length);

  const detail = await web("GET", `/api/sessions/${body.id}`, own);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().toolCalls.length, 5);
  assert.ok(detail.json().secrets.every((s: { fingerprint: string }) => /^[0-9a-f]{12}$/.test(s.fingerprint)));
  assert.ok(!detail.body.includes(FAKE.github));
  const links = detail.json().links;
  assert.ok(links.some((l: { kind: string; target: string }) => l.kind === "pr" && l.target.endsWith("/pull/7")));
  assert.ok(links.some((l: { artifactId: string; title: string }) => l.artifactId === work.id && l.title === "Report"));
  const ofWork = await web("GET", `/api/artifacts/${work.id}/sessions`, own);
  assert.deepEqual(ofWork.json().sessions.map((s: { id: string }) => s.id), [body.id]);

  const transcript = await web("GET", `/api/sessions/${body.id}/transcript?limit=3`, own);
  assert.equal(transcript.statusCode, 200, transcript.body);
  assert.equal(transcript.json().events.length, 3);
  assert.equal(transcript.json().events[0].type, "prompt");
  const download = await web("GET", `/api/sessions/${body.id}/transcript.gz`, own);
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "application/gzip");

  const stats = await web("GET", "/api/sessions/stats?days=30", own);
  assert.equal(stats.statusCode, 200, stats.body);
  assert.equal(stats.json().secrets.sent_out, 1);
  assert.ok(stats.json().hosts.some((h: { host: string }) => h.host === "db.example.com"));
  assert.ok(stats.json().fingerprints.length >= 2);

  // Someone else sees nothing.
  const stranger = await owner("stranger");
  const theirs = await cookie(stranger);
  assert.equal((await web("GET", `/api/sessions/${body.id}`, theirs)).statusCode, 404);
  assert.equal((await web("GET", "/api/sessions", theirs)).json().sessions.length, 0);
  assert.equal((await putTranscript(await token(stranger), body.id, prepared.transcriptGz)).statusCode, 404);

  // The same session again: one row, the transcript is not asked twice.
  const again = await upload(secret, file);
  assert.equal(again.saved.json().id, body.id);
  assert.equal(again.saved.json().created, false);
  assert.equal(again.saved.json().transcriptNeeded, false);
  const { rows: [{ count }] } = await db.query(`SELECT count(*)::int FROM agent_sessions WHERE tenant_id=$1`, [person.tenant]);
  assert.equal(count, 1);

  const removed = await web("DELETE", `/api/sessions/${body.id}`, own);
  assert.equal(removed.statusCode, 200, removed.body);
  const { rows: [tenant] } = await db.query(`SELECT session_used_bytes FROM tenants WHERE id=$1`, [person.tenant]);
  assert.equal(Number(tenant.session_used_bytes), 0);
  assert.equal((await db.query(`SELECT 1 FROM agent_session_tool_calls c JOIN agent_sessions s ON s.id=c.session_id WHERE s.tenant_id=$1`, [person.tenant])).rowCount, 0);
});

test("needs the sessions permission, an enabled shelf and room", async () => {
  const person = await owner("sessions-off", 0);
  const file = await sessionFile();
  const withoutScope = await upload(await token(person, ["context", "capture"]), file).catch((error) => ({ error }));
  assert.ok("error" in withoutScope);
  const key = await app.inject({ method: "GET", url: "/api/v1/sessions/key", remoteAddress: address(), headers: bearer(await token(person, ["context", "capture"])) });
  assert.equal(key.statusCode, 403, key.body);
  const off = await app.inject({ method: "GET", url: "/api/v1/sessions/key", remoteAddress: address(), headers: bearer(await token(person)) });
  assert.equal(off.statusCode, 403);
  assert.equal(off.json().reason, "sessions_disabled");
  assert.equal((await web("GET", "/api/sessions", await cookie(person))).json().enabled, false);

  // An installation-wide allowance turns them on for every personal shelf.
  const before = config.AGENT_SESSION_QUOTA_BYTES;
  config.AGENT_SESSION_QUOTA_BYTES = 10 * 1024 * 1024;
  try {
    const { saved } = await upload(await token(person), file);
    assert.equal(saved.statusCode, 200, saved.body);
  } finally {
    config.AGENT_SESSION_QUOTA_BYTES = before;
  }

  const tight = await owner("sessions-tight", 400);
  const { saved } = await upload(await token(tight), await sessionFile());
  assert.equal(saved.statusCode, 413, saved.body);
  assert.equal(saved.json().code, "quota");

  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    remoteAddress: address(),
    headers: { ...bearer(await token(await owner("sessions-bad"))), "content-type": "application/octet-stream" },
    payload: gzipSync(Buffer.from(JSON.stringify({ schema: "polka-session-index/1", source: "other" }))),
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const notGzip = await putTranscript(await token(person), randomUUID(), Buffer.from("plain text, not gzip at all"));
  assert.equal(notGzip.statusCode, 400);
});

test("erasing the account erases its sessions", async () => {
  const person = await owner("sessions-erase");
  const secret = await token(person);
  const { saved, prepared } = await upload(secret, await sessionFile());
  assert.equal((await putTranscript(secret, saved.json().id, prepared.transcriptGz)).statusCode, 200);
  // The rename is the erasure's own step (030), which fires the trigger of 065.
  await db.query(`UPDATE accounts SET name='deleted-'||id WHERE id=$1`, [person.id]);
  assert.equal((await db.query(`SELECT 1 FROM agent_sessions WHERE account_id=$1`, [person.id])).rowCount, 0);
  const { rows: [tenant] } = await db.query(`SELECT session_used_bytes, session_fingerprint_key FROM tenants WHERE id=$1`, [person.tenant]);
  assert.equal(Number(tenant.session_used_bytes), 0);
  assert.equal(tenant.session_fingerprint_key, null);
});

test("agents read sessions through MCP with the sessions permission", async () => {
  const person = await owner("sessions-mcp");
  const secret = await token(person, ["context", "read", "sessions"]);
  assert.equal((await upload(secret, await sessionFile())).saved.statusCode, 200);
  const actor = await authenticateServiceToken(secret, MCP_AUDIENCE);
  const server = createMcpServer(actor) as unknown as { _registeredTools: Record<string, { callback?: Function; handler?: Function }> };
  const tools = server._registeredTools;
  assert.ok(tools.polka_sessions && tools.polka_session_stats);
  const call = tools.polka_sessions!.callback ?? tools.polka_sessions!.handler;
  const result = await call!({ days: 30 }, {});
  const sessions = result.structuredContent.sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].secrets, "sent_out");
  assert.ok(sessions[0].alerts.includes("destructive_command"));
  const withoutScope = createMcpServer(await authenticateServiceToken(await token(person, ["context", "read"]), MCP_AUDIENCE)) as unknown as { _registeredTools: Record<string, unknown> };
  assert.equal(withoutScope._registeredTools.polka_sessions, undefined);
});

test("the CLI sends a session end to end and the server hands it out with its address", async () => {
  const person = await owner("sessions-cli");
  const secret = await token(person);
  const server = await createApp();
  await server.listen({ host: "127.0.0.1", port: 0 });
  const port = (server.server.address() as AddressInfo).port;
  const home = await mkdtemp(join(tmpdir(), "polka-sessions-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = await sessionFile();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["upload", file.path, "--endpoint", `http://127.0.0.1:${port}`], {
      env: { POLKA_TOKEN: secret },
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    });
    assert.equal(code, 0, err.join(""));
    assert.match(err.join(""), /secrets: sent_out/);
    const { rows: [row] } = await db.query(`SELECT transcript_key, transcript_bytes FROM agent_sessions WHERE tenant_id=$1`, [person.tenant]);
    assert.ok(row.transcript_key?.startsWith(`${person.tenant}/sessions/`));
    assert.ok(Number(row.transcript_bytes) > 0);
    // Never as an argument.
    assert.equal(await main(["sync", "--token", secret], { env: {}, stderr: { write: () => true }, stdout: { write: () => true } }), 2);
    // The hook does nothing unless the person turned it on.
    assert.equal(await main(["hook"], { env: {}, stdin: async () => "{}", stdout: { write: () => true }, stderr: { write: () => true } }), 0);
    const cli = await server.inject({ method: "GET", url: "/api/v1/cli/polka-sessions.mjs" });
    assert.equal(cli.statusCode, 200);
    assert.match(cli.body, new RegExp(`const DEFAULT_ENDPOINT = ${JSON.stringify(origin).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")};`));
  } finally {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await server.close();
  }
});
