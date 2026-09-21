import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  bucket,
  putImmutable,
  readBlob,
  s3,
  sha256,
} from "../apps/server/storage.ts";
import {
  canonicalizeManifest,
  type BundleManifest,
} from "../packages/contracts/bundle.ts";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";

const app = await createApp();
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
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
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
const fixturePaths = [
  "index.html",
  "assets/mark.svg",
  "assets/report.css",
  "assets/report.js",
] as const;
const fixtureMimes: Record<(typeof fixturePaths)[number], string> = {
  "index.html": "text/html",
  "assets/mark.svg": "image/svg+xml",
  "assets/report.css": "text/css",
  "assets/report.js": "text/javascript",
};
let fixtureBytes: Record<string, Buffer>;

function manifest(overrides: Partial<BundleManifest> = {}): BundleManifest {
  return canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "preserved-only-v1",
    files: fixturePaths.map((path) => ({
      path,
      mime: fixtureMimes[path],
      size: fixtureBytes[path].length,
      sha256: sha256(fixtureBytes[path]),
    })),
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: "2026-09-20T12:00:00Z",
      attribution: "Оригинальный тестовый пакет Полки",
      license: "unknown",
    },
    dependencies: { status: "self-contained", unresolved: [] },
    ...overrides,
  });
}

function bundleInput(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: randomUUID(),
    title: "Командный отчёт",
    manifest: manifest(),
    ...patch,
  };
}

async function startBundle(input = bundleInput(), cookie = ownerCookie) {
  const response = await call("POST", "/api/bundle-uploads", input, cookie);
  assert.equal(response.statusCode, 200, response.body);
  return { input, uploadId: response.json().uploadId };
}

async function uploadAll(
  uploadId: string,
  bundleManifest: BundleManifest,
  cookie = ownerCookie,
) {
  for (const [index, file] of bundleManifest.files.entries()) {
    const response = await call(
      "PUT",
      `/api/bundle-uploads/${uploadId}/files/${index}`,
      fixtureBytes[file.path],
      cookie,
    );
    assert.equal(response.statusCode, 200, response.body);
  }
}

before(async () => {
  fixtureBytes = Object.fromEntries(
    await Promise.all(
      fixturePaths.map(async (path) => [
        path,
        await readFile(new URL(path, fixtureRoot)),
      ]),
    ),
  );
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`bundle-a-${suffix}`, password);
  other = await createAccount(`bundle-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  otherCookie = await login(other.name);
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("four-file bundle finalizes once, stays tenant-private, and exports verified bytes", async () => {
  const input = bundleInput();
  const canonical = canonicalizeManifest(input.manifest);
  const started = await startBundle(input);
  const retry = await call("POST", "/api/bundle-uploads", {
    ...input,
    manifest: { ...canonical, files: [...canonical.files].reverse() },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().uploadId, started.uploadId);
  assert.equal(
    (await call("POST", "/api/bundle-uploads", { ...input, title: "Другое" }))
      .statusCode,
    409,
  );
  assert.equal(
    (await call("GET", `/api/uploads/${started.uploadId}`)).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/api/uploads/${started.uploadId}/bytes`,
        fixtureBytes["index.html"],
      )
    ).statusCode,
    404,
  );
  await uploadAll(started.uploadId, canonical);
  assert.deepEqual(
    (await call("GET", `/api/bundle-uploads/${started.uploadId}`)).json()
      .uploaded,
    [0, 1, 2, 3],
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/bundle-uploads/${started.uploadId}`,
        undefined,
        otherCookie,
      )
    ).statusCode,
    404,
  );
  const finalized = await Promise.all([
    call("POST", `/api/bundle-uploads/${started.uploadId}/finalize`, {}),
    call("POST", `/api/bundle-uploads/${started.uploadId}/finalize`, {}),
  ]);
  assert.equal(finalized[0].statusCode, 200, finalized[0].body);
  assert.deepEqual(finalized[0].json(), finalized[1].json());
  const receipt = finalized[0].json();
  assert.equal(receipt.storageKind, "bundle");
  assert.equal(
    receipt.totalSize,
    canonical.files.reduce((sum, file) => sum + file.size, 0),
  );
  assert.equal(
    +(
      await db.query(
        "SELECT count(*) FROM revision_files WHERE revision_id=$1",
        [receipt.revisionId],
      )
    ).rows[0].count,
    4,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/revisions/${receipt.revisionId}/export`,
        undefined,
        otherCookie,
      )
    ).statusCode,
    404,
  );
  const exported = await call(
    "GET",
    `/api/revisions/${receipt.revisionId}/export`,
  );
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(
    exported.headers["content-disposition"] as string,
    /^attachment;/,
  );
  const bundle = exported.json();
  assert.deepEqual(bundle.manifest, canonical);
  assert.equal(bundle.manifestSha256, receipt.manifestSha256);
  for (const file of bundle.files) {
    const bytes = Buffer.from(file.data, "base64");
    assert.equal(file.encoding, "base64");
    assert.equal(bytes.equals(fixtureBytes[file.path]), true, file.path);
    assert.equal(bytes.length, file.size);
    assert.equal(sha256(bytes), file.sha256);
  }
  assert.equal(
    (await call("GET", `/api/revisions/${receipt.revisionId}/document`))
      .statusCode,
    404,
  );
});

