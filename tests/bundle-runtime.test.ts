import { after, before, test } from "node:test";
import { VIEWER_GUARD } from "../apps/server/html.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { buildInlineBundle } from "../apps/server/bundle-inline.ts";
import {
  BUNDLE_BUILDER_VERSION,
  BUNDLE_RUNTIME_PROFILE,
  DERIVATIVE_RESERVATION_BYTES,
  REACT_RUNTIME_PROFILE,
} from "../apps/server/bundle-runtime-contract.ts";
import { componentShell } from "../packages/contracts/runtime.ts";
import { builderEnv } from "../apps/server/bundle-derivatives.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { putImmutable, readBlob, s3, sha256 } from "../apps/server/storage.ts";
import {
  canonicalizeManifest,
  type BundleManifest,
} from "../packages/contracts/bundle.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run bundle-runtime.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let otherCookie = "";

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
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
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

const fixtureRoot = new URL(
  "fixtures/bundle-corpus/team-report/",
  import.meta.url,
);
const fixtureMimes: Record<string, string> = {
  "index.html": "text/html",
  "assets/mark.svg": "image/svg+xml",
  "assets/report.css": "text/css",
  "assets/report.js": "text/javascript",
};
let originalFiles: Map<string, Buffer>;

function makeManifest(files: Map<string, Buffer>): BundleManifest {
  return canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "preserved-only-v1",
    files: [...files].map(([path, bytes]) => ({
      path,
      mime: fixtureMimes[path] ?? "text/javascript",
      size: bytes.length,
      sha256: sha256(bytes),
    })),
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: "2026-09-20T12:00:00Z",
      attribution: "Оригинальный тестовый пакет Полки",
      license: "unknown",
    },
    dependencies: { status: "self-contained", unresolved: [] },
  });
}

async function saveBundle(
  files = originalFiles,
  patch: Record<string, unknown> = {},
) {
  const manifest = makeManifest(files);
  const start = await call("POST", "/api/bundle-uploads", {
    key: randomUUID(),
    title: "Runtime bundle",
    manifest,
    ...patch,
  });
  assert.equal(start.statusCode, 200, start.body);
  for (const [index, file] of manifest.files.entries()) {
    const upload = await call(
      "PUT",
      `/api/bundle-uploads/${start.json().uploadId}/files/${index}`,
      files.get(file.path)!,
    );
    assert.equal(upload.statusCode, 200, upload.body);
  }
  const finish = await call(
    "POST",
    `/api/bundle-uploads/${start.json().uploadId}/finalize`,
    {},
  );
  assert.equal(finish.statusCode, 200, finish.body);
  return { ...finish.json(), manifest, files };
}

const tokenFrom = (url: string) => new URL(url).pathname.split("/").at(-1)!;
const embedded = (token: string, route = "document") =>
  viewer.inject({
    method: "GET",
    url: `/${route}/${token}`,
    headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
  });
/** The recipient's static view: with a viewer it is served there, not by the app. */
const staticDocument = async (grant: string) => {
  const issued = await call("POST", "/api/view/static-view", undefined, "", grant);
  if (issued.statusCode !== 200) return issued;
  return embedded(tokenFrom(issued.json().url), "static");
};

