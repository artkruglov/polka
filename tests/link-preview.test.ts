import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { registerFrontend } from "../apps/server/frontend.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const secretTitle = `Секретный отчёт ${randomBytes(4).toString("hex")}`;
let cookie = "";
let root = "";
let token = "";
let artifactId = "";

const call = (method: any, url: string, body?: any, headers = {}) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
      ...headers,
    },
    payload: body,
  });

/** The og:* and twitter:* tags of a page, as name → content. */
function previewTags(html: string) {
  const tags = new Map<string, string>();
  for (const [, , name, content] of html.matchAll(
    /<meta (property|name)="((?:og|twitter):[^"]+)" content="([^"]*)" \/>/g,
  ))
    tags.set(name, content);
  return tags;
}

before(async () => {
  // The real page shell and public files, as the build copies them into dist/.
  root = await mkdtemp(join(tmpdir(), "polka-og-"));
  await cp(join(import.meta.dirname, "../apps/web/public/og"), join(root, "og"), {
    recursive: true,
  });
  await cp(
    join(import.meta.dirname, "../apps/web/index.html"),
    join(root, "index.html"),
  );
  await registerFrontend(app, root);
  const account = await createAccount(
    `og-${randomBytes(5).toString("hex")}`,
    password,
  );
  const login = await call("POST", "/api/login", {
    name: account.name,
    password,
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  // A shared work whose title must never reach a link preview.
  const bytes = Buffer.from(`<!doctype html><title>${secretTitle}</title><p>x`);
  const begin = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: secretTitle,
    filename: "secret.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(begin.statusCode, 200, begin.body);
  const { uploadId } = begin.json();
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes)).statusCode,
    200,
  );
  const receipt = (
    await call("POST", `/api/uploads/${uploadId}/finalize`, {})
  ).json();
  artifactId = receipt.artifactId;
  const shared = await call("POST", `/api/artifacts/${artifactId}/share`, {
    expectedRevisionId: receipt.revisionId,
    expiresInDays: 7,
  });
  assert.equal(shared.statusCode, 200, shared.body);
  token = new URL(shared.json().share.url).hash.slice(1);
  assert.ok(token);
  cookie = "";
});

after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  await db.end();
  s3.destroy();
});

test("/ and other app pages carry the default link preview with absolute URLs", async () => {
  for (const path of ["/", "/discover", "/signup"]) {
    const page = await call("GET", path);
    assert.equal(page.statusCode, 200, path);
    assert.match(page.headers["content-type"] as string, /^text\/html/);
    const tags = previewTags(page.body);
    assert.equal(tags.get("og:title"), "Полка — место для работ, сделанных с ИИ");
    assert.equal(tags.get("og:image"), `${origin}/og/default.png`);
    assert.equal(tags.get("og:url"), `${origin}/`);
    assert.equal(tags.get("og:image:width"), "1200");
    assert.equal(tags.get("og:image:height"), "630");
    assert.equal(tags.get("twitter:card"), "summary_large_image");
    // The tags land inside <head>, and the app shell is still there.
    assert.ok(page.body.indexOf("og:title") < page.body.indexOf("</head>"));
    assert.match(page.body, /<div id="root"><\/div>/);
  }
  const image = await call("GET", "/og/default.png");
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
});

test("/s shows one generic card that never carries share data", async () => {
  const plain = await call("GET", "/s");
  assert.equal(plain.statusCode, 200);
  const tags = previewTags(plain.body);
  assert.equal(tags.get("og:title"), "Полка — вам отправили страницу");
  assert.equal(tags.get("twitter:title"), "Полка — вам отправили страницу");
  assert.equal(tags.get("og:image"), `${origin}/og/share.png`);
  assert.equal(tags.get("twitter:image"), `${origin}/og/share.png`);
  assert.equal(tags.get("og:url"), `${origin}/s`);
  assert.equal(tags.get("twitter:card"), "summary_large_image");
  assert.ok(tags.get("og:description"));
  const image = await call("GET", "/og/share.png");
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  const png = await readFile(join(root, "og/share.png"));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);

  // Whatever a crawler sends (a token misplaced into the query, a referer,
  // a crawler user agent), the page is byte-identical and names nothing.
  for (const [url, headers] of [
    [`/s?${token}`, {}],
    [`/s?t=${token}&title=x`, { referer: `${origin}/s#${token}` }],
    ["/s", { "user-agent": "TelegramBot (like TwitterBot)" }],
  ] as const) {
    const page = await call("GET", url, undefined, headers);
    assert.equal(page.statusCode, 200, url);
    assert.equal(page.body, plain.body, url);
  }
  for (const secret of [secretTitle, token, artifactId, "secret.html"])
    assert.ok(!plain.body.includes(secret), secret);
});

test("public pages may be indexed; shared works, shelves and the API stay noindex", async () => {
  cookie = "";
  for (const url of ["/", "/connect", "/llms.txt", "/discover", "/enterprise", "/privacy"]) {
    const response = await call("GET", url);
    assert.equal(response.headers["x-robots-tag"], undefined, url);
    assert.doesNotMatch(response.body, /<meta name="robots"/, url);
  }
  for (const url of ["/s", "/signup", "/api/session", `/works/${randomUUID()}`]) {
    const response = await call("GET", url);
    assert.equal(response.headers["x-robots-tag"], "noindex, nofollow, noarchive", url);
    if (String(response.headers["content-type"]).startsWith("text/html"))
      assert.match(response.body, /<meta name="robots" content="noindex,nofollow" \/>/, url);
  }
  const robots = await call("GET", "/robots.txt");
  assert.equal(robots.statusCode, 200);
  assert.match(robots.body, /^User-agent: \*/);
  assert.match(robots.body, /\nAllow: \/connect\n/);
  assert.match(robots.body, /\nDisallow: \/\n/);
  assert.doesNotMatch(robots.body, /Allow: \/s\b/);
});
