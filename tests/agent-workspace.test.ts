// The work as the agent's workspace (docs/specs/AGENT_WORKSPACE.md): list the
// files of a version, read one by its path, save the next version with files
// added, replaced or removed — over HTTP and over MCP, with the files nobody
// touched copied by the server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentScope } from "../packages/contracts/index.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const password = randomBytes(24).toString("hex");
const mcpHost = new URL(MCP_AUDIENCE).host;
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;

async function token(account: typeof owner, scopes: AgentScope[]) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'workspace',$5,$6,now()+interval '1 day')`,
    [randomUUID(), account.tenant, account.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}
const ALL: AgentScope[] = ["context", "read", "source:read", "capture", "revise"];

type File = { path: string; mime: string; bytes: Buffer };
const file = (path: string, mime: string, text: string | Buffer): File => ({
  path,
  mime,
  bytes: Buffer.isBuffer(text) ? text : Buffer.from(text),
});
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf00000301010018dd8db40000000049454e44ae426082",
  "hex",
);
const manifestOf = (files: File[], entrypoint: string) => ({
  version: 1,
  entrypoint,
  runtime: "project-v1",
  files: files.map((f) => ({ path: f.path, mime: f.mime, size: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex") })),
  provenance: { kind: "file", sourceUrl: null, capturedAt: new Date().toISOString(), attribution: "unknown", license: "unknown" },
  dependencies: { status: "unknown", unresolved: [] },
});
const api = (secret: string, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    remoteAddress: address(),
    headers: { authorization: `Bearer ${secret}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

async function project(secret: string, files: File[], entrypoint: string) {
  const auth = { authorization: `Bearer ${secret}` };
  const begun = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({ key: randomUUID(), title: "Рабочее место", manifest: manifestOf(files, entrypoint) }),
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const { index, path } of begun.json().files) {
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${begun.json().uploadId}/files/${index}`,
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: byPath.get(path)!.bytes,
    });
    assert.equal(put.statusCode, 200, put.body);
  }
  const done = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${begun.json().uploadId}/finalize`,
    headers: { ...auth, "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

async function mcp(secret: string, name: string, args: Record<string, unknown>) {
  const call = async (method: string, params: Record<string, unknown>, id: number) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      remoteAddress: address(),
      headers: {
        host: mcpHost,
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      payload: { jsonrpc: "2.0", id, method, params },
    });
  const parse = (response: Awaited<ReturnType<typeof call>>) => {
    const text = String(response.headers["content-type"]).startsWith("text/event-stream")
      ? response.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("")
      : response.body;
    return JSON.parse(text);
  };
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0" } }, 1);
  const message = parse(await call("tools/call", { name, arguments: args }, 2));
  return { error: !!message.result?.isError, value: JSON.parse(message.result.content[0].text) };
}

before(async () => {
  owner = await createAccount(`workspace-a-${randomBytes(5).toString("hex")}`, password);
  other = await createAccount(`workspace-b-${randomBytes(5).toString("hex")}`, password);
});
after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

const files = () => [
  file("README.md", "text/markdown", "# Рабочее место\n\nСмотри [заметку](docs/a.md).\n"),
  file("docs/a.md", "text/markdown", "# Заметка\n\nПервая версия.\n"),
  file("style.css", "text/css", "body{color:#111}\n"),
  file("logo.png", "image/png", PNG),
  file("big.txt", "text/plain", "я".repeat(700_000)), // ~1.4 MB: over the chat read limit
  file("medium.txt", "text/plain", "a".repeat(256 * 1024 + 1)),
];

test("list, read one file by path, change the files: the others are copied, the old version stays", async () => {
  const secret = await token(owner, ALL);
  const made = await project(secret, files(), "README.md");
  const listing = (await api(secret, "GET", `/api/v1/works/${made.artifactId}/files`)).json();
  assert.deepEqual(listing.files.map((f: any) => f.path).sort(), ["README.md", "big.txt", "docs/a.md", "logo.png", "medium.txt", "style.css"]);

  // One file by its path: text as UTF-8, a picture as base64, a missing path 404, a big one refused.
  const text = await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=${encodeURIComponent("docs/a.md")}`);
  assert.equal(text.statusCode, 200, text.body);
  assert.equal(text.json().encoding, "utf8");
  assert.match(text.json().data, /Первая версия/);
  const picture = (await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=logo.png`)).json();
  assert.equal(picture.encoding, "base64");
  assert.equal(Buffer.from(picture.data, "base64").equals(PNG), true);
  assert.equal(picture.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.equal((await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=nope.md`)).statusCode, 404);
  assert.equal((await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=big.txt`)).statusCode, 413);
  // 256 KiB is the chat limit: a file just over it is refused.
  assert.equal((await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=medium.txt`)).statusCode, 413);

  // Change: add docs/b.md, replace docs/a.md, remove style.css.
  const key = randomUUID();
  const body = {
    key,
    baseRevisionId: made.revisionId,
    put: [
      { path: "docs/b.md", encoding: "utf8", data: "# Вторая заметка\n" },
      { path: "docs/a.md", encoding: "utf8", data: "# Заметка\n\nВторая версия.\n" },
    ],
    remove: ["style.css"],
  };
  const changed = await api(secret, "POST", `/api/v1/works/${made.artifactId}/changes`, body);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().number, 2);
  assert.notEqual(changed.json().revisionId, made.revisionId);
  const next = (await api(secret, "GET", `/api/v1/works/${made.artifactId}/files`)).json();
  assert.deepEqual(next.files.map((f: any) => f.path).sort(), ["README.md", "big.txt", "docs/a.md", "docs/b.md", "logo.png", "medium.txt"]);
  const byPath = new Map<string, any>(next.files.map((f: any) => [f.path, f]));
  assert.equal(byPath.get("docs/b.md").mime, "text/markdown");
  // Untouched files keep their bytes (copied inside the store).
  assert.equal(byPath.get("logo.png").sha256, createHash("sha256").update(PNG).digest("hex"));
  const readBack = (await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=${encodeURIComponent("docs/a.md")}`)).json();
  assert.match(readBack.data, /Вторая версия/);
  // The old version is untouched.
  const old = (
    await api(secret, "GET", `/api/v1/works/${made.artifactId}/file?path=${encodeURIComponent("docs/a.md")}&revisionId=${made.revisionId}`)
  ).json();
  assert.match(old.data, /Первая версия/);

  // The same key and body again: the same version, nothing new.
  const again = await api(secret, "POST", `/api/v1/works/${made.artifactId}/changes`, body);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().revisionId, changed.json().revisionId);
  // A stale base: 409 naming the latest.
  const stale = await api(secret, "POST", `/api/v1/works/${made.artifactId}/changes`, {
    key: randomUUID(),
    baseRevisionId: made.revisionId,
    put: [{ path: "docs/c.md", encoding: "utf8", data: "x" }],
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().currentRevisionId, changed.json().revisionId);
});

