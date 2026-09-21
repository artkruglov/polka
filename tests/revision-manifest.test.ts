import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createSingleHtmlRevisionManifest } from "../apps/server/revision-manifest.ts";
import { readBlob, s3 } from "../apps/server/storage.ts";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

const app = await createApp();
const password = randomBytes(24).toString("hex");
let cookie = "";

async function call(method: any, url: string, body?: any) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.APP_ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });
}

before(async () => {
  const account = await createAccount(
    `manifest-${randomBytes(5).toString("hex")}`,
    password,
  );
  const login = await call("POST", "/api/login", {
    name: account.name,
    password,
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

async function save(source: Buffer, mime: "text/html" | "text/plain") {
  const input = {
    key: randomUUID(),
    title: "Manifest fixture",
    filename: mime === "text/html" ? "saved.html" : "saved.txt",
    mime,
    size: source.length,
    sha256: sha256(source),
  };
  const start = await call("POST", "/api/uploads", input);
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  const upload = await call("PUT", `/api/uploads/${uploadId}/bytes`, source);
  assert.equal(upload.statusCode, 200, upload.body);
  const finalize = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finalize.statusCode, 200, finalize.body);
  return { input, uploadId, receipt: finalize.json() };
}

test("single HTML bytes produce a canonical versioned manifest and hash", () => {
  const bytes = Buffer.from("<!doctype html><h1>Сохранённая страница</h1>");
  const capturedAt = new Date("2026-09-20T12:34:56.789Z");
  const result = createSingleHtmlRevisionManifest(bytes, "static", capturedAt);

  assert.deepEqual(result.manifest, {
    version: 1,
    entrypoint: "index.html",
    runtime: "static-sandbox-v1",
    files: [
      {
        path: "index.html",
        mime: "text/html",
        size: bytes.length,
        sha256: sha256(bytes),
      },
    ],
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: capturedAt.toISOString(),
      attribution: "Загружено владельцем; авторство не подтверждено",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  });
  assert.equal(
    result.manifest.files.reduce((total, file) => total + file.size, 0),
    bytes.length,
  );
  assert.equal(
    result.manifestSha256,
    sha256(JSON.stringify(canonicalizeManifest(result.manifest))),
  );
  assert.deepEqual(
    createSingleHtmlRevisionManifest(bytes, "static", capturedAt),
    result,
  );
});

test("limited HTML uses the static profile and unsupported HTML is preserved only", () => {
  const bytes = Buffer.from(
    "<html><script>globalThis.ready=true</script></html>",
  );
  const capturedAt = new Date("2026-09-20T12:34:56Z");
  assert.equal(
    createSingleHtmlRevisionManifest(bytes, "limited", capturedAt).manifest
      .runtime,
    "static-sandbox-v1",
  );
  assert.equal(
    createSingleHtmlRevisionManifest(bytes, "unsupported", capturedAt).manifest
      .runtime,
    "preserved-only-v1",
  );
});

test("HTML finalization stores the canonical manifest atomically and retries its original receipt", async () => {
  const bytes = Buffer.from(
    "<!doctype html><html><body><h1>Принятый HTML</h1></body></html>",
  );
  const saved = await save(bytes, "text/html");
  assert.match(saved.receipt.manifestSha256, /^[a-f0-9]{64}$/);

  const {
    rows: [stored],
  } = await db.query(
    "SELECT manifest,manifest_sha256,object_key,object_version FROM revisions WHERE id=$1",
    [saved.receipt.revisionId],
  );
  const canonical = canonicalizeManifest(stored.manifest);
  const blob = await readBlob(stored.object_key, stored.object_version);
  assert.equal(blob.equals(bytes), true);
  assert.equal(canonical.entrypoint, "index.html");
  assert.equal(canonical.runtime, "static-sandbox-v1");
  assert.equal(
    canonical.files.reduce((total, file) => total + file.size, 0),
    blob.length,
  );
  assert.equal(canonical.files[0].sha256, sha256(blob));
  assert.equal(stored.manifest_sha256, saved.receipt.manifestSha256);
  assert.equal(
    stored.manifest_sha256,
    sha256(JSON.stringify(canonicalizeManifest(stored.manifest))),
  );

  const retry = await call(
    "POST",
    `/api/uploads/${saved.uploadId}/finalize`,
    {},
  );
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), saved.receipt);
  const beginRetry = await call("POST", "/api/uploads", saved.input);
  assert.equal(beginRetry.statusCode, 200, beginRetry.body);
  assert.deepEqual(beginRetry.json().receipt, saved.receipt);
  const {
    rows: [afterRetry],
  } = await db.query(
    "SELECT manifest,manifest_sha256 FROM revisions WHERE id=$1",
    [saved.receipt.revisionId],
  );
  assert.deepEqual(afterRetry, {
    manifest: stored.manifest,
    manifest_sha256: stored.manifest_sha256,
  });

  const revision = await call(
    "GET",
    `/api/artifacts/${saved.receipt.artifactId}/revisions`,
  );
  assert.equal(revision.statusCode, 200, revision.body);
  assert.deepEqual(revision.json()[0].manifest, stored.manifest);
  assert.equal(revision.json()[0].manifestSha256, stored.manifest_sha256);
});

test("non-HTML finalization leaves manifest columns null", async () => {
  const saved = await save(Buffer.from("ordinary text"), "text/plain");
  assert.equal("manifestSha256" in saved.receipt, false);
  const {
    rows: [stored],
  } = await db.query(
    "SELECT manifest,manifest_sha256 FROM revisions WHERE id=$1",
    [saved.receipt.revisionId],
  );
  assert.deepEqual(stored, { manifest: null, manifest_sha256: null });
});