before(async () => {
  originalFiles = new Map(
    await Promise.all(
      Object.keys(fixtureMimes).map(
        async (path) =>
          [path, await readFile(new URL(path, fixtureRoot))] as const,
      ),
    ),
  );
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`runtime-a-${suffix}`, password);
  other = await createAccount(`runtime-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  otherCookie = await login(other.name);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("ready derivative is tenant-private, charged once, exported unchanged, and pinned through grants", async () => {
  const saved = await saveBundle();
  const exportBefore = await call(
    "GET",
    `/api/revisions/${saved.revisionId}/export`,
  );
  const usedBefore = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        owner.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );
  const builds = await Promise.all([
    call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {}),
    call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {}),
  ]);
  assert.ok(
    builds.every((response) => [200, 202].includes(response.statusCode)),
  );
  const status = await call(
    "GET",
    `/api/revisions/${saved.revisionId}/build-inline`,
  );
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().state, "ready");
  assert.equal(status.json().runtimeProfile, BUNDLE_RUNTIME_PROFILE);
  assert.equal(
    (
      await call(
        "GET",
        `/api/revisions/${saved.revisionId}/build-inline`,
        undefined,
        otherCookie,
      )
    ).statusCode,
    404,
  );
  const derivative = (
    await db.query("SELECT * FROM revision_derivatives WHERE revision_id=$1", [
      saved.revisionId,
    ])
  ).rows[0];
  assert.equal(derivative.state, "ready");
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT derivative_used_bytes FROM tenants WHERE id=$1",
          [owner.tenant],
        )
      ).rows[0].derivative_used_bytes,
    ),
    usedBefore + derivative.size,
  );
  const exportAfter = await call(
    "GET",
    `/api/revisions/${saved.revisionId}/export`,
  );
  assert.deepEqual(exportAfter.json(), exportBefore.json());
  const artifact = await call("GET", `/api/artifacts/${saved.artifactId}`);
  assert.equal(artifact.json().revision.inlineBuild.state, "ready");
  assert.equal(
    artifact.json().revision.inlineBuild.runtimeProfile,
    BUNDLE_RUNTIME_PROFILE,
  );

  const shared = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/share`,
    {
      expectedRevisionId: saved.revisionId,
      expiresInDays: 1,
    },
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const share = shared.json().share;
  const shareToken = new URL(share.url).hash.slice(1);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: shareToken },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().revision.inlineBuild.state, "ready");
  const grant = resolved.json().grant;
  const recipientLive = await call(
    "POST",
    "/api/view/live-view",
    {},
    "",
    grant,
  );
  assert.equal(recipientLive.statusCode, 200, recipientLive.body);
  assert.equal(recipientLive.json().profile, BUNDLE_RUNTIME_PROFILE);
  const oldDocument = await embedded(tokenFrom(recipientLive.json().url));
  assert.equal(oldDocument.statusCode, 200, oldDocument.body);
  // The stored derivative, byte for byte, with the viewer's guard added once.
  assert.equal(oldDocument.body.split(VIEWER_GUARD).length, 2);
  assert.equal(sha256(Buffer.from(oldDocument.body.replace(VIEWER_GUARD, ""))), derivative.sha256);
  await db.query(
    `UPDATE viewer_grants
     SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second'
     WHERE hash=$1`,
    [sha256(tokenFrom(recipientLive.json().url))],
  );
  assert.equal(
    (await embedded(tokenFrom(recipientLive.json().url))).statusCode,
    404,
  );
  const ownerLive = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/live-view`,
    {},
  );
  assert.equal(ownerLive.statusCode, 200, ownerLive.body);
  assert.equal(ownerLive.json().profile, BUNDLE_RUNTIME_PROFILE);
  assert.equal(
    (await embedded(tokenFrom(ownerLive.json().url))).statusCode,
    200,
  );

  const changedFiles = new Map(originalFiles);
  changedFiles.set(
    "assets/report.js",
    Buffer.from(
      `${originalFiles.get("assets/report.js")!.toString()}\nwindow.__v2=true;`,
    ),
  );
  const v2 = await saveBundle(changedFiles, {
    artifactId: saved.artifactId,
    baseRevisionId: saved.revisionId,
  });
  assert.equal(
    (await call("POST", `/api/revisions/${v2.revisionId}/build-inline`, {}))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call("POST", `/api/shares/${share.id}/publish`, {
        revisionId: v2.revisionId,
        expectedPublishedRevisionId: saved.revisionId,
      })
    ).statusCode,
    200,
  );
  await assert.rejects(
    db.query("UPDATE shares SET derivative_id=$2 WHERE id=$1", [
      share.id,
      derivative.id,
    ]),
    (error: any) => error.code === "23503",
  );
  const oldGrantLive = await call("POST", "/api/view/live-view", {}, "", grant);
  assert.equal(oldGrantLive.statusCode, 200, oldGrantLive.body);
  const stillOld = await embedded(tokenFrom(oldGrantLive.json().url));
  // The stored derivative, byte for byte, with the viewer's guard added once.
  assert.equal(stillOld.body.split(VIEWER_GUARD).length, 2);
  assert.equal(sha256(Buffer.from(stillOld.body.replace(VIEWER_GUARD, ""))), derivative.sha256);

  const disabled = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const {createApp}=await import('./apps/server/app.ts');const {config}=await import('./apps/server/config.ts');const {db}=await import('./apps/server/db.ts');const {s3}=await import('./apps/server/storage.ts');const app=await createApp();const resolve=await app.inject({method:'POST',url:'/api/resolve',headers:{origin:config.APP_ORIGIN},payload:{token:process.env.TEST_SHARE_TOKEN}});const artifact=await app.inject({method:'GET',url:'/api/artifacts/'+process.env.TEST_ARTIFACT_ID,headers:{origin:config.APP_ORIGIN,cookie:process.env.TEST_OWNER_COOKIE}});process.stdout.write(JSON.stringify({resolve:resolve.statusCode,inline:artifact.json().revision.inlineBuild}));await app.close();await db.end();s3.destroy();`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Explicit mode so the rollback also holds for staging/production runs.
        HTML_LIVE_MODE: "disabled",
        HTML_LIVE_ENABLED: undefined,
        TEST_SHARE_TOKEN: shareToken,
        TEST_ARTIFACT_ID: saved.artifactId,
        TEST_OWNER_COOKIE: ownerCookie,
      },
      encoding: "utf8",
    },
  );
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout), { resolve: 404, inline: null });

  assert.equal(
    (await call("POST", `/api/shares/${share.id}/revoke`, {})).statusCode,
    200,
  );
  assert.equal(
    (await embedded(tokenFrom(oldGrantLive.json().url))).statusCode,
    404,
  );
});

