import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import {
  BUNDLE_BUILDER_VERSION,
  BUNDLE_RUNTIME_PROFILE,
} from "../apps/server/bundle-runtime-contract.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { buildInlineRevisionFromSource } from "../apps/server/bundle-derivatives.ts";
import { prepareLibraryLiveView } from "../apps/server/template-library-viewer.ts";
import { putImmutable, s3, sha256 } from "../apps/server/storage.ts";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";

const app = await createApp();
const viewer = await createLiveViewerApp();
const password = randomBytes(24).toString("hex");
let source: Awaited<ReturnType<typeof createAccount>>;
let member: Awaited<ReturnType<typeof createAccount>>;
let outsider: Awaited<ReturnType<typeof createAccount>>;
let sourceCookie = "";
let memberCookie = "";
let outsiderCookie = "";

async function call(
  method: any,
  url: string,
  body?: any,
  cookie = sourceCookie,
) {
  return app.inject({
    method,
    url,
    headers: { origin: config.APP_ORIGIN, ...(cookie ? { cookie } : {}) },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function saveHtml(html: string) {
  const bytes = Buffer.from(html);
  const begun = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Library viewer",
    filename: "viewer.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId;
  const uploaded = await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/bytes`,
    headers: {
      origin: config.APP_ORIGIN,
      cookie: sourceCookie,
      "content-type": "application/octet-stream",
    },
    payload: bytes,
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const saved = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(saved.statusCode, 200, saved.body);
  const pinned = await call(
    "POST",
    `/api/artifacts/${saved.json().artifactId}/template-releases`,
    {
      revisionId: saved.json().revisionId,
      summary: "Example",
      rules: "Keep layout",
      questions: "",
    },
  );
  assert.equal(pinned.statusCode, 200, pinned.body);
  return { ...saved.json(), releaseId: pinned.json().releaseId };
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

async function saveBundle() {
  const files = new Map(
    await Promise.all(
      Object.keys(fixtureMimes).map(
        async (path) =>
          [path, await readFile(new URL(path, fixtureRoot))] as const,
      ),
    ),
  );
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "preserved-only-v1",
    files: [...files].map(([path, bytes]) => ({
      path,
      mime: fixtureMimes[path],
      size: bytes.length,
      sha256: sha256(bytes),
    })),
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: "2026-09-21T12:00:00Z",
      attribution: "Library prepare fixture",
      license: "unknown",
    },
    dependencies: { status: "self-contained", unresolved: [] },
  });
  const begun = await call("POST", "/api/bundle-uploads", {
    key: randomUUID(),
    title: "Library bundle",
    manifest,
  });
  assert.equal(begun.statusCode, 200, begun.body);
  for (const [index, file] of manifest.files.entries()) {
    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/bundle-uploads/${begun.json().uploadId}/files/${index}`,
      headers: {
        origin: config.APP_ORIGIN,
        cookie: sourceCookie,
        "content-type": "application/octet-stream",
      },
      payload: files.get(file.path),
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
  }
  const saved = await call(
    "POST",
    `/api/bundle-uploads/${begun.json().uploadId}/finalize`,
    {},
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const release = await call(
    "POST",
    `/api/artifacts/${saved.json().artifactId}/template-releases`,
    {
      revisionId: saved.json().revisionId,
      summary: "Interactive library bundle",
      rules: "Keep exact styling",
      questions: "",
    },
  );
  assert.equal(release.statusCode, 200, release.body);
  return { ...saved.json(), releaseId: release.json().releaseId };
}

const tokenPath = (url: string) => new URL(url).pathname;
const embedded = (path: string) =>
  viewer.inject({
    url: path,
    headers: {
      host: config.VIEWER_UPSTREAM_HOST,
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
    },
  });

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  source = await createAccount(`viewer-source-${suffix}`, password);
  member = await createAccount(`viewer-member-${suffix}`, password);
  outsider = await createAccount(`viewer-outside-${suffix}`, password);
  sourceCookie = await login(source.name);
  memberCookie = await login(member.name);
  outsiderCookie = await login(outsider.name);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("library capabilities serve exact single and ready bundle bytes and expire with authority", async () => {
  const singleHtml =
    "<!doctype html><html><body><h1>Member preview</h1></body></html>";
  const single = await saveHtml(singleHtml);
  const created = await call("POST", "/api/template-libraries", {
    name: "Viewer library",
  });
  assert.equal(created.statusCode, 200, created.body);
  const libraryId = created.json().id;
  await db.query(
    `INSERT INTO template_library_members(library_id,account_id,role,joined_at)
     VALUES($1,$2,'reader','2026-09-21 12:34:56.123456+00')`,
    [libraryId, member.id],
  );
  const published = await call(
    "POST",
    `/api/template-libraries/${libraryId}/publications`,
    { releaseId: single.releaseId },
  );
  assert.equal(published.statusCode, 200, published.body);
  const publicationId = published.json().id;
  const endpoint = `/api/template-libraries/${libraryId}/publications/${publicationId}/live-view`;
  const body = { artifactId: single.artifactId, revisionId: single.revisionId };

  assert.equal(
    (await call("POST", endpoint, body, outsiderCookie)).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        endpoint,
        { ...body, revisionId: randomUUID() },
        memberCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        endpoint,
        { ...body, artifactId: randomUUID() },
        memberCookie,
      )
    ).statusCode,
    404,
  );
  const issued = await call("POST", endpoint, body, memberCookie);
  assert.equal(issued.statusCode, 200, issued.body);
  assert.equal(issued.json().status, "ready");
  assert.match(issued.json().url, /\/library-document\//);
  assert.ok(Date.parse(issued.json().expiresAt) <= Date.now() + 60_000);
  const document = await embedded(tokenPath(issued.json().url));
  assert.equal(document.statusCode, 200, document.body);
  assert.equal(document.body, singleHtml);
  assert.match(
    String(document.headers["content-security-policy"]),
    /^sandbox allow-scripts allow-forms;/,
  );
  assert.match(
    String(document.headers["content-security-policy"]),
    /connect-src 'none'/,
  );
  assert.match(
    String(document.headers["content-security-policy"]),
    new RegExp(`frame-ancestors ${config.APP_ORIGIN}`),
  );
  assert.equal(
    (
      await viewer.inject({
        url: tokenPath(issued.json().url),
        headers: { host: config.VIEWER_UPSTREAM_HOST },
      })
    ).statusCode,
    404,
  );

  await db.query(
    `UPDATE template_library_members SET state='revoked',revoked_at=clock_timestamp()
     WHERE library_id=$1 AND account_id=$2 AND state='active'`,
    [libraryId, member.id],
  );
  await db.query(
    `INSERT INTO template_library_members(library_id,account_id,role,joined_at)
     VALUES($1,$2,'reader','2026-09-21 12:34:56.123457+00')`,
    [libraryId, member.id],
  );
  assert.equal((await embedded(tokenPath(issued.json().url))).statusCode, 404);

  const expireGrant = await call("POST", endpoint, body, memberCookie);
  const memberSession = sha256(memberCookie.split("=")[1]!);
  await db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [memberSession],
  );
  assert.equal(
    (await embedded(tokenPath(expireGrant.json().url))).statusCode,
    404,
  );
  await db.query(
    "UPDATE sessions SET expires_at=now()+interval '1 day' WHERE hash=$1",
    [memberSession],
  );

  const trashGrant = await call("POST", endpoint, body, memberCookie);
  await db.query(
    "UPDATE artifacts SET trashed_at=clock_timestamp() WHERE id=$1",
    [single.artifactId],
  );
  assert.equal(
    (await embedded(tokenPath(trashGrant.json().url))).statusCode,
    404,
  );
  await db.query("UPDATE artifacts SET trashed_at=NULL WHERE id=$1", [
    single.artifactId,
  ]);

  const disabledGrant = await call("POST", endpoint, body, memberCookie);
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [source.id]);
  assert.equal(
    (await embedded(tokenPath(disabledGrant.json().url))).statusCode,
    404,
  );
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [source.id]);

  const bundleArtifact = randomUUID(),
    bundleRevision = randomUUID();
  const bundleRelease = randomUUID(),
    bundlePublication = randomUUID();
  const manifestSha = "a".repeat(64);
  const sourceBytes = Buffer.from("bundle source placeholder");
  const sourceKey = `${source.tenant}/library-viewer/${bundleRevision}/source`;
  const sourceVersion = await putImmutable(sourceKey, sourceBytes);
  await db.query(
    `INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Bundle template')`,
    [bundleArtifact, source.tenant, source.id],
  );
  await db.query(
    `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
       object_key,object_version,html_profile,manifest,manifest_sha256,storage_kind,total_size)
     VALUES($1,$2,$3,1,$4,'bundle.html','text/html',$5,$6,$7,$8,'unsupported',$9::jsonb,$10,'bundle',$5)`,
    [
      bundleRevision,
      source.tenant,
      bundleArtifact,
      source.id,
      sourceBytes.length,
      sha256(sourceBytes),
      sourceKey,
      sourceVersion,
      JSON.stringify({ entry: "index.html", files: [] }),
      manifestSha,
    ],
  );
  await db.query(
    `INSERT INTO template_releases(id,artifact_id,revision_id,title,summary,rules,questions)
     VALUES($1,$2,$3,'Bundle','Summary','Rules','')`,
    [bundleRelease, bundleArtifact, bundleRevision],
  );
  await db.query(
    `INSERT INTO template_library_publications(id,library_id,release_id,artifact_id,revision_id,publisher_id)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      bundlePublication,
      libraryId,
      bundleRelease,
      bundleArtifact,
      bundleRevision,
      source.id,
    ],
  );
  const bundleEndpoint = `/api/template-libraries/${libraryId}/publications/${bundlePublication}/live-view`;
  const bundleBody = { artifactId: bundleArtifact, revisionId: bundleRevision };
  const unprepared = await call(
    "POST",
    bundleEndpoint,
    bundleBody,
    memberCookie,
  );
  assert.equal(unprepared.statusCode, 409, unprepared.body);
  assert.deepEqual(unprepared.json(), {
    status: "preparation_required",
    revisionId: bundleRevision,
    build: null,
  });

  const derivativeId = randomUUID(),
    attemptId = randomUUID();
  const bundleHtml = Buffer.from(
    "<!doctype html><html><body>Exact bundle derivative</body></html>",
  );
  const derivativeKey = `${source.tenant}/derivatives/${derivativeId}/${attemptId}.html`;
  const derivativeVersion = await putImmutable(derivativeKey, bundleHtml);
  await db.query(
    `INSERT INTO revision_derivatives(id,tenant_id,revision_id,source_manifest_sha256,builder_version,
       state,attempt_id,runtime_profile,size,sha256,object_key,object_version)
     VALUES($1,$2,$3,$4,$5,'ready',$6,$7,$8,$9,$10,$11)`,
    [
      derivativeId,
      source.tenant,
      bundleRevision,
      manifestSha,
      BUNDLE_BUILDER_VERSION,
      attemptId,
      BUNDLE_RUNTIME_PROFILE,
      bundleHtml.length,
      sha256(bundleHtml),
      derivativeKey,
      derivativeVersion,
    ],
  );
  const bundleIssued = await call(
    "POST",
    bundleEndpoint,
    bundleBody,
    memberCookie,
  );
  assert.equal(bundleIssued.statusCode, 200, bundleIssued.body);
  assert.equal(bundleIssued.json().profile, BUNDLE_RUNTIME_PROFILE);
  const bundleDocument = await embedded(tokenPath(bundleIssued.json().url));
  assert.equal(bundleDocument.statusCode, 200, bundleDocument.body);
  assert.equal(bundleDocument.body, bundleHtml.toString());
});

test("a member prepares an exact published bundle against source quota and opens it", async () => {
  const saved = await saveBundle();
  const created = await call("POST", "/api/template-libraries", {
    name: "Prepared bundle library",
  });
  assert.equal(created.statusCode, 200, created.body);
  const libraryId = created.json().id;
  await db.query(
    `INSERT INTO template_library_members(library_id,account_id,role)
     VALUES($1,$2,'reader')`,
    [libraryId, member.id],
  );
  const published = await call(
    "POST",
    `/api/template-libraries/${libraryId}/publications`,
    { releaseId: saved.releaseId },
  );
  assert.equal(published.statusCode, 200, published.body);
  const publicationId = published.json().id;
  const endpoint = `/api/template-libraries/${libraryId}/publications/${publicationId}`;
  const body = { artifactId: saved.artifactId, revisionId: saved.revisionId };
  const sourceBefore = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        source.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );
  const memberBefore = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        member.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );

  assert.equal(
    (await call("POST", `${endpoint}/prepare-live-view`, body, outsiderCookie))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        `${endpoint}/prepare-live-view`,
        { ...body, revisionId: randomUUID() },
        memberCookie,
      )
    ).statusCode,
    404,
  );

  const prepared = await Promise.all([
    call("POST", `${endpoint}/prepare-live-view`, body, memberCookie),
    call("POST", `${endpoint}/prepare-live-view`, body, memberCookie),
  ]);
  assert.ok(
    prepared.every((response) => [200, 202].includes(response.statusCode)),
    prepared.map((x) => x.body).join("\n"),
  );
  assert.ok(prepared.some((response) => response.statusCode === 202));
  assert.ok(prepared.some((response) => response.json().state === "ready"));
  const derivative = (
    await db.query("SELECT * FROM revision_derivatives WHERE revision_id=$1", [
      saved.revisionId,
    ])
  ).rows[0];
  assert.equal(derivative.state, "ready");
  assert.equal(derivative.tenant_id, source.tenant);
  assert.match(
    derivative.object_key,
    new RegExp(`^${source.tenant}/derivatives/`),
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT derivative_used_bytes FROM tenants WHERE id=$1",
          [source.tenant],
        )
      ).rows[0].derivative_used_bytes,
    ),
    sourceBefore + derivative.size,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT derivative_used_bytes FROM tenants WHERE id=$1",
          [member.tenant],
        )
      ).rows[0].derivative_used_bytes,
    ),
    memberBefore,
  );

  const issued = await call(
    "POST",
    `${endpoint}/live-view`,
    body,
    memberCookie,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  const document = await embedded(tokenPath(issued.json().url));
  assert.equal(document.statusCode, 200, document.body);
  assert.equal(sha256(Buffer.from(document.body)), derivative.sha256);

  const ownerBuild = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/build-inline`,
    {},
    sourceCookie,
  );
  assert.equal(ownerBuild.statusCode, 200, ownerBuild.body);
  assert.equal(ownerBuild.json().state, "ready");

  await db.query(
    `UPDATE template_library_members SET state='revoked',revoked_at=clock_timestamp()
     WHERE library_id=$1 AND account_id=$2 AND state='active'`,
    [libraryId, member.id],
  );
  assert.equal(
    (await call("POST", `${endpoint}/prepare-live-view`, body, memberCookie))
      .statusCode,
    404,
  );
});

