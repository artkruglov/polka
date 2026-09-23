import { after, before, test } from "node:test";
import { withViewerGuard } from "../apps/server/html.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import {
  BUILD_FAILURE_MESSAGES,
  BUNDLE_BUILDER_VERSION,
} from "../apps/server/bundle-runtime-contract.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run live-viewer.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const embeddedDocument = (url: string) => viewer.inject({url,headers:{host:config.VIEWER_UPSTREAM_HOST,"sec-fetch-dest":"iframe","sec-fetch-mode":"navigate"}});
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let stranger: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let strangerCookie = "";

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
  const setCookie = String(response.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(setCookie, /Domain=/i);
  if (config.COOKIE_SECURE === "true") assert.match(setCookie, /Secure/i);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function save(
  source: string,
  mime = "text/html",
  patch: Record<string, unknown> = {},
) {
  const bytes = Buffer.from(source);
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Live viewer fixture",
    filename: mime === "text/html" ? "fixture.html" : "fixture.txt",
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
    ...patch,
  });
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  const upload = await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes);
  assert.equal(upload.statusCode, 200, upload.body);
  const finish = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finish.statusCode, 200, finish.body);
  return finish.json();
}

// A page with scripts: recipients run it only through its built version.
const scripted = (label: string) =>
  `<!doctype html><h1>${label}</h1><p>A scripted page with enough readable text to be shown statically before it runs.</p><script>document.title="${label}"</script>`;

async function buildReady(revisionId: string) {
  const built = await call("POST", `/api/revisions/${revisionId}/build-inline`, {});
  assert.equal(built.json().state, "ready", built.body);
}