test("unsupported builds are durable and derivative quota plus pending-two admission are separate", async () => {
  const unsupportedFiles = new Map<string, Buffer>([
    [
      "index.html",
      Buffer.from(
        '<!doctype html><html><body><script type=module>import "left-pad"</script></body></html>',
      ),
    ],
  ]);
  const unsupported = await saveBundle(unsupportedFiles);
  const built = await call(
    "POST",
    `/api/revisions/${unsupported.revisionId}/build-inline`,
    {},
  );
  assert.equal(built.statusCode, 200, built.body);
  assert.equal(built.json().state, "unsupported");
  assert.ok(built.json().reason);
  assert.equal(
    (
      await call("POST", `/api/artifacts/${unsupported.artifactId}/share`, {
        expectedRevisionId: unsupported.revisionId,
        expiresInDays: 1,
      })
    ).statusCode,
    422,
  );

  const quotaRevision = await saveBundle();
  const tenant = (
    await db.query(
      "SELECT derivative_used_bytes,derivative_quota_bytes FROM tenants WHERE id=$1",
      [owner.tenant],
    )
  ).rows[0];
  await db.query("UPDATE tenants SET derivative_quota_bytes=$2 WHERE id=$1", [
    owner.tenant,
    Number(tenant.derivative_used_bytes) + DERIVATIVE_RESERVATION_BYTES - 1,
  ]);
  assert.equal(
    (
      await call(
        "POST",
        `/api/revisions/${quotaRevision.revisionId}/build-inline`,
        {},
      )
    ).statusCode,
    413,
  );
  await db.query("UPDATE tenants SET derivative_quota_bytes=$2 WHERE id=$1", [
    owner.tenant,
    tenant.derivative_quota_bytes,
  ]);

  const pendingRevisions = await Promise.all([
    saveBundle(),
    saveBundle(),
    saveBundle(),
  ]);
  const pendingIds: string[] = [];
  for (const revision of pendingRevisions.slice(0, 2)) {
    const id = randomUUID();
    pendingIds.push(id);
    await db.query(
      `INSERT INTO revision_derivatives(
         id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,attempt_id,attempt_expires_at
       ) VALUES($1,$2,$3,$4,$5,'pending',$6,now()+interval '5 minutes')`,
      [
        id,
        owner.tenant,
        revision.revisionId,
        revision.manifestSha256,
        BUNDLE_BUILDER_VERSION,
        randomUUID(),
      ],
    );
  }
  assert.equal(
    (
      await call(
        "POST",
        `/api/revisions/${pendingRevisions[2].revisionId}/build-inline`,
        {},
      )
    ).statusCode,
    413,
  );
  await db.query(
    `UPDATE revision_derivatives
     SET state='failed',attempt_expires_at=NULL,reason='test cleanup'
     WHERE id=ANY($1::uuid[])`,
    [pendingIds],
  );
});

