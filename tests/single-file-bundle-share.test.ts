import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { STATIC_HTML_CSP, withNewTabLinks } from "../apps/server/html.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import {
  CAPTURE_EXAMPLE,
  captureFromAgent,
} from "../apps/server/agent-capture.ts";
import { revokeShareFromAgent, shareFromAgent } from "../apps/server/shares.ts";
import { exportRevision } from "../apps/server/artifacts.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

// The default suite runs with HTML_LIVE_MODE=disabled, like a static-only
// hosted installation: agent captures must still be linkable when static.
const app = await createApp();
const origin = config.APP_ORIGIN;
const remoteAddress = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
let agent: Awaited<ReturnType<typeof authenticateServiceToken>>;

const call = (method: any, url: string, body?: any, withCookie = true) =>
  app.inject({
    remoteAddress,
    method,
    url,
    headers: { origin, ...(withCookie && cookie ? { cookie } : {}) },
    payload: body,
  });

function singleFile(html: string, title: string) {
  return {
    key: randomUUID(),
    title,
    manifest: {
      ...CAPTURE_EXAMPLE.manifest,
      files: [
        {
          path: "report.html",
          mime: "text/html",
          size: Buffer.byteLength(html),
          sha256: createHash("sha256").update(html).digest("hex"),
        },
      ],
      entrypoint: "report.html",
    },
    files: [{ path: "report.html", encoding: "utf8", data: html }],
  };
}

const share = (artifactId: string, revisionId: string) =>
  shareFromAgent(agent, {
    key: randomUUID(),
    artifactId,
    expectedRevisionId: revisionId,
    expiresInDays: 1,
  });

async function resolve(url: string) {
  return call(
    "POST",
    "/api/resolve",
    { token: new URL(url).hash.slice(1) },
    false,
  );
}

before(async () => {
  assert.equal(config.HTML_LIVE_ENABLED, false);
  owner = await createAccount(
    "single-bundle-" + randomBytes(5).toString("hex"),
    password,
  );
  const login = await call(
    "POST",
    "/api/login",
    { name: owner.name, password },
    false,
  );
  assert.equal(login.statusCode, 200, login.body);
  cookie = login.cookies[0].name + "=" + login.cookies[0].value;
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'test',ARRAY['context','capture','revise','share'],$5,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(token), MCP_AUDIENCE],
  );
  agent = await authenticateServiceToken(token, MCP_AUDIENCE, "capture");
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("the guide's single-file capture is static, shareable and opens sandboxed until revoked", async () => {
  const receipt: any = await captureFromAgent(
    agent,
    { ...CAPTURE_EXAMPLE, key: randomUUID() },
    "capture",
  );
  assert.equal(receipt.storageKind, "bundle");
  assert.equal(receipt.htmlProfile, "static");
  const stored = (
    await db.query(
      "SELECT storage_kind,html_profile FROM revisions WHERE id=$1",
      [receipt.revisionId],
    )
  ).rows[0];
  assert.deepEqual(stored, { storage_kind: "bundle", html_profile: "static" });

  // The owner preview uses the same static sandbox as a single upload.
  const own = await call(
    "GET",
    `/api/revisions/${receipt.revisionId}/document`,
  );
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.headers["content-security-policy"], STATIC_HTML_CSP);
  assert.equal(
    own.body,
    withNewTabLinks(Buffer.from(CAPTURE_EXAMPLE.files[0].data)).toString(),
  );

  const shared = await share(receipt.artifactId, receipt.revisionId);
  assert.equal(shared.state, "active");
  assert.equal(shared.derivativeId, null);
  assert.ok(shared.url);

  const resolved = await resolve(shared.url!);
  assert.equal(resolved.statusCode, 200, resolved.body);
  const viewer = resolved.json();
  assert.equal(viewer.revision.storageKind, "bundle");
  assert.equal(viewer.revision.htmlProfile, "static");
  assert.equal(viewer.revision.inlineBuild, null);
  const document = await call(
    "GET",
    `/api/view/${viewer.grant}/document`,
    undefined,
    false,
  );
  assert.equal(document.statusCode, 200, document.body);
  assert.equal(document.headers["content-security-policy"], STATIC_HTML_CSP);
  assert.match(document.headers["content-security-policy"] as string, /^sandbox allow-popups allow-popups-to-escape-sandbox;/);
  assert.equal(document.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(
    document.body,
    withNewTabLinks(Buffer.from(CAPTURE_EXAMPLE.files[0].data)).toString(),
  );

  // Source export still reads the bundle's own file rows.
  const exported = await exportRevision(
    { id: owner.id, tenant: owner.tenant },
    receipt.revisionId,
  );
  assert.equal(exported.files.length, 1);
  assert.equal(
    Buffer.from(exported.files[0].data, "base64").toString("utf8"),
    CAPTURE_EXAMPLE.files[0].data,
  );

  const revoked = await revokeShareFromAgent(agent, {
    shareId: shared.shareId,
  });
  assert.ok(revoked);
  assert.equal((await resolve(shared.url!)).statusCode, 404);
  assert.equal(
    (await call("GET", `/api/view/${viewer.grant}/document`, undefined, false))
      .statusCode,
    404,
  );
});