const capabilityToken = (url: string) =>
  new URL(url).pathname.split("/").at(-1) as string;

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`live-a-${suffix}`, password);
  stranger = await createAccount(`live-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  strangerCookie = await login(stranger.name);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("live viewer configuration rejects hosted, same-host and same-port layouts", () => {
  const check = (environment: Record<string, string>, message: RegExp) => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "await import('./apps/server/config.ts')",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HTML_LIVE_ENABLED: "true",
          HTML_LIVE_MODE: undefined,
          MAIL_MODE: "disabled",
          ...environment,
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(child.status, 0, child.stdout);
    assert.match(child.stderr, message);
  };
  check(
    {
      APP_ORIGIN: "https://polka.example",
      COOKIE_SECURE: "true",
      HOST: "127.0.0.1",
      VIEWER_ORIGIN: "http://localhost:4391",
      VIEWER_HOST: "localhost",
      VIEWER_PORT: "4391",
    },
    /plain HTTP loopback/,
  );
  check(
    {
      APP_ORIGIN: "http://127.0.0.1:4390",
      HOST: "127.0.0.1",
      VIEWER_ORIGIN: "http://127.0.0.1:4391",
      VIEWER_HOST: "127.0.0.1",
      VIEWER_PORT: "4391",
    },
    /opposite loopback hostnames/,
  );
  check(
    {
      APP_ORIGIN: "http://127.0.0.1:4390",
      HOST: "127.0.0.1",
      PORT: "4390",
      VIEWER_ORIGIN: "http://localhost:4390",
      VIEWER_HOST: "localhost",
      VIEWER_PORT: "4390",
    },
    /different ports/,
  );
  for (const [environment, message] of [
    [{ VIEWER_ORIGIN: "https://viewer.polochka.app" }, /different registrable domains/],
    [{ VIEWER_ORIGIN: "http://polochka.page" }, /canonical HTTPS/],
    [{ COOKIE_SECURE: "false" }, /Insecure cookies|secure cookies/],
    [{ VIEWER_HOST: "0.0.0.0" }, /bind to loopback/],
  ] as const)
    check(
      {
        HTML_LIVE_ENABLED: undefined as unknown as string,
        HTML_LIVE_MODE: "production",
        APP_ORIGIN: "https://polochka.app",
        COOKIE_SECURE: "true",
        HOST: "127.0.0.1",
        PORT: "4390",
        VIEWER_ORIGIN: "https://polochka.page",
        VIEWER_HOST: "127.0.0.1",
        VIEWER_PORT: "4391",
        ...environment,
      },
      message,
    );
});

test("owner capabilities are tenant-scoped, HTML-only and run unsupported saved HTML", async () => {
  const interactive =
    "<!doctype html><html><body><button id=b>Run</button><script>b.onclick=()=>b.textContent='Done'</script></body></html>";
  const html = await save(interactive);
  assert.equal(html.htmlProfile, "unsupported");
  const nonHtml = await save("plain text", "text/plain");

  assert.equal(
    (
      await call(
        "POST",
        `/api/revisions/${html.revisionId}/live-view`,
        {},
        strangerCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("POST", `/api/revisions/${html.revisionId}/live-view`, {}, ""))
      .statusCode,
    401,
  );
  assert.equal(
    (await call("POST", `/api/revisions/${nonHtml.revisionId}/live-view`, {}))
      .statusCode,
    404,
  );

  const issued = await call(
    "POST",
    `/api/revisions/${html.revisionId}/live-view`,
    {},
  );
  assert.equal(issued.statusCode, 200, issued.body);
  assert.equal(issued.json().profile, "inline-live-experimental-v1");
  assert.equal(new URL(issued.json().url).origin, config.VIEWER_ORIGIN);
  // The deadline comes from the database clock, so allow a second of skew
  // against ours; the point is that the grant is short-lived, not exact.
  assert.ok(Date.parse(issued.json().expiresAt) <= Date.now() + 61_000);

  const document = await embeddedDocument(
    `/document/${capabilityToken(issued.json().url)}`,
  );
  assert.equal(document.statusCode, 200, document.body);
  // Byte-exact page, with the viewer's WebRTC guard first.
  assert.equal(document.body, withViewerGuard(Buffer.from(interactive)).toString());
  assert.match(
    document.headers["content-security-policy"] as string,
    /^sandbox allow-scripts allow-forms;/,
  );
  for (const directive of [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${config.APP_ORIGIN}`,
  ])
    assert.ok(
      (document.headers["content-security-policy"] as string).includes(
        directive,
      ),
      directive,
    );
  assert.equal(document.headers["cache-control"], "no-store");
  assert.equal(document.headers["referrer-policy"], "no-referrer");
  assert.equal(document.headers["x-content-type-options"], "nosniff");
  assert.match(document.headers["x-robots-tag"] as string, /noindex/);
  assert.equal(document.headers["set-cookie"], undefined);
  assert.equal(document.headers["access-control-allow-origin"], undefined);
  assert.equal((await embeddedDocument("/api/health")).statusCode, 404);
  const random = await embeddedDocument(
    `/document/${randomBytes(32).toString("base64url")}`,
  );
  assert.equal(random.statusCode, 404);
  assert.equal(random.headers["cache-control"], "no-store");
});

test("owner capability is revoked by logout, account disable and expiry", async () => {
  const html = await save("<!doctype html><p>owner auth</p>");
  let issued = (
    await call("POST", `/api/revisions/${html.revisionId}/live-view`, {})
  ).json();
  let token = capabilityToken(issued.url);
  assert.equal((await embeddedDocument(`/document/${token}`)).statusCode, 200);
  await call("POST", "/api/logout", {}, ownerCookie);
  assert.equal((await embeddedDocument(`/document/${token}`)).statusCode, 404);

  ownerCookie = await login(owner.name);
  issued = (
    await call("POST", `/api/revisions/${html.revisionId}/live-view`, {})
  ).json();
  token = capabilityToken(issued.url);
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  try {
    assert.equal((await embeddedDocument(`/document/${token}`)).statusCode, 404);
  } finally {
    await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [
      owner.id,
    ]);
  }

  ownerCookie = await login(owner.name);
  issued = (
    await call("POST", `/api/revisions/${html.revisionId}/live-view`, {})
  ).json();
  token = capabilityToken(issued.url);
  await db.query(
    "UPDATE viewer_grants SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE hash=$1",
    [sha256(token)],
  );
  assert.equal((await embeddedDocument(`/document/${token}`)).statusCode, 404);
});