test("a stored attempt resumes immutably and expired cleanup deletes its exact orphan", async () => {
  const saved = await saveBundle();
  const built = buildInlineBundle(saved.manifest, saved.files);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const derivativeId = randomUUID();
  const attemptId = randomUUID();
  await db.query(
    `INSERT INTO revision_derivatives(
       id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,attempt_id,attempt_expires_at
     ) VALUES($1,$2,$3,$4,$5,'pending',$6,now()+interval '5 minutes')`,
    [
      derivativeId,
      owner.tenant,
      saved.revisionId,
      saved.manifestSha256,
      BUNDLE_BUILDER_VERSION,
      attemptId,
    ],
  );
  const key = `${owner.tenant}/derivatives/${derivativeId}/${attemptId}.html`;
  const originalVersion = await putImmutable(key, built.html);
  const response = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().state, "ready");
  const ready = (
    await db.query("SELECT * FROM revision_derivatives WHERE id=$1", [
      derivativeId,
    ])
  ).rows[0];
  assert.equal(ready.object_version, originalVersion);
  assert.equal((await readBlob(key, originalVersion)).equals(built.html), true);

  const orphanRevision = await saveBundle();
  const orphanId = randomUUID();
  const orphanAttempt = randomUUID();
  const orphanKey = `${owner.tenant}/derivatives/${orphanId}/${orphanAttempt}.html`;
  const orphanVersion = await putImmutable(orphanKey, Buffer.from("orphan"));
  await db.query(
    `INSERT INTO revision_derivatives(
       id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,attempt_id,attempt_expires_at
     ) VALUES($1,$2,$3,$4,$5,'pending',$6,now()-interval '1 second')`,
    [
      orphanId,
      owner.tenant,
      orphanRevision.revisionId,
      orphanRevision.manifestSha256,
      BUNDLE_BUILDER_VERSION,
      orphanAttempt,
    ],
  );
  const cleanup = spawnSync(
    process.execPath,
    ["--import", "tsx", "--env-file=.env", "scripts/maintenance.ts"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(readBlob(orphanKey, orphanVersion));
  const failed = (
    await db.query(
      "SELECT state,attempt_expires_at FROM revision_derivatives WHERE id=$1",
      [orphanId],
    )
  ).rows[0];
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempt_expires_at, null);
});

