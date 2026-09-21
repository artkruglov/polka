import { after, before, test } from "node:test";
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
} from "../apps/server/bundle-runtime-contract.ts";
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
const embedded = (token: string) =>
  viewer.inject({
    method: "GET",
    url: `/document/${token}`,
    headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
  });

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
  assert.equal(sha256(Buffer.from(oldDocument.body)), derivative.sha256);
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
  assert.equal(sha256(Buffer.from(stillOld.body)), derivative.sha256);

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
        HTML_LIVE_ENABLED: "false",
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
        "<!doctype html><html><body><script type=module>export{}</script></body></html>",
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