test("revocation during a build leaves only an expiring attempt that maintenance makes retryable", async () => {
  const saved = await saveBundle();
  const created = await call("POST", "/api/template-libraries", {
    name: "Revoked bundle build",
  });
  const libraryId = created.json().id;
  await db.query(
    `INSERT INTO template_library_members(library_id,account_id,role)
     VALUES($1,$2,'reader')`,
    [libraryId, member.id],
  );
  const published = await call(
    "POST",
    `/api/template-libraries/${libraryId}/publications`,
    { releaseId: saved.releaseId },
  );
  const publicationId = published.json().id;
  const endpoint = `/api/template-libraries/${libraryId}/publications/${publicationId}/prepare-live-view`;
  const body = { artifactId: saved.artifactId, revisionId: saved.revisionId };

  let bytesRead!: () => void;
  const bytesWereRead = new Promise<void>((resolve) => {
    bytesRead = resolve;
  });
  let continueBuild!: () => void;
  const buildMayContinue = new Promise<void>((resolve) => {
    continueBuild = resolve;
  });
  const request = prepareLibraryLiveView(
    { id: member.id, tenant: member.tenant },
    { libraryId, publicationId, ...body },
    {
      build: (options) =>
        buildInlineRevisionFromSource({
          ...options,
          readSource: async () => {
            const exactSource = await options.readSource();
            bytesRead();
            await buildMayContinue;
            return exactSource;
          },
        }),
    },
  );
  await bytesWereRead;
  const pending = (
    await db.query("SELECT * FROM revision_derivatives WHERE revision_id=$1", [
      saved.revisionId,
    ])
  ).rows[0];
  assert.equal(pending.state, "pending");
  await db.query(
    `UPDATE template_library_members SET state='revoked',revoked_at=clock_timestamp()
     WHERE library_id=$1 AND account_id=$2 AND state='active'`,
    [libraryId, member.id],
  );
  continueBuild();
  await assert.rejects(request, (error: any) => error?.status === 404);
  const residue = (
    await db.query(
      "SELECT state,attempt_expires_at,object_key FROM revision_derivatives WHERE id=$1",
      [pending.id],
    )
  ).rows[0];
  assert.equal(residue.state, "pending");
  assert.ok(residue.attempt_expires_at);
  assert.equal(residue.object_key, null);

  await db.query(
    "UPDATE revision_derivatives SET attempt_expires_at=now()-interval '1 second' WHERE id=$1",
    [pending.id],
  );
  const maintenance = spawnSync(
    process.execPath,
    ["--import", "tsx", "--env-file=.env", "scripts/maintenance.ts"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(maintenance.status, 0, maintenance.stderr);
  assert.equal(
    (
      await db.query(
        "SELECT state,attempt_expires_at FROM revision_derivatives WHERE id=$1",
        [pending.id],
      )
    ).rows[0].state,
    "failed",
  );
  await db.query(
    `INSERT INTO template_library_members(library_id,account_id,role)
     VALUES($1,$2,'reader')`,
    [libraryId, member.id],
  );
  const retried = await call("POST", endpoint, body, memberCookie);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().state, "ready");
});