test("bundle files enforce index, hash, completeness, abort, and route kind", async () => {
  const canonical = manifest();
  assert.equal(
    (
      await call("POST", "/api/bundle-uploads", {
        ...bundleInput({ manifest: canonical }),
        unexpected: true,
      })
    ).statusCode,
    400,
  );
  const started = await startBundle(bundleInput({ manifest: canonical }));
  assert.equal(
    (
      await call(
        "PUT",
        `/api/bundle-uploads/${started.uploadId}/files/0`,
        Buffer.from("wrong"),
      )
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/api/bundle-uploads/${started.uploadId}/files/63`,
        Buffer.alloc(0),
      )
    ).statusCode,
    404,
  );
  const parallel = await Promise.all([
    call(
      "PUT",
      `/api/bundle-uploads/${started.uploadId}/files/0`,
      fixtureBytes[canonical.files[0].path],
    ),
    call(
      "PUT",
      `/api/bundle-uploads/${started.uploadId}/files/0`,
      fixtureBytes[canonical.files[0].path],
    ),
  ]);
  assert.deepEqual(
    parallel.map((response) => response.statusCode),
    [200, 200],
  );
  assert.equal(
    +(
      await db.query(
        "SELECT count(*) FROM upload_files WHERE upload_id=$1 AND file_index=0",
        [started.uploadId],
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (await call("POST", `/api/bundle-uploads/${started.uploadId}/finalize`, {}))
      .statusCode,
    409,
  );
  assert.equal(
    (await call("POST", `/api/uploads/${started.uploadId}/finalize`, {}))
      .statusCode,
    404,
  );
  await call("DELETE", `/api/bundle-uploads/${started.uploadId}`);
  assert.equal(
    (
      await call(
        "PUT",
        `/api/bundle-uploads/${started.uploadId}/files/1`,
        fixtureBytes[canonical.files[1].path],
      )
    ).statusCode,
    410,
  );

  const invalidUtf8 = Buffer.from([255]);
  const badManifest = canonicalizeManifest({
    ...canonical,
    files: canonical.files.map((file) =>
      file.mime === "text/css"
        ? { ...file, size: invalidUtf8.length, sha256: sha256(invalidUtf8) }
        : file,
    ),
  });
  const bad = await startBundle(bundleInput({ manifest: badManifest }));
  const badIndex = badManifest.files.findIndex(
    (file) => file.mime === "text/css",
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/api/bundle-uploads/${bad.uploadId}/files/${badIndex}`,
        invalidUtf8,
      )
    ).statusCode,
    422,
  );
  await call("DELETE", `/api/bundle-uploads/${bad.uploadId}`);
});

test("single and bundle uploads share quota reservations and the eight-upload limit", async () => {
  await db.query(
    "UPDATE uploads SET aborted=true WHERE tenant_id=$1 AND receipt IS NULL",
    [owner.tenant],
  );
  const used = +(
    await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [owner.tenant])
  ).rows[0].used_bytes;
  await db.query("UPDATE tenants SET quota_bytes=$2 WHERE id=$1", [
    owner.tenant,
    used + 10,
  ]);
  const single = Buffer.from("123456");
  const pendingSingle = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "reservation",
    filename: "a.txt",
    mime: "text/plain",
    size: single.length,
    sha256: sha256(single),
  });
  assert.equal(pendingSingle.statusCode, 200, pendingSingle.body);
  assert.equal(
    (await call("POST", "/api/bundle-uploads", bundleInput())).statusCode,
    413,
  );
  await call("DELETE", `/api/uploads/${pendingSingle.json().uploadId}`);
  await db.query("UPDATE tenants SET quota_bytes=104857600 WHERE id=$1", [
    owner.tenant,
  ]);

  const pending: Array<{ kind: "single" | "bundle"; id: string }> = [];
  for (let index = 0; index < 8; index++) {
    const body = Buffer.from(String(index));
    const response = await call("POST", "/api/uploads", {
      key: randomUUID(),
      title: `pending-${index}`,
      filename: "a.txt",
      mime: "text/plain",
      size: body.length,
      sha256: sha256(body),
    });
    assert.equal(response.statusCode, 200, response.body);
    pending.push({ kind: "single", id: response.json().uploadId });
  }
  assert.equal(
    (await call("POST", "/api/bundle-uploads", bundleInput())).statusCode,
    413,
  );
  for (const upload of pending)
    await call("DELETE", `/api/uploads/${upload.id}`);
});

