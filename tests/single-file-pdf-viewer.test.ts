// A PDF work on the viewer domain (docs/specs/SINGLE_FILE_FORMATS.md, «PDF»):
// Полка's page with pdf.js served from the viewer itself, under a CSP that
// admits only those scripts, no eval, no worker, no network; the document's
// JavaScript and forms never run; owner and recipient views; the recipient
// never gets the raw file. PDFs are built by the test (tests/fixtures/pdf.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { PDFJS_VERSION, PDF_ASSETS_PATH, pdfViewCsp } from "../apps/server/single-file-view-pdf.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { PDF_MIME } from "../packages/contracts/index.ts";
import { buildPdf } from "./fixtures/pdf.ts";

if (!config.HTML_LIVE_ENABLED) throw new Error("Run single-file-pdf-viewer.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
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

async function save(filename: string, mime: string, bytes: Buffer, cookie = ownerCookie) {
  const start = await call(
    "POST",
    "/api/uploads",
    { key: randomUUID(), title: filename, filename, mime, size: bytes.length, sha256: sha256(bytes) },
    cookie,
  );
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  const put = await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes, cookie);
  assert.equal(put.statusCode, 200, put.body);
  const finish = await call("POST", `/api/uploads/${uploadId}/finalize`, {}, cookie);
  assert.equal(finish.statusCode, 200, finish.body);
  return finish.json() as { artifactId: string; revisionId: string };
}