test("recipient capability stays pinned and cannot outlive, revoke or lose its source grant", async () => {
  const first = await save(scripted("version one"));
  await buildReady(first.revisionId);
  const enabled = await call(
    "POST",
    `/api/artifacts/${first.artifactId}/share`,
    { expectedRevisionId: first.revisionId, expiresInDays: 1 },
  );
  assert.equal(enabled.statusCode, 200, enabled.body);
  const share = enabled.json().share;
  const shareToken = new URL(share.url).hash.slice(1);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: shareToken },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  const sourceGrant = resolved.json();
  const issued = await call(
    "POST",
    "/api/view/live-view",
    {},
    "",
    `Bearer ${sourceGrant.grant}`,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  assert.ok(
    Date.parse(issued.json().expiresAt) <= Date.parse(sourceGrant.expiresAt),
  );
  const token = capabilityToken(issued.json().url);

  const second = await save(scripted("version two"), "text/html", {
    artifactId: first.artifactId,
    baseRevisionId: first.revisionId,
  });
  await buildReady(second.revisionId);
  assert.equal(
    (
      await call("POST", `/api/shares/${share.id}/publish`, {
        revisionId: second.revisionId,
        expectedPublishedRevisionId: first.revisionId,
      })
    ).statusCode,
    200,
  );
  assert.match((await embeddedDocument(`/document/${token}`)).body, /version one/);

  await db.query(
    "UPDATE grants SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [sha256(sourceGrant.grant)],
  );
  assert.equal((await embeddedDocument(`/document/${token}`)).statusCode, 404);

  const resolvedAgain = await call(
    "POST",
    "/api/resolve",
    { token: shareToken },
    "",
  );
  const issuedAgain = await call(
    "POST",
    "/api/view/live-view",
    {},
    "",
    `Bearer ${resolvedAgain.json().grant}`,
  );
  const tokenAgain = capabilityToken(issuedAgain.json().url);
  await call("POST", `/api/shares/${share.id}/revoke`, {});
  assert.equal(
    (await embeddedDocument(`/document/${tokenAgain}`)).statusCode,
    404,
  );

  const { rowCount } = await db.query("DELETE FROM grants WHERE hash=$1", [
    sha256(resolvedAgain.json().grant),
  ]);
  assert.equal(rowCount, 1);
  assert.equal(
    +(
      await db.query("SELECT count(*) FROM viewer_grants WHERE hash=$1", [
        sha256(tokenAgain),
      ])
    ).rows[0].count,
    0,
  );
});

test("app capabilities and frame policy expose only the enabled experiment mode", async () => {
  const capabilities = await call("GET", "/api/capabilities");
  assert.equal(capabilities.json().htmlRuntime, false);
  assert.equal(capabilities.json().liveExperimental, true);
  assert.equal(capabilities.json().liveMode, config.HTML_LIVE_MODE);
  assert.equal(capabilities.json().liveProfile, "inline-live-experimental-v1");
  assert.match(
    capabilities.headers["content-security-policy"] as string,
    new RegExp(
      `frame-src 'self' ${config.VIEWER_ORIGIN.replaceAll(".", "\\.")}`,
    ),
  );
});


test("live document refuses top-level and metadata-free loads with a valid capability", async () => {
  const saved = await save("<!doctype html><h1>Embedding only</h1>");
  const issued = await call("POST", `/api/revisions/${saved.revisionId}/live-view`, {});
  assert.equal(issued.statusCode, 200);
  const path = new URL(issued.json().url).pathname;
  assert.equal((await viewer.inject({url:path,headers:{host:config.VIEWER_UPSTREAM_HOST}})).statusCode, 404);
  assert.equal((await viewer.inject({url:path,headers:{host:config.VIEWER_UPSTREAM_HOST,"sec-fetch-dest":"document","sec-fetch-mode":"navigate"}})).statusCode, 404);
  assert.equal((await viewer.inject({url:path,headers:{host:config.VIEWER_UPSTREAM_HOST,"sec-fetch-dest":"iframe","sec-fetch-mode":"cors"}})).statusCode, 404);
  assert.equal((await embeddedDocument(path)).statusCode, 200);
});

