// CSV, Markdown and JSON as single-file works (docs/specs/SINGLE_FILE_FORMATS.md):
// the contract table, the checks of a save, search, the agent's context and
// publish paths, and an install without a viewer domain (the default suite
// runs static-only). The viewer's pages are in tests/single-file-viewer.test.ts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { sourceForAgent } from "../apps/server/agent-context.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createMcpServer } from "../apps/server/mcp-server.ts";
import { renderProjectMarkdown } from "../apps/server/project-markdown.ts";
import { backfillSearch } from "../apps/server/search-backfill.ts";
import { authenticateServiceToken, MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { CSV_MAX_ROWS, csvTableHtml } from "../apps/server/single-file-view-csv.ts";
import { drawSingleFile } from "../apps/server/single-file-view.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { bundleManifestSchema } from "../packages/contracts/bundle.ts";
import {
  MIME,
  SINGLE_FILE_FORMATS,
  beginUploadSchema,
  isDrawnMime,
  isTextMime,
  mimeForFilename,
  type AgentScope,
} from "../packages/contracts/index.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

async function call(method: any, url: string, body?: any, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      cookie,
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
      ...headers,
    },
    payload: body,
  });
}

/** The web form's three steps; the bytes step answers 422 for a refused file. */
async function upload(filename: string, mime: string, bytes: Buffer, title = filename) {
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title,
    filename,
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  const put = await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes);
  if (put.statusCode !== 200) return { refused: put };
  const finish = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finish.statusCode, 200, finish.body);
  return { saved: finish.json() as { artifactId: string; revisionId: string } };
}

async function token(scopes: AgentScope[]) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'single files',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}

const publish = (body: unknown, secret: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: `2001:db8::${randomBytes(2).toString("hex")}`,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: JSON.stringify(body),
  });

const revisionOf = async (revisionId: string) =>
  (await db.query("SELECT mime,filename,storage_kind,manifest FROM revisions WHERE id=$1", [revisionId])).rows[0];

const CSV = "город;выручка\nКазань;1200\nПермь;800\n";
const MARKDOWN =
  "# Итоги недели\n\nГлавное: `config.json` переписан, [план](plan.md) готов.\n\n<script>alert(1)</script>\n";
const JSON_TEXT = '{"status":"ок","items":[1,2,3],"note":"<b>не разметка</b>"}';

