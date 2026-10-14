// Lost objects of the works bucket come back from its copy
// (scripts/objects-restore.ts, deploy/hosted README «Копия работ»): a version
// the database names but the bucket lost is read from the mirror, written
// back, and the rows point at the new version; the work reads again.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { bucket, readBlob, s3, sha256 } from "../apps/server/storage.ts";
import { OBJECT_REFERENCES, runObjectsRestore } from "../scripts/objects-restore.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const mirrorBucket = `${bucket}-mirror`.slice(0, 63);
let cookie = "";

before(async () => {
  const owner = await createAccount(`mirror-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  await s3.send(new CreateBucketCommand({ Bucket: mirrorBucket })).catch((e: any) => {
    if (![409].includes(e.$metadata?.httpStatusCode)) throw e;
  });
  await s3.send(
    new PutBucketVersioningCommand({ Bucket: mirrorBucket, VersioningConfiguration: { Status: "Enabled" } }),
  );
});
after(async () => {
  const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: mirrorBucket }));
  for (const v of [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])])
    await s3.send(new DeleteObjectCommand({ Bucket: mirrorBucket, Key: v.Key, VersionId: v.VersionId }));
  await s3.send(new DeleteBucketCommand({ Bucket: mirrorBucket }));
  await app.close();
  await db.end();
});

// A new column naming an object version must be restorable too.
test("every object version column is in OBJECT_REFERENCES", async () => {
  const { rows } = await db.query(
    `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema='public' AND data_type='text'
        AND (column_name='object_version' OR column_name LIKE '%\\_version')
        AND column_name NOT IN ('policy_version','builder_version','cli_version',
          -- erasure ledger records, not the works bucket
          'purged_version','revoke_version')
        AND table_name <> 'uploads'
      ORDER BY 1`,
  );
  const known = OBJECT_REFERENCES.map((ref) => `${ref.table}.${ref.version}`);
  assert.deepEqual(
    rows.map((row) => row.col).filter((col) => !known.includes(col)),
    [],
    "add these to OBJECT_REFERENCES in scripts/objects-restore.ts",
  );
});

test("a lost version comes back from the mirror and the work reads again", async () => {
  const bytes = Buffer.from(`<!doctype html><title>Копия</title><p>${randomUUID()}</p>`);
  const begun = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { origin, cookie },
    payload: {
      key: randomUUID(),
      title: "Копия",
      filename: "index.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
    },
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/bytes`,
    headers: { origin, cookie, "content-type": "application/octet-stream" },
    payload: bytes,
  });
  const done = await app.inject({
    method: "POST",
    url: `/api/uploads/${uploadId}/finalize`,
    headers: { origin, cookie },
    payload: {},
  });
  assert.equal(done.statusCode, 200, done.body);
  const {
    rows: [revision],
  } = await db.query("SELECT object_key, object_version FROM revisions WHERE id=$1", [done.json().revisionId]);

  // What objects-mirror does, then the loss.
  await s3.send(
    new CopyObjectCommand({
      Bucket: mirrorBucket,
      Key: revision.object_key,
      CopySource: `${bucket}/${revision.object_key}?versionId=${revision.object_version}`,
    }),
  );
  await s3.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: revision.object_key, VersionId: revision.object_version }),
  );
  // The source key deleted in the mirror as well: the copy is behind a marker.
  await s3.send(new DeleteObjectCommand({ Bucket: mirrorBucket, Key: revision.object_key }));

  const env = {
    S3_ENDPOINT: config.S3_ENDPOINT,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY: config.S3_ACCESS_KEY,
    S3_SECRET_KEY: config.S3_SECRET_KEY,
    MIRROR_BUCKET: mirrorBucket,
    MIRROR_READ_ACCESS_KEY: config.S3_ACCESS_KEY,
    MIRROR_READ_SECRET_KEY: config.S3_SECRET_KEY,
    DATABASE_URL: process.env.OBJECTS_RESTORE_DATABASE_URL || config.DATABASE_URL,
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    // A dry run changes nothing.
    assert.equal(await runObjectsRestore(["--key", revision.object_key]), 0);
    const {
      rows: [unchanged],
    } = await db.query("SELECT object_version FROM revisions WHERE id=$1", [done.json().revisionId]);
    assert.equal(unchanged.object_version, revision.object_version);

    assert.equal(await runObjectsRestore(["--apply", "--key", revision.object_key]), 0);
  } finally {
    process.env = saved;
  }
  const {
    rows: [restored],
  } = await db.query("SELECT object_version FROM revisions WHERE id=$1", [done.json().revisionId]);
  assert.notEqual(restored.object_version, revision.object_version);
  assert.deepEqual(await readBlob(revision.object_key, restored.object_version), bytes);
});
