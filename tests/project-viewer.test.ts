// The project viewer (docs/specs/PROJECTS.md): an owner's view of a whole
// project, page by page. Markdown drawn by Полка with its links resolved,
// pages served as they are in a sandbox, resources only to pages of the
// project, and the view ends with the session or the trash.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { resolveProjectPath } from "../apps/server/project-markdown.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run project-viewer.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
let saved: { artifactId: string; revisionId: string };

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf00000301010018dd8db40000000049454e44ae426082",
  "hex",
);
const files = [
  ["README.md", "text/markdown", "# Исследование\n\nСм. `02-users/stories.md`, [экраны](screens/) и `05-old/gone.md`.\n\n<script>alert(1)</script>\n\n[внешняя](https://example.com/a) · [плохая](javascript:alert(1))\n\n![скрин](screens/shot.png)\n"],
  ["02-users/stories.md", "text/markdown", "# Истории\n\nНазад: `README.md`.\n"],
  ["screens/index.html", "text/html", '<!doctype html><html><head><title>Экраны</title><link rel="stylesheet" href="shared/ui.css"></head><body><h1>Экраны</h1><a href="../README.md">назад</a><a href="https://example.com/b">наружу</a><script>document.body.dataset.ok="1"</script></body></html>'],
  ["screens/shared/ui.css", "text/css", "h1{color:red}"],
  ["screens/shot.png", "image/png", PNG],
] as const;

const view = (url: string, dest = "iframe", mode = "navigate") =>
  viewer.inject({
    method: "GET",
    url: new URL(url).pathname,
    headers: {
      host: config.VIEWER_UPSTREAM_HOST,
      "sec-fetch-dest": dest,
      "sec-fetch-mode": mode,
    },
  });