test("a static single-file bundle links statically until a ready derivative exists", async () => {
  const page = Buffer.from(
    "<!doctype html><html><body><h1>Lone page</h1><p>Static text.</p></body></html>",
  );
  const saved = await saveBundle(new Map([["index.html", page]]));
  assert.equal(saved.htmlProfile, "static");
  const shareOnce = async () => {
    const response = await call(
      "POST",
      `/api/artifacts/${saved.artifactId}/share`,
      { expectedRevisionId: saved.revisionId, expiresInDays: 1 },
    );
    assert.equal(response.statusCode, 200, response.body);
    const share = response.json().share;
    const resolved = await call(
      "POST",
      "/api/resolve",
      { token: new URL(share.url).hash.slice(1) },
      "",
    );
    assert.equal(resolved.statusCode, 200, resolved.body);
    const row = (
      await db.query("SELECT derivative_id FROM shares WHERE id=$1", [share.id])
    ).rows[0];
    return { share, grant: resolved.json().grant, derivativeId: row.derivative_id };
  };

  // No derivative yet: the static sandbox serves the page, as with live off.
  const before = await shareOnce();
  assert.equal(before.derivativeId, null);
  assert.equal(
    (await call("GET", `/api/view/${before.grant}/document`, undefined, ""))
      .statusCode,
    404,
  );
  const document = await staticDocument(before.grant);
  assert.equal(document.statusCode, 200, document.body);
  assert.match(document.headers["content-security-policy"] as string, /^sandbox allow-popups allow-popups-to-escape-sandbox;/);
  // The static view (not the download) opens links in a new tab.
  assert.equal(document.body, `<base target="_blank">${page}`);
  assert.equal(
    (await call("POST", `/api/shares/${before.share.id}/revoke`, {})).statusCode,
    200,
  );

  // A ready derivative keeps the existing live-mode binding.
  const build = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.ok([200, 202].includes(build.statusCode), build.body);
  assert.equal(
    (await call("GET", `/api/revisions/${saved.revisionId}/build-inline`)).json()
      .state,
    "ready",
  );
  const after = await shareOnce();
  const derivative = (
    await db.query(
      "SELECT id FROM revision_derivatives WHERE revision_id=$1 AND state='ready'",
      [saved.revisionId],
    )
  ).rows[0];
  assert.equal(after.derivativeId, derivative.id);
  const live = await call(
    "POST",
    "/api/view/live-view",
    undefined,
    "",
    after.grant,
  );
  assert.equal(live.statusCode, 200, live.body);
  assert.equal(live.json().profile, BUNDLE_RUNTIME_PROFILE);
});

async function shareAndOpen(artifactId: string, revisionId: string) {
  const shared = await call("POST", `/api/artifacts/${artifactId}/share`, {
    expectedRevisionId: revisionId,
    expiresInDays: 1,
  });
  assert.equal(shared.statusCode, 200, shared.body);
  const share = shared.json().share;
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: new URL(share.url).hash.slice(1) },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  const live = await call(
    "POST",
    "/api/view/live-view",
    undefined,
    "",
    resolved.json().grant,
  );
  assert.equal(live.statusCode, 200, live.body);
  const derivativeId = (
    await db.query("SELECT derivative_id FROM shares WHERE id=$1", [share.id])
  ).rows[0].derivative_id;
  return { share, viewer: resolved.json(), live: live.json(), derivativeId };
}

