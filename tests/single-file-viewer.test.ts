// Markdown, CSV and JSON works on the viewer domain (docs/specs/SINGLE_FILE_FORMATS.md):
// Полка's own page of the file, with the static view's grants, CSP and
// checks, for the owner and for a recipient of a link.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { verifyAwayToken } from "../apps/server/away-links.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { staticHtmlCsp } from "../apps/server/html.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { CSV_MAX_ROWS } from "../apps/server/single-file-view-csv.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

if (!config.HTML_LIVE_ENABLED) throw new Error("Run single-file-viewer.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";

const embedded = (path: string, headers: Record<string, string> = {}) =>
  viewer.inject({
    url: path,
    headers: {
      host: config.VIEWER_UPSTREAM_HOST,
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
      ...headers,
    },
  });
const pathOf = (url: string) => new URL(url).pathname;

async function call(method: any, url: string, body?: any, cookie = ownerCookie, authorization?: string) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body,
  });
}

async function save(filename: string, mime: string, source: string) {
  const bytes = Buffer.from(source);
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: filename,
    filename,
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  const put = await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes);
  assert.equal(put.statusCode, 200, put.body);
  const finish = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finish.statusCode, 200, finish.body);
  return finish.json() as { artifactId: string; revisionId: string };
}

async function share(saved: { artifactId: string; revisionId: string }) {
  const enabled = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId,
    expiresInDays: 1,
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const resolved = await call("POST", "/api/resolve", { token: new URL(enabled.json().share.url).hash.slice(1) }, "");
  assert.equal(resolved.statusCode, 200, resolved.body);
  return resolved.json().grant as string;
}

const MARKDOWN =
  "# Итоги недели\n\nСм. [источник](https://example.org/report?a=1) и `config.json`.\n\n| город | выручка |\n|---|---|\n| Казань | 1200 |\n\n<script>alert(1)</script>\n";
const CSV = "город;выручка\nКазань;1200\nПермь;<b>800</b>\n";
const JSON_TEXT = '{\n  "status": "ок",\n  "html": "<script>alert(1)</script>"\n}\n';

before(async () => {
  owner = await createAccount(`single-viewer-${randomBytes(5).toString("hex")}`, password);
  const login = await call("POST", "/api/login", { name: owner.name, password }, "");
  assert.equal(login.statusCode, 200, login.body);
  ownerCookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("the owner's view of each format is Полка's page on the viewer domain, without scripts", async () => {
  for (const [filename, mime, source, expected] of [
    ["notes.md", "text/markdown", MARKDOWN, /<h1 id="итоги-недели">Итоги недели<\/h1>[\s\S]*<td>Казань<\/td>/],
    ["leads.csv", "text/csv", CSV, /<th>город<\/th><th>выручка<\/th>[\s\S]*<td>&lt;b&gt;800&lt;\/b&gt;<\/td>/],
    ["result.json", "application/json", JSON_TEXT, /<pre class="polka-code"><code>\{\n  &quot;status&quot;/],
  ] as const) {
    const saved = await save(filename, mime, source);
    const issued = await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {});
    assert.equal(issued.statusCode, 200, issued.body);
    const { url } = issued.json();
    assert.equal(new URL(url).origin, config.VIEWER_ORIGIN);
    const page = await embedded(pathOf(url));
    assert.equal(page.statusCode, 200, page.body);
    assert.match(String(page.headers["content-type"]), /^text\/html; charset=utf-8/);
    assert.equal(page.headers["content-security-policy"], staticHtmlCsp(config.APP_ORIGIN));
    assert.match(page.body, expected, filename);
    assert.doesNotMatch(page.body, /<script/i, filename);
    // Never a top-level page, never from the app's origin.
    assert.equal((await embedded(pathOf(url), { "sec-fetch-dest": "document" })).statusCode, 404);
    assert.equal(
      (await call("GET", `/api/revisions/${saved.revisionId}/document`, undefined, ownerCookie)).statusCode,
      404,
    );
    if (mime === "text/markdown") {
      // External links go through the signed «you are leaving» page.
      const away = /href="[^"]+\/away#([^"]+)"/.exec(page.body);
      assert.ok(away, page.body);
      assert.equal(verifyAwayToken(away[1]!)!.url, "https://example.org/report?a=1");
    }
  }
});

test("a recipient opens the drawn page through the link, with the comment overlay when asked", async () => {
  const saved = await save("leads.csv", "text/csv", CSV);
  const grant = await share(saved);
  const issued = await call("POST", "/api/view/static-view", undefined, "", `Bearer ${grant}`);
  assert.equal(issued.statusCode, 200, issued.body);
  const page = await embedded(pathOf(issued.json().url));
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /<table class="polka-sheet">/);
  const commented = await call("POST", "/api/view/static-view", { comments: true }, "", `Bearer ${grant}`);
  assert.equal(commented.statusCode, 200, commented.body);
  const overlay = await embedded(pathOf(commented.json().url));
  assert.equal(overlay.statusCode, 200, overlay.body);
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(String(overlay.headers["content-security-policy"]))?.[1];
  assert.ok(nonce);
  assert.deepEqual(
    [...overlay.body.matchAll(/<script([^>]*)>/g)].map((m) => m[1]),
    [` nonce="${nonce}"`, ` nonce="${nonce}"`],
  );
  // The raw file stays available to the recipient, as for a text.
  const bytes = await call("GET", "/api/view/bytes", undefined, "", `Bearer ${grant}`);
  assert.equal(bytes.statusCode, 200);
  assert.equal(bytes.body, CSV);
  // A trashed work closes the view.
  const third = (await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {})).json().url as string;
  const artifact = (await call("GET", `/api/artifacts/${saved.artifactId}`)).json();
  const trashed = await call("POST", `/api/artifacts/${saved.artifactId}/trash`, {
    expectedLifecycleVersion: artifact.lifecycleVersion,
    expectedRevisionId: saved.revisionId,
  });
  assert.equal(trashed.statusCode, 200, trashed.body);
  assert.equal((await embedded(pathOf(third))).statusCode, 404);
});

test("a large table is drawn in the pool and cut at 2 000 rows; a text file gets no static view", async () => {
  const rows = Array.from({ length: CSV_MAX_ROWS + 1000 }, (_, i) => `${i};строка ${i}`).join("\n");
  const saved = await save("big.csv", "text/csv", `n;v\n${rows}\n`);
  const url = (await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {})).json().url as string;
  const page = await embedded(pathOf(url));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Показаны первые 2 000 строк/);
  assert.equal(page.body.match(/<tr>/g)!.length, CSV_MAX_ROWS + 1);
  // Plain text keeps the app's reading view; the viewer has no page for it.
  const text = await save("note.txt", "text/plain", "Просто текст");
  assert.equal((await call("POST", `/api/revisions/${text.revisionId}/static-view`, {})).statusCode, 404);
});