test("single-file pages with scripts follow classifyHtml like web uploads", async () => {
  const text =
    "Quarterly figures are summarised in the table below for every region we track.";
  const limited: any = await captureFromAgent(
    agent,
    singleFile(
      `<!doctype html><html><body><h1>Report</h1><p>${text}</p><script>document.title='x'</script></body></html>`,
      "Limited",
    ),
    "capture",
  );
  assert.equal(limited.htmlProfile, "limited");
  const limitedShare = await share(limited.artifactId, limited.revisionId);
  const viewer = (await resolve(limitedShare.url!)).json();
  const document = await call(
    "GET",
    `/api/view/${viewer.grant}/document`,
    undefined,
    false,
  );
  assert.equal(document.statusCode, 200);
  // Scripts stay inert: the response itself forbids them.
  assert.equal(document.headers["content-security-policy"], STATIC_HTML_CSP);
  assert.doesNotMatch(STATIC_HTML_CSP, /allow-scripts|script-src/);

  const unsupported: any = await captureFromAgent(
    agent,
    singleFile(
      "<!doctype html><html><body><div id=app></div><script>app.textContent='runtime'</script></body></html>",
      "Runtime",
    ),
    "capture",
  );
  assert.equal(unsupported.htmlProfile, "unsupported");
  await assert.rejects(
    share(unsupported.artifactId, unsupported.revisionId),
    (e: any) =>
      e.status === 422 &&
      e.code === "unsupported" &&
      /скрипты, формы или внешние ресурсы/.test(e.message) &&
      /выключен/.test(e.message),
  );
  assert.equal(
    (await call("GET", `/api/revisions/${unsupported.revisionId}/document`))
      .statusCode,
    404,
  );
  const web = await call(
    "POST",
    `/api/artifacts/${unsupported.artifactId}/share`,
    { expectedRevisionId: unsupported.revisionId, expiresInDays: 1 },
  );
  assert.equal(web.statusCode, 422);
});

test("multi-file bundles still require a prepared derivative", async () => {
  const payload = {
    ...(await prepareCapture(
      "tests/fixtures/bundle-corpus/team-report",
      "index.html",
      [
        "index.html",
        "assets/report.css",
        "assets/report.js",
        "assets/mark.svg",
      ],
    )),
    key: randomUUID(),
    title: "Bundle",
  };
  const receipt: any = await captureFromAgent(agent, payload, "capture");
  assert.equal(receipt.htmlProfile, "unsupported");
  await assert.rejects(
    share(receipt.artifactId, receipt.revisionId),
    (e: any) =>
      e.status === 422 &&
      e.code === "unsupported" &&
      /нескольких файлов/.test(e.message),
  );
  assert.equal(
    (await call("GET", `/api/revisions/${receipt.revisionId}/document`))
      .statusCode,
    404,
  );
  // The schema refuses a static profile on any multi-file bundle.
  await assert.rejects(
    db.query("UPDATE revisions SET html_profile='static' WHERE id=$1", [
      receipt.revisionId,
    ]),
    (e: any) => e.constraint === "bundle_revision_shape",
  );
});

test("MCP serverInfo reports the package release", async () => {
  const { POLKA_VERSION } = await import("../apps/server/mcp-server.ts");
  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  assert.equal(POLKA_VERSION, pkg.version);
  assert.doesNotMatch(POLKA_VERSION, /dev/);
});