test("a ready bundle-inline-v3 derivative keeps serving and is not rebuilt", async () => {
  assert.equal(BUNDLE_BUILDER_VERSION, "bundle-inline-v6");
  const saved = await saveBundle();
  // Stand in for a derivative built before v4 shipped (ready rows are
  // immutable, so it is stored as the v3 builder would have left it).
  const output = buildInlineBundle(saved.manifest, saved.files);
  assert.ok(output.ok);
  const id = randomUUID();
  const objectKey = `${owner.tenant}/derivatives/${id}/v3.html`;
  const objectVersion = await putImmutable(objectKey, output.html);
  await db.query(
    `INSERT INTO revision_derivatives(
       id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,
       attempt_id,runtime_profile,size,sha256,object_key,object_version
     ) VALUES($1,$2,$3,$4,'bundle-inline-v3','ready',$5,$6,$7,$8,$9,$10)`,
    [
      id,
      owner.tenant,
      saved.revisionId,
      saved.manifestSha256,
      randomUUID(),
      BUNDLE_RUNTIME_PROFILE,
      output.size,
      output.sha256,
      objectKey,
      objectVersion,
    ],
  );
  await db.query(
    "UPDATE tenants SET derivative_used_bytes=derivative_used_bytes+$2 WHERE id=$1",
    [owner.tenant, output.size],
  );
  const old = { id };
  assert.equal(
    (await call("GET", `/api/revisions/${saved.revisionId}/build-inline`)).json()
      .state,
    "ready",
  );
  const again = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.equal(again.json().state, "ready");
  assert.deepEqual(
    (
      await db.query(
        "SELECT id,builder_version FROM revision_derivatives WHERE revision_id=$1",
        [saved.revisionId],
      )
    ).rows,
    [{ id: old.id, builder_version: "bundle-inline-v3" }],
  );
  const opened = await shareAndOpen(saved.artifactId, saved.revisionId);
  assert.equal(opened.derivativeId, old.id);
  assert.equal(opened.viewer.revision.inlineBuild.state, "ready");
  assert.equal(opened.live.profile, BUNDLE_RUNTIME_PROFILE);
  assert.equal((await embedded(tokenFrom(opened.live.url))).statusCode, 200);
  const ownerView = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/live-view`,
    {},
  );
  assert.equal(ownerView.statusCode, 200, ownerView.body);
  assert.equal(ownerView.json().profile, BUNDLE_RUNTIME_PROFILE);
});

test("a page the v3 builder refused is built again by the current builder", async () => {
  const page = Buffer.from(
    '<!doctype html><html><body><h1 id="top">Workbench</h1><a href="#top">Top</a><button id="b">0</button><script>document.getElementById("b").onclick=(e)=>{e.target.textContent="1"}</script></body></html>',
  );
  const saved = await saveBundle(new Map([["index.html", page]]));
  await db.query(
    `INSERT INTO revision_derivatives(
       id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,reason
     ) VALUES($1,$2,$3,$4,'bundle-inline-v3','unsupported','unhandled resource-bearing HTML attribute')`,
    [randomUUID(), owner.tenant, saved.revisionId, saved.manifestSha256],
  );
  // The old refusal is not reported as the page's state.
  assert.equal(
    (await call("GET", `/api/revisions/${saved.revisionId}/build-inline`)).body,
    "null",
  );
  const built = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.equal(built.json().state, "ready", built.body);
  const opened = await shareAndOpen(saved.artifactId, saved.revisionId);
  const {
    rows: [derivative],
  } = await db.query(
    "SELECT builder_version FROM revision_derivatives WHERE id=$1",
    [opened.derivativeId],
  );
  assert.equal(derivative.builder_version, BUNDLE_BUILDER_VERSION);
});

test("a component page v4 refused is compiled by the Полка runtime and served", async () => {
  const saved = await saveBundle(
    new Map([
      ["index.html", Buffer.from(componentShell("Counter", "App.jsx"))],
      [
        "App.jsx",
        Buffer.from(
          'import { useState } from "react";\nexport default function App() { const [n, setN] = useState(0); return <button className="p-2" onClick={() => setN(n + 1)}>{n}</button>; }',
        ),
      ],
    ]),
  );
  await db.query(
    `INSERT INTO revision_derivatives(
       id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,reason
     ) VALUES($1,$2,$3,$4,'bundle-inline-v4','unsupported','module, importmap, non-JavaScript (e.g. text/babel) and referenced async or defer scripts are unsupported')`,
    [randomUUID(), owner.tenant, saved.revisionId, saved.manifestSha256],
  );
  const built = await call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {});
  assert.equal(built.json().state, "ready", built.body);
  assert.equal(built.json().runtimeProfile, REACT_RUNTIME_PROFILE);
  const opened = await shareAndOpen(saved.artifactId, saved.revisionId);
  assert.equal(opened.viewer.revision.inlineBuild.runtimeProfile, REACT_RUNTIME_PROFILE);
  assert.equal(opened.live.profile, REACT_RUNTIME_PROFILE);
  const served = await embedded(tokenFrom(opened.live.url));
  assert.equal(served.statusCode, 200);
  assert.match(served.headers["content-security-policy"] as string, /connect-src 'none'/);
  assert.doesNotMatch(served.body, /<script[^>]*\ssrc=|type="module"/);
  assert.match(served.body, /\.p-2/);
  const ownerView = await call("POST", `/api/revisions/${saved.revisionId}/live-view`, {});
  assert.equal(ownerView.statusCode, 200, ownerView.body);
  assert.equal(ownerView.json().profile, REACT_RUNTIME_PROFILE);
});

test("runtime builds get a minimal environment and run one at a time", async () => {
  const env = builderEnv();
  assert.deepEqual(Object.keys(env).sort(), [
    "ESBUILD_BINARY_PATH",
    "GOMAXPROCS",
    "GOMEMLIMIT",
    "PATH",
    "POLKA_ESBUILD_BINARY",
  ]);
  for (const secret of [config.DATABASE_URL, process.env.S3_SECRET_KEY, process.env.LINK_KEY])
    if (secret) assert.ok(!Object.values(env).includes(secret));
  assert.match(env.ESBUILD_BINARY_PATH, /esbuild-limited\.sh$/);

  const component = (label: string) =>
    saveBundle(
      new Map([
        ["index.html", Buffer.from(componentShell(label, "App.jsx"))],
        [
          "App.jsx",
          Buffer.from(
            `import { BarChart, Bar } from "recharts";\nexport default () => <BarChart width={100} height={50} data={[{ v: 1 }]}><Bar dataKey="v" /></BarChart>; // ${label}`,
          ),
        ],
      ]),
    );
  const [first, second] = [await component("one"), await component("two")];
  const [a, b] = await Promise.all(
    [first, second].map((saved) =>
      call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {}),
    ),
  );
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 429]);
  const busy = a.statusCode === 429 ? { response: a, saved: first } : { response: b, saved: second };
  assert.match(busy.response.json().message, /уже собирает/);
  // The refused attempt stays pending and a retry builds it.
  const retried = await call("POST", `/api/revisions/${busy.saved.revisionId}/build-inline`, {});
  assert.equal(retried.json().state, "ready", retried.body);
});