test("refusals: the entrypoint, a missing path, an unknown type, a doubled or colliding path, an empty change", async () => {
  const secret = await token(owner, ALL);
  const made = await project(secret, files().slice(0, 4), "README.md");
  const change = (extra: Record<string, unknown>) =>
    api(secret, "POST", `/api/v1/works/${made.artifactId}/changes`, { key: randomUUID(), baseRevisionId: made.revisionId, ...extra });
  assert.equal((await change({ remove: ["README.md"] })).statusCode, 422);
  assert.equal((await change({ remove: ["nope.md"] })).statusCode, 404);
  assert.equal((await change({ put: [{ path: "tool.exe", encoding: "utf8", data: "x" }] })).statusCode, 422);
  assert.equal((await change({ put: [{ path: "docs/a.md", encoding: "utf8", data: "x" }], remove: ["docs/a.md"] })).statusCode, 400);
  assert.equal((await change({ put: [{ path: "DOCS/A.md", encoding: "utf8", data: "x" }] })).statusCode, 400);
  assert.equal((await change({})).statusCode, 400);
  assert.equal((await change({ put: [{ path: "../escape.md", encoding: "utf8", data: "x" }] })).statusCode, 400);
  assert.equal((await change({ put: [{ path: "docs/", encoding: "utf8", data: "x" }] })).statusCode, 400);
  assert.equal((await change({ put: [{ path: "заметка.md", encoding: "utf8", data: "x" }] })).statusCode, 400);
  // Base64 that does not decode back, a data: prefix, and a lone surrogate are refused, not repaired.
  assert.equal((await change({ put: [{ path: "pic.gif", encoding: "base64", data: "data:image/gif;base64,AAAA" }] })).statusCode, 400);
  assert.equal((await change({ put: [{ path: "bad.md", encoding: "utf8", data: "\ud800" }] })).statusCode, 400);
  // The reply names the rule that failed.
  const named = await change({ put: [{ path: "../escape.md", encoding: "utf8", data: "x" }] });
  assert.match(named.json().message, /path|путь/i);
  // The same key with a different body is a conflict about the key, not a second version.
  const key = randomUUID();
  const first = await api(secret, "POST", `/api/v1/works/${made.artifactId}/changes`, { key, baseRevisionId: made.revisionId, put: [{ path: "docs/k.md", encoding: "utf8", data: "один" }] });
  assert.equal(first.statusCode, 200, first.body);
  const other = await api(secret, "POST", `/api/v1/works/${made.artifactId}/changes`, { key, baseRevisionId: made.revisionId, put: [{ path: "docs/k.md", encoding: "utf8", data: "два" }] });
  assert.ok(other.statusCode >= 400, other.body);
});

