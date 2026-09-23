import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { verifyAwayToken } from "../apps/server/away-links.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  VIEWER_GUARD,
  staticHtmlCsp,
  withNewTabLinks,
} from "../apps/server/html.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run static-viewer.test.ts with HTML_LIVE_ENABLED=true");

// With a viewer domain the static (scriptless) view moves there as well:
// the app origin serves no saved HTML at all.
const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let strangerCookie = "";

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

async function call(
  method: any,
  url: string,
  body?: any,
  cookie = ownerCookie,
  authorization?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function save(source: string, mime = "text/html") {
  const bytes = Buffer.from(source);
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Static viewer fixture",
    filename: mime === "text/html" ? "fixture.html" : "fixture.txt",
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes)).statusCode,
    200,
  );
  const finish = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finish.statusCode, 200, finish.body);
  return finish.json();
}

async function share(saved: { artifactId: string; revisionId: string }) {
  const enabled = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/share`,
    {
      expectedRevisionId: saved.revisionId,
      expiresInDays: 1,
    },
  );
  assert.equal(enabled.statusCode, 200, enabled.body);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: new URL(enabled.json().share.url).hash.slice(1) },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  return {
    share: enabled.json().share,
    grant: resolved.json().grant as string,
  };
}

const recipientStaticView = (grant: string) =>
  call("POST", "/api/view/static-view", undefined, "", `Bearer ${grant}`);

const PAGE =
  '<!doctype html><html><head><title>Report</title></head><body><h1>Report</h1><a href="https://example.org/source?a=1&amp;b=2">Source</a> <a href="#notes">Notes</a> <a href="mailto:a@example.org">Mail</a></body></html>';

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`static-a-${suffix}`, password);
  const stranger = await createAccount(`static-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  strangerCookie = await login(stranger.name);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

/** The served page must equal the stored one with only external hrefs changed. */
function assertStaticBody(body: string, source: string) {
  const away = [...body.matchAll(/href="([^"#]+)\/away#([^"]+)"/g)];
  assert.equal(away.length, 1, body);
  assert.equal(away[0]![1], config.APP_ORIGIN);
  assert.equal(
    verifyAwayToken(away[0]![2])!.url,
    "https://example.org/source?a=1&b=2",
  );
  assert.equal(
    body.replace(away[0]![0], 'href="https://example.org/source?a=1&amp;b=2"'),
    withNewTabLinks(Buffer.from(source)).toString(),
  );
  assert.ok(!body.includes(VIEWER_GUARD));
  assert.doesNotMatch(body, /<script/i);
}

test("owner static view is served from the viewer with the static CSP, never from the app", async () => {
  const saved = await save(PAGE);
  assert.equal(saved.htmlProfile, "static");
  const issued = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/static-view`,
    {},
  );
  assert.equal(issued.statusCode, 200, issued.body);
  const { url, expiresAt } = issued.json();
  assert.equal(new URL(url).origin, config.VIEWER_ORIGIN);
  assert.match(pathOf(url), /^\/static\/[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt) <= Date.now() + 61_000);

  const document = await embedded(pathOf(url));
  assert.equal(document.statusCode, 200, document.body);
  assert.equal(
    document.headers["content-security-policy"],
    staticHtmlCsp(config.APP_ORIGIN),
  );
  const csp = document.headers["content-security-policy"] as string;
  assert.match(csp, /^sandbox allow-popups allow-popups-to-escape-sandbox;/);
  assert.doesNotMatch(
    csp,
    /allow-scripts|allow-same-origin|allow-top-navigation|script-src|frame-ancestors 'self'/,
  );
  assert.ok(csp.includes(`frame-ancestors ${config.APP_ORIGIN};`));
  assert.equal(document.headers["cache-control"], "no-store");
  assert.equal(document.headers["referrer-policy"], "no-referrer");
  assert.equal(document.headers["x-content-type-options"], "nosniff");
  assert.equal(document.headers["x-dns-prefetch-control"], "off");
  assert.equal(document.headers["set-cookie"], undefined);
  assertStaticBody(document.body, PAGE);

  // The app origin no longer serves the page.
  const fromApp = await call(
    "GET",
    `/api/revisions/${saved.revisionId}/document`,
  );
  assert.equal(fromApp.statusCode, 404);
  assert.doesNotMatch(fromApp.body, /Report/);
  // ... and frames only the viewer.
  assert.match(
    issued.headers["content-security-policy"] as string,
    new RegExp(`frame-src ${config.VIEWER_ORIGIN.replaceAll(".", "\\.")};`),
  );
  assert.doesNotMatch(
    issued.headers["content-security-policy"] as string,
    /frame-src 'self'/,
  );
});

test("owner static grants are tenant-, session- and kind-bound", async () => {
  const saved = await save(PAGE);
  const path = `/api/revisions/${saved.revisionId}/static-view`;
  assert.equal((await call("POST", path, {}, strangerCookie)).statusCode, 404);
  assert.equal((await call("POST", path, {}, "")).statusCode, 401);
  const text = await save("plain text", "text/plain");
  assert.equal(
    (await call("POST", `/api/revisions/${text.revisionId}/static-view`, {}))
      .statusCode,
    404,
  );
  const unsupported = await save(
    '<!doctype html><form action="https://e.example"><input type=password></form>',
  );
  assert.equal(unsupported.htmlProfile, "unsupported");
  assert.equal(
    (
      await call(
        "POST",
        `/api/revisions/${unsupported.revisionId}/static-view`,
        {},
      )
    ).statusCode,
    404,
  );

  // A static grant never opens the interactive route, and a live grant never
  // opens the static one.
  const staticUrl = (await call("POST", path, {})).json().url as string;
  const token = pathOf(staticUrl).split("/").at(-1)!;
  assert.equal((await embedded(`/document/${token}`)).statusCode, 404);
  const live = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/live-view`,
    {},
  );
  assert.equal(live.statusCode, 200, live.body);
  const liveToken = pathOf(live.json().url).split("/").at(-1)!;
  assert.equal((await embedded(`/static/${liveToken}`)).statusCode, 404);
  assert.equal((await embedded(`/document/${liveToken}`)).statusCode, 200);
  assert.equal(
    (await embedded(`/static/${randomBytes(32).toString("base64url")}`))
      .statusCode,
    404,
  );
  assert.equal((await embedded("/static/short")).statusCode, 404);

  // Logout ends the grant.
  assert.equal((await embedded(pathOf(staticUrl))).statusCode, 200);
  await call("POST", "/api/logout", {});
  assert.equal((await embedded(pathOf(staticUrl))).statusCode, 404);
  ownerCookie = await login(owner.name);

  // So do trash and expiry.
  const again = (await call("POST", path, {})).json().url as string;
  await db.query(
    "UPDATE viewer_grants SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE hash=$1",
    [sha256(`static-view:${pathOf(again).split("/").at(-1)}`)],
  );
  assert.equal((await embedded(pathOf(again))).statusCode, 404);
  const third = (await call("POST", path, {})).json().url as string;
  const artifact = (
    await call("GET", `/api/artifacts/${saved.artifactId}`)
  ).json();
  const trashed = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/trash`,
    {
      expectedLifecycleVersion: artifact.lifecycleVersion,
      expectedRevisionId: saved.revisionId,
    },
  );
  assert.equal(trashed.statusCode, 200, trashed.body);
  assert.equal((await embedded(pathOf(third))).statusCode, 404);
  assert.equal((await call("POST", path, {})).statusCode, 404);
});

test("static document refuses top-level, metadata-free and wrong-Host loads", async () => {
  const saved = await save(PAGE);
  const path = pathOf(
    (
      await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {})
    ).json().url,
  );
  const bare = await viewer.inject({
    url: path,
    headers: { host: config.VIEWER_UPSTREAM_HOST },
  });
  assert.equal(bare.statusCode, 404);
  assert.equal(
    (await embedded(path, { "sec-fetch-dest": "document" })).statusCode,
    404,
  );
  assert.equal(
    (await embedded(path, { "sec-fetch-mode": "cors" })).statusCode,
    404,
  );
  const wrongHost = await embedded(path, {
    host: "viewer.attacker.invalid",
    "x-forwarded-host": config.VIEWER_UPSTREAM_HOST,
  });
  assert.equal(wrongHost.statusCode, 404);
  assert.equal(wrongHost.headers.location, undefined);
  assert.equal((await embedded(path)).statusCode, 200);
});

test("recipient static view comes from the viewer and dies with its link", async () => {
  const saved = await save(PAGE);
  const link = await share(saved);
  // The app origin refuses the old static route outright.
  assert.equal(
    (await call("GET", `/api/view/${link.grant}/document`, undefined, ""))
      .statusCode,
    404,
  );
  const issued = await recipientStaticView(link.grant);
  assert.equal(issued.statusCode, 200, issued.body);
  assert.equal(new URL(issued.json().url).origin, config.VIEWER_ORIGIN);
  const document = await embedded(pathOf(issued.json().url));
  assert.equal(document.statusCode, 200, document.body);
  assert.equal(
    document.headers["content-security-policy"],
    staticHtmlCsp(config.APP_ORIGIN),
  );
  assertStaticBody(document.body, PAGE);

  // Bad and foreign grants.
  assert.equal((await recipientStaticView("nope")).statusCode, 404);
  assert.equal(
    (await recipientStaticView(randomBytes(32).toString("base64url")))
      .statusCode,
    404,
  );

  // The source grant's expiry ends the static grant.
  await db.query(
    "UPDATE grants SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [sha256(link.grant)],
  );
  assert.equal((await embedded(pathOf(issued.json().url))).statusCode, 404);
  assert.equal((await recipientStaticView(link.grant)).statusCode, 404);

  // Revoke ends it too.
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: new URL(link.share.url).hash.slice(1) },
    "",
  );
  const again = await recipientStaticView(resolved.json().grant);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await embedded(pathOf(again.json().url))).statusCode, 200);
  assert.equal(
    (await call("POST", `/api/shares/${link.share.id}/revoke`, {})).statusCode,
    200,
  );
  assert.equal((await embedded(pathOf(again.json().url))).statusCode, 404);
});

test("a link bound to an interactive version gets no static view", async () => {
  const saved = await save(
    '<!doctype html><h1>Counter</h1><p>A small scripted page with enough readable text to be shown statically before it runs.</p><button id=b>0</button><script>b.onclick=()=>b.textContent="1"</script>',
  );
  const built = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.equal(built.json().state, "ready", built.body);
  const link = await share(saved);
  assert.equal((await recipientStaticView(link.grant)).statusCode, 404);
  const live = await call(
    "POST",
    "/api/view/live-view",
    undefined,
    "",
    `Bearer ${link.grant}`,
  );
  assert.equal(live.statusCode, 200, live.body);
});