test("live document rejects unknown Host before resolving a valid capability", async () => {
  const saved = await save("<!doctype html><h1>Host gate</h1>");
  const issued = await call("POST", `/api/revisions/${saved.revisionId}/live-view`, {});
  assert.equal(issued.statusCode, 200, issued.body);
  const path = new URL(issued.json().url).pathname;
  const rejected = await viewer.inject({
    url: path,
    headers: {
      host: "viewer.attacker.invalid",
      "x-forwarded-host": config.VIEWER_UPSTREAM_HOST,
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
    },
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(rejected.headers.location, undefined);
  assert.equal(rejected.headers["cache-control"], "no-store");
  assert.equal((await embeddedDocument(path)).statusCode, 200);
});

test("staging allowlist gates owner and recipient issuance and every read", async () => {
  const allowed = await save("<!doctype html><p>Allowed staging revision</p>");
  const excluded = await save("<!doctype html><p>Excluded staging revision</p>");
  const oldCapability = await call(
    "POST",
    `/api/revisions/${excluded.revisionId}/live-view`,
    {},
  );
  assert.equal(oldCapability.statusCode, 200, oldCapability.body);
  const shared = await call("POST", `/api/artifacts/${excluded.artifactId}/share`, {
    expectedRevisionId: excluded.revisionId,
    expiresInDays: 1,
  });
  assert.equal(shared.statusCode, 200, shared.body);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: new URL(shared.json().share.url).hash.slice(1) },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);

  const mutable = config as any;
  const priorMode = mutable.HTML_LIVE_MODE;
  const priorAllowlist = mutable.HTML_LIVE_STAGING_REVISION_IDS;
  mutable.HTML_LIVE_MODE = "staging";
  mutable.HTML_LIVE_STAGING_REVISION_IDS = Object.freeze([allowed.revisionId]);
  try {
    const issued = await call(
      "POST",
      `/api/revisions/${allowed.revisionId}/live-view`,
      {},
    );
    assert.equal(issued.statusCode, 200, issued.body);
    assert.equal(
      (
        await call(
          "POST",
          `/api/revisions/${excluded.revisionId}/live-view`,
          {},
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/api/view/live-view",
          {},
          "",
          `Bearer ${resolved.json().grant}`,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await embeddedDocument(
          new URL(oldCapability.json().url).pathname,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await embeddedDocument(new URL(issued.json().url).pathname)).statusCode,
      200,
    );
  } finally {
    mutable.HTML_LIVE_MODE = priorMode;
    mutable.HTML_LIVE_STAGING_REVISION_IDS = priorAllowlist;
  }
});

test("production mode serves every eligible revision and reports itself honestly", async () => {
  const first = await save("<!doctype html><p>Production revision one</p>");
  const second = await save(scripted("Production revision two"));
  await buildReady(second.revisionId);
  const shared = await call("POST", `/api/artifacts/${second.artifactId}/share`, {
    expectedRevisionId: second.revisionId,
    expiresInDays: 1,
  });
  assert.equal(shared.statusCode, 200, shared.body);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: new URL(shared.json().share.url).hash.slice(1) },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);

  const mutable = config as any;
  const prior = {
    mode: mutable.HTML_LIVE_MODE,
    allowlist: mutable.HTML_LIVE_STAGING_REVISION_IDS,
  };
  mutable.HTML_LIVE_MODE = "production";
  mutable.HTML_LIVE_STAGING_REVISION_IDS = Object.freeze([]);
  try {
    const capabilities = await call("GET", "/api/capabilities");
    assert.equal(capabilities.json().liveMode, "production");
    assert.equal(capabilities.json().liveExperimental, true);
    assert.equal(capabilities.json().htmlRuntime, false);

    const urls = [];
    for (const saved of [first, second]) {
      const issued = await call(
        "POST",
        `/api/revisions/${saved.revisionId}/live-view`,
        {},
      );
      assert.equal(issued.statusCode, 200, issued.body);
      urls.push(new URL(issued.json().url).pathname);
    }
    const recipient = await call(
      "POST",
      "/api/view/live-view",
      {},
      "",
      `Bearer ${resolved.json().grant}`,
    );
    assert.equal(recipient.statusCode, 200, recipient.body);
    urls.push(new URL(recipient.json().url).pathname);
    for (const path of urls) {
      const document = await embeddedDocument(path);
      assert.equal(document.statusCode, 200);
      assert.equal(document.headers["set-cookie"], undefined);
      assert.equal(document.headers["cache-control"], "no-store");
    }
    assert.equal(
      (
        await call(
          "POST",
          `/api/revisions/${first.revisionId}/live-view`,
          {},
          strangerCookie,
        )
      ).statusCode,
      404,
    );

    // Rollback to disabled refuses reads of capabilities issued in production.
    mutable.HTML_LIVE_ENABLED = false;
    try {
      for (const path of urls)
        assert.equal((await embeddedDocument(path)).statusCode, 404);
    } finally {
      mutable.HTML_LIVE_ENABLED = true;
    }
  } finally {
    mutable.HTML_LIVE_MODE = prior.mode;
    mutable.HTML_LIVE_STAGING_REVISION_IDS = prior.allowlist;
  }
});