test("a computed import is refused through the build worker without reading the disk", async () => {
  const saved = await saveBundle(
    new Map([
      ["index.html", Buffer.from(componentShell("Leak", "App.jsx"))],
      [
        "App.jsx",
        Buffer.from(
          'const n = "";\nexport default async () => (await import(`../../../../../../../../proc/self/environ${n}`, { with: { type: "text" } })).default;',
        ),
      ],
    ]),
  );
  const built = await call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {});
  assert.equal(built.json().state, "unsupported", built.body);
  assert.match(built.json().reason, /import attributes/);
});

test("a component with an import outside the runtime is refused with the module named", async () => {
  const saved = await saveBundle(
    new Map([
      ["index.html", Buffer.from(componentShell("Animated", "App.jsx"))],
      ["App.jsx", Buffer.from('import { motion } from "framer-motion";\nexport default () => <motion.div />;')],
    ]),
  );
  const built = await call("POST", `/api/revisions/${saved.revisionId}/build-inline`, {});
  assert.equal(built.json().state, "unsupported", built.body);
  assert.match(built.json().reason, /module "framer-motion" is not available in the Полка runtime/);
  assert.equal(built.json().path, "App.jsx");
});

async function saveSingle(source: string) {
  const bytes = Buffer.from(source);
  const begun = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Single page",
    filename: "index.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes)).statusCode,
    200,
  );
  const finalized = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finalized.statusCode, 200, finalized.body);
  return finalized.json() as any;
}

