import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DeleteObjectsCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { OPS_LIMITS } from "../apps/server/ops-status.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
// The disk check reads the machine running the tests; keep it out of the verdict.
OPS_LIMITS.diskFreePercent = 0;
const mutable = config as { OPS_STATUS_TOKEN?: string; OPS_BACKUP_BUCKET?: string };
const token = randomBytes(24).toString("hex");
const dumpKey = `postgres/polka-${randomBytes(4).toString("hex")}.dump`;

const status = (authorization?: string) =>
  app.inject({
    method: "GET",
    url: "/api/ops/status",
    headers: authorization ? { authorization } : {},
  });

after(async () => {
  mutable.OPS_STATUS_TOKEN = undefined;
  mutable.OPS_BACKUP_BUCKET = undefined;
  const versions = await s3.send(
    new ListObjectVersionsCommand({ Bucket: config.S3_BUCKET, Prefix: dumpKey }),
  );
  const objects = (versions.Versions ?? []).map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
  if (objects.length)
    await s3.send(new DeleteObjectsCommand({ Bucket: config.S3_BUCKET, Delete: { Objects: objects } }));
  await app.close();
  await db.end();
  s3.destroy();
});

test("ops status does not exist until a token is configured, and needs that token", async () => {
  mutable.OPS_STATUS_TOKEN = undefined;
  assert.equal((await status(`Bearer ${token}`)).statusCode, 404);
  mutable.OPS_STATUS_TOKEN = token;
  assert.equal((await status()).statusCode, 404);
  assert.equal((await status(`Bearer ${token}x`)).statusCode, 404);
  const ok = await status(`Bearer ${token}`);
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
  assert.deepEqual(Object.keys(body.checks).sort(), ["backup", "database", "disk", "maintenance"]);
  assert.equal(body.checks.database.ok, true);
  // Not configured is reported, not treated as a failure.
  assert.deepEqual(body.checks.backup, { ok: null, reason: "not configured" });
});

test("ops status reports the newest backup and fails without one", async () => {
  mutable.OPS_STATUS_TOKEN = token;
  mutable.OPS_BACKUP_BUCKET = config.S3_BUCKET;
  // The test bucket holds other objects but none under postgres/ yet.
  const empty = await status(`Bearer ${token}`);
  assert.equal(empty.statusCode, 503, empty.body);
  assert.deepEqual(empty.json().checks.backup, { ok: false, reason: "no dumps" });
  await s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: dumpKey, Body: "dump" }));
  const fresh = (await status(`Bearer ${token}`)).json();
  assert.equal(fresh.checks.backup.ok, true);
  assert.ok(fresh.checks.backup.ageHours < 1, String(fresh.checks.backup.ageHours));
  mutable.OPS_BACKUP_BUCKET = undefined;
});

test("ops status fails when expired rows show maintenance has stopped", async () => {
  mutable.OPS_STATUS_TOKEN = token;
  const account = await createAccount(`ops-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  const hash = sha256(randomBytes(32).toString("base64url"));
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()-interval '1 hour')",
    [hash, account.id],
  );
  try {
    const stalled = await status(`Bearer ${token}`);
    assert.equal(stalled.statusCode, 503, stalled.body);
    assert.equal(stalled.json().checks.maintenance.ok, false);
    assert.ok(stalled.json().checks.maintenance.overdueSeconds >= 3_600);
  } finally {
    await db.query("DELETE FROM sessions WHERE hash=$1", [hash]);
  }
});