before(async () => {
  owner = await createAccount(`single-files-${randomBytes(5).toString("hex")}`, password);
  const login = await call("POST", "/api/login", { name: owner.name, password });
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("one row per format: MIME, extensions, text and drawn formats", () => {
  assert.deepEqual(Object.keys(SINGLE_FILE_FORMATS).sort(), [...MIME].sort());
  for (const [name, mime] of [
    ["leads.CSV", "text/csv"],
    ["README.md", "text/markdown"],
    ["notes.markdown", "text/markdown"],
    ["result.json", "application/json"],
    ["page.htm", "text/html"],
    ["photo.JPEG", "image/jpeg"],
    ["archive.zip", null],
    ["report.PDF", "application/pdf"],
  ] as const)
    assert.equal(mimeForFilename(name), mime, name);
  assert.deepEqual(MIME.filter(isTextMime).sort(), ["application/json", "text/csv", "text/markdown", "text/plain"]);
  assert.deepEqual(MIME.filter(isDrawnMime).sort(), ["application/json", "text/csv", "text/markdown"]);
  assert.equal(isTextMime("text/html"), false);
  assert.equal(isTextMime("application/vnd.polka.link+json"), false);
  for (const mime of ["text/csv", "text/markdown", "application/json"])
    beginUploadSchema.parse({
      key: randomUUID(),
      title: "t",
      filename: "f",
      mime,
      size: 1,
      sha256: "a".repeat(64),
    });
});

test("bundles stay as they were: no CSV anywhere, Markdown in projects only", () => {
  const manifest = (runtime: string, files: Array<[string, string]>) => ({
    version: 1,
    entrypoint: files[0]![0],
    runtime,
    files: files.map(([path, mime]) => ({ path, mime, size: 10, sha256: "a".repeat(64) })),
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: "2026-10-15T12:00:00Z",
      attribution: "test",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  });
  const page: [string, string] = ["index.html", "text/html"];
  assert.ok(
    bundleManifestSchema.safeParse(manifest("static-sandbox-v1", [page, ["data.json", "application/json"]])).success,
  );
  assert.ok(!bundleManifestSchema.safeParse(manifest("static-sandbox-v1", [page, ["data.csv", "text/csv"]])).success);
  assert.ok(
    !bundleManifestSchema.safeParse(
      manifest("project-v1", [
        ["README.md", "text/markdown"],
        ["d.csv", "text/csv"],
      ]),
    ).success,
  );
  assert.ok(!bundleManifestSchema.safeParse(manifest("static-sandbox-v1", [page, ["n.md", "text/markdown"]])).success);
  assert.ok(bundleManifestSchema.safeParse(manifest("project-v1", [["README.md", "text/markdown"]])).success);
  assert.ok(!bundleManifestSchema.safeParse(manifest("static-sandbox-v1", [["README.md", "text/markdown"]])).success);
});

test("a save checks the bytes: UTF-8 without NUL, JSON that parses", async () => {
  const cp1251 = Buffer.from([0xc3, 0xee, 0xf0, 0xee, 0xe4, 0x3b, 0x31, 0x0a]);
  const csv = await upload("old.csv", "text/csv", cp1251);
  assert.equal(csv.refused?.statusCode, 422);
  assert.match(csv.refused!.json().message, /CSV UTF-8/);
  const json = await upload("bad.json", "application/json", Buffer.from("{status: ok}"));
  assert.equal(json.refused?.statusCode, 422);
  assert.match(json.refused!.json().message, /JSON/);
  const nul = await upload("nul.md", "text/markdown", Buffer.from("# a\u0000b"));
  assert.equal(nul.refused?.statusCode, 422);
  assert.match(nul.refused!.json().message, /UTF-8/);
  for (const [name, mime, text] of [
    ["leads.csv", "text/csv", CSV],
    ["notes.md", "text/markdown", MARKDOWN],
    ["result.json", "application/json", JSON_TEXT],
  ] as const) {
    const saved = await upload(name, mime, Buffer.from(text));
    assert.ok(saved.saved, name);
    const revision = await revisionOf(saved.saved!.revisionId);
    assert.equal(revision.mime, mime);
    assert.equal(revision.storage_kind, "single");
    assert.equal(revision.manifest, null);
  }
});

test("search finds a word of a CSV and of a Markdown work, the backfill too", async () => {
  const csv = (await upload("cities.csv", "text/csv", Buffer.from("город;клиент\nВологда;Аристарх\n"))).saved!;
  const md = (await upload("plan.md", "text/markdown", Buffer.from("# План\n\nПереезд в Кострому весной.\n"))).saved!;
  const search = async (q: string) => {
    const response = await call("GET", `/api/artifacts?${new URLSearchParams({ q })}`);
    assert.equal(response.statusCode, 200, response.body);
    return (response.json().items as Array<{ id: string }>).map((item) => item.id);
  };
  assert.deepEqual(await search("Аристарх"), [csv.artifactId]);
  assert.deepEqual(await search("Кострому"), [md.artifactId]);
  // The shelf chip: a table and a document are documents.
  const documents = await call("GET", "/api/artifacts?kind=documents");
  assert.equal(documents.statusCode, 200, documents.body);
  const ids = (documents.json().items as Array<{ id: string }>).map((item) => item.id);
  assert.ok(ids.includes(csv.artifactId) && ids.includes(md.artifactId));
  // Saved before search read these formats: the backfill reads them as text, not as HTML.
  await db.query("DELETE FROM artifact_search WHERE artifact_id=ANY($1::uuid[])", [[csv.artifactId, md.artifactId]]);
  assert.deepEqual(await search("Аристарх"), []);
  const report = await backfillSearch({ artifactIds: [csv.artifactId, md.artifactId] });
  assert.equal(report.indexed, 2);
  assert.deepEqual(await search("Аристарх"), [csv.artifactId]);
  const {
    rows: [row],
  } = await db.query("SELECT body FROM artifact_search WHERE artifact_id=$1", [md.artifactId]);
  assert.match(row.body, /^# План/);
});

test("the agent's context hands over the file under its format's name", async () => {
  const secret = await token(["source:read"]);
  const agent = await authenticateServiceToken(secret, MCP_AUDIENCE);
  for (const [name, mime, text, path] of [
    ["leads.csv", "text/csv", CSV, "source.csv"],
    ["notes.md", "text/markdown", MARKDOWN, "source.md"],
    ["result.json", "application/json", JSON_TEXT, "source.json"],
  ] as const) {
    const saved = (await upload(name, mime, Buffer.from(text))).saved!;
    const source = await sourceForAgent(agent, { artifactId: saved.artifactId, revisionId: saved.revisionId });
    assert.deepEqual(source.context.availableContent, [
      { path, mime, size: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) },
    ]);
    assert.equal(Buffer.from(source.files[0]!.data, "base64").toString("utf8"), text);
  }
});

test("POST /api/v1/publish saves kind file as it is and links it", async () => {
  const secret = await token(["context", "capture", "revise", "share", "read"]);
  const key = randomUUID();
  const body = { key, title: "Лиды, октябрь", kind: "file", name: "leads.csv", text: CSV, expiresInDays: 7 };
  const first = await publish(body, secret);
  assert.equal(first.statusCode, 200, first.body);
  const result = first.json();
  assert.equal(result.state, "shared");
  assert.match(result.url, /\/s#[A-Za-z0-9_-]{43}$/);
  assert.equal(result.scriptsRunForRecipients, false);
  assert.deepEqual(
    { ...(await revisionOf(result.revisionId)), manifest: undefined },
    { mime: "text/csv", filename: "leads.csv", storage_kind: "single", manifest: undefined },
  );
  // A retry with the same key is the same save and the same link.
  const again = await publish(body, secret);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().artifactId, result.artifactId);
  assert.equal(again.json().url, result.url);
  // A new version of the file moves the work's link.
  const next = await publish(
    {
      key: randomUUID(),
      title: "Лиды, октябрь",
      kind: "file",
      name: "leads.csv",
      text: `${CSV}Омск;500\n`,
      artifactId: result.artifactId,
      baseRevisionId: result.revisionId,
    },
    secret,
  );
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().linkMoved, true);
  assert.equal(next.json().url, result.url);
  const status = await app.inject({
    method: "GET",
    url: `/api/v1/status/${result.artifactId}`,
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().kind, "text");
  // A picture in base64, the format from mime when the name says nothing.
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("png-fixture")]);
  const picture = await publish(
    {
      key: randomUUID(),
      title: "Схема",
      kind: "file",
      name: "scheme",
      mime: "image/png",
      base64: png.toString("base64"),
    },
    secret,
  );
  assert.equal(picture.statusCode, 200, picture.body);
  assert.equal((await revisionOf(picture.json().revisionId)).mime, "image/png");
  // Refusals: invalid JSON, an unknown format, HTML as a file, half a request.
  const invalid = await publish({ key: randomUUID(), title: "x", kind: "file", name: "a.json", text: "{a:1}" }, secret);
  assert.equal(invalid.statusCode, 422, invalid.body);
  const unknown = await publish({ key: randomUUID(), title: "x", kind: "file", name: "a.xlsx", text: "x" }, secret);
  assert.equal(unknown.statusCode, 422, unknown.body);
  const html = await publish({ key: randomUUID(), title: "x", kind: "file", name: "a.html", text: "<p>x</p>" }, secret);
  assert.equal(html.statusCode, 422, html.body);
  const mixed = await publish(
    { key: randomUUID(), title: "x", kind: "file", name: "a.md", text: "x", html: "<p>x</p>" },
    secret,
  );
  assert.equal(mixed.statusCode, 400, mixed.body);
  const stray = await publish({ key: randomUUID(), title: "x", html: "<h1>x</h1>", name: "a.md" }, secret);
  assert.equal(stray.statusCode, 400, stray.body);
  // A key used by a page cannot become a file.
  const pageKey = randomUUID();
  const page = await publish({ key: pageKey, title: "Страница", html: "<h1>Отчёт</h1><p>текст</p>" }, secret);
  assert.equal(page.statusCode, 200, page.body);
  const reused = await publish({ ...body, key: pageKey }, secret);
  assert.equal(reused.statusCode, 409, reused.body);
});