async function share(saved: { artifactId: string; revisionId: string }, cookie = ownerCookie) {
  const enabled = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/share`,
    { expectedRevisionId: saved.revisionId, expiresInDays: 1 },
    cookie,
  );
  assert.equal(enabled.statusCode, 200, enabled.body);
  return enabled.json().share as { url: string; moderation?: string };
}

async function resolve(url: string) {
  const resolved = await call("POST", "/api/resolve", { token: new URL(url).hash.slice(1) }, "");
  assert.equal(resolved.statusCode, 200, resolved.body);
  return resolved.json().grant as string;
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

/** Opens the document's JavaScript and would fetch an address if it ever ran. */
const SCRIPTED = buildPdf({
  pages: [["Scripted report"], ["Page two"]],
  javascript: "app.launchURL('https://example.org/pdf-js-ran', true); this.submitForm('https://example.org/form');",
});
/** The page's scripts: only Полка's, from the pdf.js path of the viewer. */
const scriptTags = (html: string) => [...html.matchAll(/<script([^>]*)>/g)].map((match) => match[1]!.trim());

before(async () => {
  const owner = await createAccount(`pdf-viewer-${randomBytes(5).toString("hex")}`, password);
  ownerCookie = await login(owner.name);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("the owner's PDF opens on the viewer domain: pdf.js from the viewer, a CSP without eval, worker or network", async () => {
  const saved = await save("scripted.pdf", PDF_MIME, SCRIPTED);
  const issued = await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {});
  assert.equal(issued.statusCode, 200, issued.body);
  const { url } = issued.json();
  assert.equal(new URL(url).origin, config.VIEWER_ORIGIN);
  const page = await embedded(pathOf(url));
  assert.equal(page.statusCode, 200, page.body);
  assert.match(String(page.headers["content-type"]), /^text\/html; charset=utf-8/);
  const csp = String(page.headers["content-security-policy"]);
  assert.equal(csp, pdfViewCsp(config.APP_ORIGIN));
  const directives = new Map(
    csp.split(/;\s*/).map((part) => [part.split(" ")[0]!, part.split(" ").slice(1).join(" ")] as const),
  );
  assert.equal(directives.get("sandbox"), "allow-scripts");
  assert.equal(directives.get("script-src"), `${config.VIEWER_ORIGIN}${PDF_ASSETS_PATH}`);
  assert.equal(directives.get("connect-src"), "'none'");
  assert.equal(directives.get("worker-src"), "'none'");
  assert.equal(directives.get("form-action"), "'none'");
  assert.equal(directives.get("frame-ancestors"), config.APP_ORIGIN);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline'[^;]*script|wasm-unsafe-eval|allow-same-origin|allow-forms/);
  assert.equal(page.headers["cache-control"], "no-store");
  // Two scripts: the file as a data block that never runs, and Полка's module.
  assert.deepEqual(scriptTags(page.body), [
    'type="application/pdf;base64" id="polka-pdf-data"',
    `type="module" src="${config.VIEWER_ORIGIN}${PDF_ASSETS_PATH}pdf-view.mjs"`,
  ]);
  const data = /<script type="application\/pdf;base64" id="polka-pdf-data">([^<]*)<\/script>/.exec(page.body)![1]!;
  assert.ok(Buffer.from(data, "base64").equals(SCRIPTED));
  // The document's script is inside the base64 data only, never in the markup.
  assert.doesNotMatch(page.body, /launchURL|submitForm/);
  // Never a top-level page, never from the app's origin.
  assert.equal((await embedded(pathOf(url), { "sec-fetch-dest": "document" })).statusCode, 404);
  assert.equal((await call("GET", `/api/revisions/${saved.revisionId}/document`)).statusCode, 404);
  // Asked with comments, a PDF still gets no overlay: comments are on the whole work.
  const commented = await call("POST", `/api/revisions/${saved.revisionId}/static-view`, { comments: true });
  assert.equal(commented.statusCode, 200, commented.body);
  const withComments = await embedded(pathOf(commented.json().url));
  assert.equal(withComments.headers["content-security-policy"], pdfViewCsp(config.APP_ORIGIN));
  assert.equal(scriptTags(withComments.body).length, 2);
});

test("pdf.js is served by the viewer itself, as scripts only, with scripting off", async () => {
  const root = createRequire(import.meta.url)
    .resolve("pdfjs-dist/package.json")
    .replace(/package\.json$/, "");
  assert.equal(PDFJS_VERSION, JSON.parse(readFileSync(`${root}package.json`, "utf8")).version);
  for (const [name, file] of [
    ["pdf.min.mjs", "legacy/build/pdf.min.mjs"],
    ["pdf.worker.min.mjs", "legacy/build/pdf.worker.min.mjs"],
  ] as const) {
    const served = await viewer.inject({
      url: `${PDF_ASSETS_PATH}${name}`,
      headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "script" },
    });
    assert.equal(served.statusCode, 200, name);
    assert.ok(served.rawPayload.equals(readFileSync(`${root}${file}`)), name);
    assert.match(String(served.headers["content-type"]), /^text\/javascript/);
    assert.equal(served.headers["access-control-allow-origin"], "*");
    assert.equal(served.headers["cache-control"], "public, max-age=31536000, immutable");
    // pdf.js 6 evaluates nothing: no eval path in the files the viewer serves.
    assert.doesNotMatch(served.body, /new Function\(|[^\w.]eval\(/, name);
  }
  const script = await viewer.inject({
    url: `${PDF_ASSETS_PATH}pdf-view.mjs`,
    headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "script" },
  });
  assert.equal(script.statusCode, 200);
  assert.match(script.body, /enableScripting: false/);
  assert.match(script.body, /enableXfa: false/);
  assert.match(script.body, /annotationMode: AnnotationMode\.ENABLE\b/);
  assert.match(script.body, /globalThis\.pdfjsWorker = pdfjsWorker/);
  // No scripting sandbox anywhere: pdf.js's pdf.sandbox module is not served.
  assert.doesNotMatch(script.body, /(?:from|import\()\s*"[^"]*sandbox|ENABLE_FORMS|enableScripting: true/);
  for (const [path, dest] of [
    [`${PDF_ASSETS_PATH}pdf.sandbox.min.mjs`, "script"],
    [`${PDF_ASSETS_PATH}pdf.min.mjs`, "iframe"],
    [`${PDF_ASSETS_PATH}pdf.min.mjs`, "document"],
    [`/__polka/pdf/1.0.0/pdf.min.mjs`, "script"],
  ] as const)
    assert.equal(
      (await viewer.inject({ url: path, headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": dest } }))
        .statusCode,
      404,
      `${path} as ${dest}`,
    );
});

test("a recipient opens the PDF through the link on the viewer; the raw file stays the owner's", async () => {
  const saved = await save("report.pdf", PDF_MIME, SCRIPTED);
  const grant = await resolve((await share(saved)).url);
  const issued = await call("POST", "/api/view/static-view", undefined, "", `Bearer ${grant}`);
  assert.equal(issued.statusCode, 200, issued.body);
  const page = await embedded(pathOf(issued.json().url));
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.headers["content-security-policy"], pdfViewCsp(config.APP_ORIGIN));
  assert.match(page.body, /id="polka-pdf-data"/);
  // The recipient never downloads the original from the app.
  assert.equal((await call("GET", "/api/view/bytes", undefined, "", `Bearer ${grant}`)).statusCode, 404);
  // The owner does, as an attachment.
  const bytes = await call("GET", `/api/revisions/${saved.revisionId}/bytes`);
  assert.equal(bytes.statusCode, 200);
  assert.match(String(bytes.headers["content-disposition"]), /^attachment;/);
  // A trashed work closes the view.
  const again = (await call("POST", "/api/view/static-view", undefined, "", `Bearer ${grant}`)).json().url as string;
  const artifact = (await call("GET", `/api/artifacts/${saved.artifactId}`)).json();
  const trashed = await call("POST", `/api/artifacts/${saved.artifactId}/trash`, {
    expectedLifecycleVersion: artifact.lifecycleVersion,
    expectedRevisionId: saved.revisionId,
  });
  assert.equal(trashed.statusCode, 200, trashed.body);
  assert.equal((await embedded(pathOf(again))).statusCode, 404);
});

test("a link to a PDF with a phishing link is moderated exactly as one to the same link in a page", async () => {
  // A fresh account: a suspicious link waits for review where moderation is on.
  const author = await createAccount(`pdf-phish-${randomBytes(5).toString("hex")}`, password);
  const cookie = await login(author.name);
  const url = "https://sberbank-online.ru-login.xyz/login";
  const pdf = await save("note.pdf", PDF_MIME, buildPdf({ pages: [["Quarterly note"]], links: [url] }), cookie);
  const html = await save(
    "note.html",
    "text/html",
    Buffer.from(`<!doctype html><html><body><p>Quarterly note</p><a href="${url}"></a></body></html>`),
    cookie,
  );
  const signals = async (revisionId: string) =>
    (await db.query("SELECT phishing_signals FROM revisions WHERE id=$1", [revisionId])).rows[0].phishing_signals;
  assert.deepEqual(await signals(pdf.revisionId), await signals(html.revisionId));
  const moderation = async (saved: { artifactId: string; revisionId: string }) => {
    await share(saved, cookie);
    return (await db.query("SELECT moderation,moderation_reason FROM shares WHERE artifact_id=$1", [saved.artifactId]))
      .rows[0];
  };
  assert.deepEqual(await moderation(pdf), await moderation(html));
});