test("an unsupported single upload is linked only through its built interactive version", async () => {
  const saved = await saveSingle(
    '<!doctype html><div id="root"></div><script>document.getElementById("root").textContent="Rendered by script"</script>',
  );
  assert.equal(saved.htmlProfile, "unsupported");
  const refused = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId,
    expiresInDays: 1,
  });
  assert.equal(refused.statusCode, 422, refused.body);
  const built = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.equal(built.json().state, "ready", built.body);
  const opened = await shareAndOpen(saved.artifactId, saved.revisionId);
  assert.ok(opened.derivativeId);
  assert.equal(opened.live.profile, BUNDLE_RUNTIME_PROFILE);
  const document = await embedded(tokenFrom(opened.live.url));
  assert.equal(document.statusCode, 200);
  assert.match(document.body, /Rendered by script/);
  // Neither the static document nor the raw upload reaches the recipient.
  assert.equal(
    (
      await call(
        "GET",
        "/api/view/bytes",
        undefined,
        "",
        opened.viewer.grant,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", `/api/view/${opened.viewer.grant}/document`, undefined, ""))
      .statusCode,
    404,
  );
  assert.equal((await staticDocument(opened.viewer.grant)).statusCode, 404);
  // The owner sees what the recipient sees: the built version, not the upload.
  const ownerView = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/live-view`,
    {},
  );
  assert.equal(ownerView.statusCode, 200, ownerView.body);
  assert.equal(ownerView.json().profile, BUNDLE_RUNTIME_PROFILE);
  const ownerDocument = await embedded(tokenFrom(ownerView.json().url));
  assert.equal(ownerDocument.statusCode, 200);
  assert.equal(ownerDocument.body, document.body);

  // A page that needs the network is refused by the builder and stays unlinked.
  const networked = await saveSingle(
    '<!doctype html><div id="root"></div><script src="https://cdn.example/app.js"></script>',
  );
  const refusedBuild = await call(
    "POST",
    `/api/revisions/${networked.revisionId}/build-inline`,
    {},
  );
  assert.equal(refusedBuild.json().state, "unsupported", refusedBuild.body);
  assert.equal(
    (
      await call("POST", `/api/artifacts/${networked.artifactId}/share`, {
        expectedRevisionId: networked.revisionId,
        expiresInDays: 1,
      })
    ).statusCode,
    422,
  );
});

test("a limited single upload links statically until its interactive version is ready", async () => {
  const saved = await saveSingle(
    '<!doctype html><h1>Counter prototype</h1><p>A small scripted page saved by its owner, with enough readable text to be shown statically.</p><button id="b">0</button><script>document.getElementById("b").onclick=(e)=>{e.target.textContent="1"}</script>',
  );
  assert.equal(saved.htmlProfile, "limited");
  const share = async () => {
    const response = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
      expectedRevisionId: saved.revisionId,
      expiresInDays: 1,
    });
    assert.equal(response.statusCode, 200, response.body);
    const created = response.json().share;
    const resolved = await call(
      "POST",
      "/api/resolve",
      { token: new URL(created.url).hash.slice(1) },
      "",
    );
    assert.equal(resolved.statusCode, 200, resolved.body);
    return { share: created, grant: resolved.json().grant as string };
  };
  // Before any build the owner runs the upload itself.
  const beforeBuild = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/live-view`,
    {},
  );
  assert.equal(beforeBuild.statusCode, 200, beforeBuild.body);
  assert.equal(beforeBuild.json().profile, "inline-live-experimental-v1");
  // No interactive version yet: static sandbox only, no direct run of the upload.
  const staticLink = await share();
  assert.equal(
    (await call("POST", "/api/view/live-view", undefined, "", staticLink.grant))
      .statusCode,
    404,
  );
  assert.equal(
    (await staticDocument(staticLink.grant)).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", "/api/view/bytes", undefined, "", staticLink.grant))
      .statusCode,
    200,
  );
  assert.equal(
    (await call("POST", `/api/shares/${staticLink.share.id}/revoke`, {})).statusCode,
    200,
  );

  const built = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
  );
  assert.equal(built.json().state, "ready", built.body);
  const liveLink = await share();
  const derivativeId = (
    await db.query("SELECT derivative_id FROM shares WHERE id=$1", [
      liveLink.share.id,
    ])
  ).rows[0].derivative_id;
  assert.ok(derivativeId);
  const live = await call("POST", "/api/view/live-view", undefined, "", liveLink.grant);
  assert.equal(live.statusCode, 200, live.body);
  assert.equal(live.json().profile, BUNDLE_RUNTIME_PROFILE);
  assert.equal(
    (await call("GET", "/api/view/bytes", undefined, "", liveLink.grant)).statusCode,
    404,
  );
  // Once a build is ready the owner runs it too, not the upload.
  const ownerView = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/live-view`,
    {},
  );
  assert.equal(ownerView.statusCode, 200, ownerView.body);
  assert.equal(ownerView.json().profile, BUNDLE_RUNTIME_PROFILE);
});