test("stale bundle CAS creates no partial revision or quota charge", async () => {
  const baseBytes = Buffer.from("base");
  const baseInput = {
    key: randomUUID(),
    title: "Bundle CAS",
    filename: "base.txt",
    mime: "text/plain",
    size: baseBytes.length,
    sha256: sha256(baseBytes),
  };
  const begin = await call("POST", "/api/uploads", baseInput);
  await call("PUT", `/api/uploads/${begin.json().uploadId}/bytes`, baseBytes);
  const base = (
    await call("POST", `/api/uploads/${begin.json().uploadId}/finalize`, {})
  ).json();
  const patch = {
    artifactId: base.artifactId,
    baseRevisionId: base.revisionId,
  };
  const first = await startBundle(bundleInput(patch));
  const second = await startBundle(bundleInput(patch));
  await uploadAll(first.uploadId, manifest());
  await uploadAll(second.uploadId, manifest());
  const before = +(
    await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [owner.tenant])
  ).rows[0].used_bytes;
  assert.equal(
    (await call("POST", `/api/bundle-uploads/${first.uploadId}/finalize`, {}))
      .statusCode,
    200,
  );
  const afterFirst = +(
    await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [owner.tenant])
  ).rows[0].used_bytes;
  assert.equal(
    (await call("POST", `/api/bundle-uploads/${second.uploadId}/finalize`, {}))
      .statusCode,
    409,
  );
  assert.equal(
    +(
      await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [
        owner.tenant,
      ])
    ).rows[0].used_bytes,
    afterFirst,
  );
  assert.ok(afterFirst > before);
  assert.equal(
    +(
      await db.query("SELECT count(*) FROM revisions WHERE artifact_id=$1", [
        base.artifactId,
      ])
    ).rows[0].count,
    2,
  );
});

test("maintenance removes recorded and rollback-orphan bundle keys but protects committed files", async () => {
  const canonical = manifest();
  const committed = await startBundle(bundleInput({ manifest: canonical }));
  await uploadAll(committed.uploadId, canonical);
  const receipt = (
    await call("POST", `/api/bundle-uploads/${committed.uploadId}/finalize`, {})
  ).json();
  const committedFiles = (
    await db.query(
      "SELECT object_key,object_version FROM revision_files WHERE revision_id=$1",
      [receipt.revisionId],
    )
  ).rows;
  await db.query(
    "UPDATE uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
    [committed.uploadId],
  );

  const orphan = await startBundle(bundleInput({ manifest: canonical }));
  const recorded = canonical.files[0];
  await call(
    "PUT",
    `/api/bundle-uploads/${orphan.uploadId}/files/0`,
    fixtureBytes[recorded.path],
  );
  const unrecordedIndex = 1;
  const unrecorded = canonical.files[unrecordedIndex];
  const unrecordedKey = `${owner.tenant}/${orphan.uploadId}/files/${unrecordedIndex}`;
  const unrecordedVersion = await putImmutable(
    unrecordedKey,
    fixtureBytes[unrecorded.path],
  );
  const recordedRow = (
    await db.query(
      "SELECT object_key,object_version FROM upload_files WHERE upload_id=$1 AND file_index=0",
      [orphan.uploadId],
    )
  ).rows[0];
  await call("DELETE", `/api/bundle-uploads/${orphan.uploadId}`);
  const cleanup = spawnSync(
    process.execPath,
    ["--import", "tsx", "--env-file=.env", "scripts/maintenance.ts"],
    { encoding: "utf8" },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(
    readBlob(recordedRow.object_key, recordedRow.object_version),
  );
  await assert.rejects(readBlob(unrecordedKey, unrecordedVersion));
  for (const file of committedFiles)
    assert.ok(
      (await readBlob(file.object_key, file.object_version)).length > 0,
    );
  assert.ok(
    (
      await db.query("SELECT reconciled_at FROM uploads WHERE id=$1", [
        orphan.uploadId,
      ])
    ).rows[0].reconciled_at,
  );
  const listing = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: `${owner.tenant}/${orphan.uploadId}`,
    }),
  );
  assert.equal(
    (listing.Versions ?? []).some((value) =>
      value.Key?.startsWith(`${owner.tenant}/${orphan.uploadId}`),
    ),
    false,
  );
});