test("bundle storage cannot use single-file live capabilities, including an existing grant", async () => {
  const saved = await save("<!doctype html><h1>Bundle gate fixture</h1>");
  const shareResponse = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId, expiresInDays: 1,
  });
  assert.equal(shareResponse.statusCode, 200, shareResponse.body);
  const resolved = await call("POST", "/api/resolve", {
    token: new URL(shareResponse.json().share.url).hash.slice(1),
  }, "");
  assert.equal(resolved.statusCode, 200, resolved.body);
  const ownerLaunch = await call("POST", `/api/revisions/${saved.revisionId}/live-view`, {});
  const recipientLaunch = await call("POST", "/api/view/live-view", {}, "", `Bearer ${resolved.json().grant}`);
  assert.equal(ownerLaunch.statusCode, 200, ownerLaunch.body);
  // A recipient never runs a single upload directly, only a built version.
  assert.equal(recipientLaunch.statusCode, 404, recipientLaunch.body);
  // Synthetic inconsistent metadata tests the final read gate independently of
  // issuance/share checks. Real revisions never change storage kind.
  await db.query("UPDATE revisions SET storage_kind='bundle',html_profile='unsupported' WHERE id=$1", [saved.revisionId]);
  try {
    assert.equal((await call("POST", `/api/revisions/${saved.revisionId}/live-view`, {})).statusCode, 404);
    assert.equal((await call("POST", "/api/view/live-view", {}, "", `Bearer ${resolved.json().grant}`)).statusCode, 404);
    for (const launched of [ownerLaunch]) {
      const path = `/document/${capabilityToken(launched.json().url)}`;
      assert.equal((await embeddedDocument(path)).statusCode, 404);
    }
  } finally {
    await db.query("UPDATE revisions SET storage_kind='single',html_profile='static' WHERE id=$1", [saved.revisionId]);
  }
});

test("a build the builder gave up on is not rebuilt in a loop", async () => {
  const saved = await save(scripted("Build cooldown"));
  // Stand in for a builder timeout that happened just now.
  const {
    rows: [failed],
  } = await db.query(
    `INSERT INTO revision_derivatives(
       id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,attempt_id,reason
     )
     SELECT $1,r.tenant_id,r.id,r.manifest_sha256,$2,'failed',$3,$4
     FROM revisions r WHERE r.id=$5
     RETURNING id`,
    [randomUUID(), BUNDLE_BUILDER_VERSION, randomUUID(), BUILD_FAILURE_MESSAGES.timeout, saved.revisionId],
  );
  const retried = await call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {});
  assert.equal(retried.json().state, "failed", retried.body);
  // After the cooldown the same source is built again.
  await db.query(
    "UPDATE revision_derivatives SET updated_at=now()-interval '31 seconds' WHERE id=$1",
    [failed.id],
  );
  await buildReady(saved.revisionId);
});