test("scopes and shelves: source:read to read, revise to change; another shelf's work is not found", async () => {
  const full = await token(owner, ALL);
  const made = await project(full, files().slice(0, 4), "README.md");
  const noSource = await token(owner, ["context", "revise"]);
  const noRevise = await token(owner, ["context", "source:read"]);
  assert.ok([403, 404].includes((await api(noSource, "GET", `/api/v1/works/${made.artifactId}/file?path=README.md`)).statusCode));
  assert.ok(
    [403, 404].includes(
      (await api(noRevise, "POST", `/api/v1/works/${made.artifactId}/changes`, {
        key: randomUUID(),
        baseRevisionId: made.revisionId,
        put: [{ path: "docs/z.md", encoding: "utf8", data: "x" }],
      })).statusCode,
    ),
  );
  const stranger = await token(other, ALL);
  assert.equal((await api(stranger, "GET", `/api/v1/works/${made.artifactId}/file?path=README.md`)).statusCode, 404);
  assert.equal(
    (await api(stranger, "POST", `/api/v1/works/${made.artifactId}/changes`, {
      key: randomUUID(),
      baseRevisionId: made.revisionId,
      put: [{ path: "docs/z.md", encoding: "utf8", data: "x" }],
    })).statusCode,
    404,
  );
});

test("the same three operations over MCP", async () => {
  const secret = await token(owner, ALL);
  const made = await project(secret, files().slice(0, 4), "README.md");
  const listed = await mcp(secret, "polka_list_files", { artifactId: made.artifactId });
  assert.equal(listed.error, false, JSON.stringify(listed.value));
  assert.equal(listed.value.files.length, 4);
  const read = await mcp(secret, "polka_read_file", { artifactId: made.artifactId, path: "docs/a.md" });
  assert.equal(read.value.encoding, "utf8");
  const changed = await mcp(secret, "polka_change_files", {
    key: randomUUID(),
    artifactId: made.artifactId,
    baseRevisionId: made.revisionId,
    put: [{ path: "docs/mcp.md", encoding: "utf8", data: "# из чата\n" }],
    remove: ["style.css"],
  });
  assert.equal(changed.error, false, JSON.stringify(changed.value));
  assert.equal(changed.value.number, 2);
  const after2 = await mcp(secret, "polka_list_files", { artifactId: made.artifactId });
  assert.deepEqual(after2.value.files.map((f: any) => f.path).sort(), ["README.md", "docs/a.md", "docs/mcp.md", "logo.png"]);
  const conflict = await mcp(secret, "polka_change_files", {
    key: randomUUID(),
    artifactId: made.artifactId,
    baseRevisionId: made.revisionId,
    put: [{ path: "docs/x.md", encoding: "utf8", data: "x" }],
  });
  assert.equal(conflict.error, true);
  assert.equal(conflict.value.code, "conflict");
  assert.ok(conflict.value.currentRevisionId);
  // A page is not a folder: it changes through polka_revise.
  const page = await api(secret, "POST", "/api/v1/publish", {
    key: randomUUID(),
    title: "Одна страница",
    html: "<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head><body><h1>t</h1></body></html>",
  });
  assert.equal(page.statusCode, 200, page.body);
  const refused = await mcp(secret, "polka_change_files", {
    key: randomUUID(),
    artifactId: page.json().artifactId,
    baseRevisionId: page.json().revisionId,
    put: [{ path: "app.js", encoding: "utf8", data: "1" }],
  });
  assert.equal(refused.error, true);
  assert.equal(refused.value.status, 422);
  // A path error over MCP says which rule failed.
  const odd = await mcp(secret, "polka_change_files", {
    key: randomUUID(),
    artifactId: made.artifactId,
    baseRevisionId: changed.value.revisionId,
    put: [{ path: "заметка.md", encoding: "utf8", data: "x" }],
  });
  assert.equal(odd.error, true);
  assert.match(odd.value.message, /ASCII|path|путь/i);
  // The shelf address works as the work's name, as for the read tools.
  const byUrl = await mcp(secret, "polka_list_files", { artifactId: `https://polochka.app/works/${made.artifactId}` });
  assert.equal(byUrl.error, false, JSON.stringify(byUrl.value));
});