async function issue() {
  const response = await app.inject({
    method: "POST",
    url: `/api/revisions/${saved.revisionId}/project-view`,
    headers: { origin, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().url as string;
}

before(async () => {
  owner = await createAccount(`project-view-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'viewer',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), ["capture"], MCP_AUDIENCE],
  );
  const bodies = files.map(([path, mime, data]) => ({ path, mime, bytes: Buffer.isBuffer(data) ? data : Buffer.from(data) }));
  const auth = { authorization: `Bearer ${secret}` };
  const begun = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({
      key: randomUUID(),
      title: "Исследование",
      manifest: {
        version: 1,
        entrypoint: "README.md",
        runtime: "project-v1",
        files: bodies.map((f) => ({ path: f.path, mime: f.mime, size: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex") })),
        provenance: { kind: "file", sourceUrl: null, capturedAt: new Date().toISOString(), attribution: "unknown", license: "unknown" },
        dependencies: { status: "unknown", unresolved: [] },
      },
    }),
  });
  assert.equal(begun.statusCode, 200, begun.body);
  for (const { index, path } of begun.json().files)
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${begun.json().uploadId}/files/${index}`,
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: bodies.find((f) => f.path === path)!.bytes,
    });
  const done = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${begun.json().uploadId}/finalize`,
    headers: { ...auth, "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(done.statusCode, 200, done.body);
  saved = done.json();
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("paths agents write resolve inside the project", () => {
  const paths = new Set(["README.md", "01-facts/market.md", "02-users/stories.md", "screens/index.html"]);
  assert.equal(resolveProjectPath(paths, "01-facts/market.md", "../02-users/stories.md"), "02-users/stories.md");
  assert.equal(resolveProjectPath(paths, "01-facts/market.md", "02-users/stories.md"), "02-users/stories.md");
  assert.equal(resolveProjectPath(paths, "README.md", "market.md"), "01-facts/market.md");
  assert.equal(resolveProjectPath(paths, "README.md", "screens/"), "screens/index.html");
  assert.equal(resolveProjectPath(paths, "README.md", "../../etc/passwd"), null);
  assert.equal(resolveProjectPath(paths, "README.md", "https://example.com/x.md"), null);
});

test("a document is drawn by Полка: links resolved, the author's HTML shown as text", async () => {
  const url = await issue();
  const response = await view(url);
  assert.equal(response.statusCode, 200, response.body);
  const html = response.body;
  assert.match(html, /<a class="polka-path" href="02-users\/stories\.md"><code>02-users\/stories\.md<\/code><\/a>/);
  assert.match(html, /<a href="screens\/index\.html">экраны<\/a>/);
  assert.match(html, /class="polka-outside"[^>]*><code>05-old\/gone\.md<\/code>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, new RegExp(`href="${origin}/away#`));
  assert.match(html, /<img src="screens\/shot\.png" alt="скрин"/);
  const csp = String(response.headers["content-security-policy"]);
  assert.match(csp, /sandbox allow-scripts(;|$)/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, new RegExp(`frame-ancestors ${origin}`));
  // Relative links from a nested document go back up.
  const nested = await view(url + "02-users/stories.md");
  assert.match(nested.body, /href="\.\.\/README\.md"/);
});

test("a page is served as it is, sandboxed, with its own resources only", async () => {
  const url = await issue();
  const page = await view(url + "screens/index.html");
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /<head><script src="[^"]+\/__polka\/nav\.js"><\/script><title>/);
  assert.match(page.body, new RegExp(`href="${origin}/away#`));
  const csp = String(page.headers["content-security-policy"]);
  assert.match(csp, /^sandbox allow-scripts allow-forms;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(csp, new RegExp(`style-src ${url} 'unsafe-inline'`));
  // A folder opens its index page at its own address.
  const folder = await view(url + "screens");
  assert.equal(folder.statusCode, 303);
  assert.equal(folder.headers.location, url + "screens/index.html");
  // Resources go only to a page asking for their kind.
  assert.equal((await view(url + "screens/shared/ui.css", "style", "no-cors")).statusCode, 200);
  // A font is fetched in CORS mode from a sandboxed page (origin "null").
  assert.equal((await view(url + "screens/shot.png", "image", "no-cors")).headers["access-control-allow-origin"], undefined);
  assert.equal((await view(url + "screens/shot.png", "image", "no-cors")).headers["content-type"], "image/png");
  assert.equal((await view(url + "screens/shared/ui.css", "script", "no-cors")).statusCode, 404);
  assert.equal((await view(url + "screens/index.html", "script", "no-cors")).statusCode, 404);
  assert.equal((await view(url + "README.md", "document")).statusCode, 404);
  assert.equal((await view(url + "__polka/nav.js", "script", "no-cors")).statusCode, 200);
  assert.equal((await view(url + "../../etc/passwd")).statusCode, 404);
  assert.equal((await view(url + "missing.md")).statusCode, 404);
});

test("the view ends with the session and with the trash", async () => {
  const url = await issue();
  assert.equal((await view(url)).statusCode, 200);
  await db.query("UPDATE artifacts SET trashed_at=now() WHERE id=$1", [saved.artifactId]);
  try {
    assert.equal((await view(url)).statusCode, 404);
    const refused = await app.inject({ method: "POST", url: `/api/revisions/${saved.revisionId}/project-view`, headers: { origin, cookie } });
    assert.equal(refused.statusCode, 404);
  } finally {
    await db.query("UPDATE artifacts SET trashed_at=NULL WHERE id=$1", [saved.artifactId]);
  }
  const again = await issue();
  await db.query("DELETE FROM sessions WHERE account_id=$1", [owner.id]);
  assert.equal((await view(again)).statusCode, 404);
});

test("a link opens the whole project for a recipient until it is revoked", async () => {
  // The test above ended the owner's sessions.
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const shared = await app.inject({
    method: "POST",
    url: `/api/artifacts/${saved.artifactId}/share`,
    headers: { origin, cookie },
    payload: { expectedRevisionId: saved.revisionId, expiresInDays: 7 },
  });
  assert.equal(shared.statusCode, 200, shared.body);
  const token = new URL(shared.json().share.url).hash.slice(1);
  const resolved = await app.inject({
    method: "POST",
    url: "/api/resolve",
    headers: { origin, "content-type": "application/json" },
    payload: JSON.stringify({ token }),
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().revision.manifest.runtime, "project-v1");
  const issued = await app.inject({
    method: "POST",
    url: "/api/view/project-view",
    headers: { origin, authorization: `Bearer ${resolved.json().grant}` },
  });
  assert.equal(issued.statusCode, 200, issued.body);
  const url = issued.json().url as string;
  assert.equal((await view(url)).statusCode, 200);
  assert.equal((await view(url + "02-users/stories.md")).statusCode, 200);
  // The view follows the link, not the 60-second grant it was issued from.
  await db.query("UPDATE grants SET expires_at=now()-interval '1 second' WHERE share_id=$1", [shared.json().share.id]);
  assert.equal((await view(url + "screens/index.html")).statusCode, 200);
  // A link paused after reports closes the open project at once.
  await db.query("UPDATE shares SET moderation='paused' WHERE id=$1", [shared.json().share.id]);
  assert.equal((await view(url)).statusCode, 404);
  await db.query("UPDATE shares SET moderation='none' WHERE id=$1", [shared.json().share.id]);
  assert.equal((await view(url)).statusCode, 200);
  await db.query("UPDATE shares SET revoked=true WHERE id=$1", [shared.json().share.id]);
  assert.equal((await view(url)).statusCode, 404);
});