test("MCP polka_publish saves a Markdown file", async () => {
  const actor = await authenticateServiceToken(await token(["context", "capture", "share"]), MCP_AUDIENCE);
  const server = createMcpServer(actor);
  const client = new Client({ name: "single-files", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((item) => item.name === "polka_publish")!;
    assert.match(tool.description ?? "", /kind "file"/);
    assert.ok((tool.inputSchema.properties as Record<string, unknown>).kind);
    const result = await client.callTool({
      name: "polka_publish",
      arguments: { key: randomUUID(), title: "Итоги", kind: "file", name: "itogi.md", text: MARKDOWN },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const value = result.structuredContent as { revisionId: string; url: string | null };
    assert.equal((await revisionOf(value.revisionId)).mime, "text/markdown");
    assert.ok(value.url);
  } finally {
    await client.close();
    await server.close();
  }
});

test("without a viewer domain the app serves no page of a drawn format, only its bytes", async () => {
  assert.equal(config.HTML_LIVE_ENABLED, false);
  const saved = (await upload("leads.csv", "text/csv", Buffer.from(CSV))).saved!;
  const view = await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {});
  assert.equal(view.statusCode, 200, view.body);
  // The client sees an app address and shows the text instead of a frame.
  assert.equal(view.json().url, `/api/revisions/${saved.revisionId}/document`);
  assert.equal((await call("GET", view.json().url, undefined, { "sec-fetch-dest": "iframe" })).statusCode, 404);
  const bytes = await call("GET", `/api/revisions/${saved.revisionId}/bytes`);
  assert.equal(bytes.statusCode, 200);
  assert.equal(bytes.body, CSV);
});

test("Полка's pages of the formats: escaped text, a table of at most 2 000 rows, no scripts", async () => {
  const table = csvTableHtml(`﻿имя;заметка\nАнна;<img src=x onerror=alert(1)>\nБорис;"две\nстроки"\n`);
  assert.match(table, /<th>имя<\/th><th>заметка<\/th>/);
  assert.match(table, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(table, /<td>две\nстроки<\/td>/);
  assert.match(table, /2 строки · 2 столбца/);
  const rows = Array.from({ length: CSV_MAX_ROWS + 500 }, (_, index) => `${index},значение ${index}`).join("\n");
  const big = csvTableHtml(`n,v\n${rows}\n`);
  assert.equal(big.match(/<tr>/g)!.length, CSV_MAX_ROWS + 1);
  assert.match(big, /Показаны первые 2 000 строк/);
  assert.equal(csvTableHtml("").includes("Таблица пустая"), true);

  // A document on its own: a path in backticks stays code, a relative link stays text.
  const alone = renderProjectMarkdown(MARKDOWN, "notes.md", null).body;
  assert.match(alone, /<code>config\.json<\/code>/);
  assert.doesNotMatch(alone, /polka-outside|href="plan\.md"/);
  assert.match(alone, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  for (const [mime, text, expected] of [
    ["text/markdown", MARKDOWN, /<h1 id="итоги-недели">Итоги недели<\/h1>/],
    ["text/csv", CSV, /<table class="polka-sheet">/],
    ["application/json", JSON_TEXT, /<pre class="polka-code"><code>\{&quot;status&quot;/],
  ] as const) {
    const page = (
      await drawSingleFile({ id: randomUUID(), mime, filename: "../x/file" }, Buffer.from(text))
    ).toString();
    assert.match(page, expected);
    assert.doesNotMatch(page, /<script/i);
    assert.match(page, mime === "text/markdown" ? /<title>Итоги недели<\/title>/ : /<title>file<\/title>/);
  }
  await assert.rejects(drawSingleFile({ id: randomUUID(), mime: "text/plain", filename: "a.txt" }, Buffer.from("x")));
});
