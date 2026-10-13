import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DeleteObjectsCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { readFileSync } from "node:fs";
import { OPS_LIMITS, backupAgeLimitHours } from "../apps/server/ops-status.ts";
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
  const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: config.S3_BUCKET, Prefix: dumpKey }));
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
  // Numbers to watch, not a check: memory, event loop, pool, worker slots.
  assert.ok(body.runtime.rssMiB > 0 && body.runtime.heapUsedMiB > 0);
  assert.ok(body.runtime.eventLoopMs.p99 >= 0);
  assert.deepEqual(Object.keys(body.runtime.pool).sort(), ["idle", "max", "total", "waiting"]);
  assert.deepEqual(Object.keys(body.runtime.workers).sort(), ["limit", "running", "waiting"]);
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
  assert.equal(fresh.checks.backup.limitHours, backupAgeLimitHours());
  mutable.OPS_BACKUP_BUCKET = undefined;
});

test("the backup age limit follows the backup interval: daily 26 hours, hourly 3", () => {
  assert.equal(backupAgeLimitHours(86_400), 26);
  assert.equal(backupAgeLimitHours(3_600), 3);
  assert.equal(backupAgeLimitHours(config.OPS_BACKUP_INTERVAL_SECONDS), config.OPS_BACKUP_INTERVAL_SECONDS / 3600 + 2);
  // The hosted compose passes the backup job's interval to the app.
  const compose = readFileSync(new URL("../deploy/hosted/compose.yml", import.meta.url), "utf8");
  assert.match(compose, /OPS_BACKUP_INTERVAL_SECONDS: \$\{BACKUP_INTERVAL_SECONDS:-86400\}/);
  assert.match(compose, /BACKUP_INTERVAL_SECONDS: \$\{BACKUP_INTERVAL_SECONDS:-86400\}/);
});

test("ops status fails when expired rows show maintenance has stopped", async () => {
  mutable.OPS_STATUS_TOKEN = token;
  const account = await createAccount(`ops-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  const hash = sha256(randomBytes(32).toString("base64url"));
  await db.query("INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()-interval '1 hour')", [
    hash,
    account.id,
  ]);
  try {
    const stalled = await status(`Bearer ${token}`);
    assert.equal(stalled.statusCode, 503, stalled.body);
    assert.equal(stalled.json().checks.maintenance.ok, false);
    assert.ok(stalled.json().checks.maintenance.overdueSeconds >= 3_600);
  } finally {
    await db.query("DELETE FROM sessions WHERE hash=$1", [hash]);
  }
});

test("runtime metrics for Prometheus: behind the ops token, route patterns, no URLs", async () => {
  mutable.OPS_STATUS_TOKEN = undefined;
  const scrape = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: "/api/ops/metrics/prometheus",
      headers: authorization ? { authorization } : {},
    });
  assert.equal((await scrape(`Bearer ${token}`)).statusCode, 404);
  mutable.OPS_STATUS_TOKEN = token;
  assert.equal((await scrape()).statusCode, 404);
  // A request with a token in its URL: counted under its pattern, or as unmatched.
  const secret = randomBytes(12).toString("hex");
  await app.inject({ method: "GET", url: `/api/no-such-route-${secret}` });
  await app.inject({ method: "GET", url: `/api/capabilities?token=${secret}` });
  const answer = await scrape(`Bearer ${token}`);
  assert.equal(answer.statusCode, 200, answer.body);
  assert.match(answer.headers["content-type"] as string, /^text\/plain; version=0\.0\.4/);
  const text = answer.body;
  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(text, /^# TYPE polka_http_requests_total counter$/m);
  assert.match(text, /^polka_http_requests_total\{method="GET",route="\/api\/capabilities",status="200"\} \d+$/m);
  assert.match(text, /^polka_http_requests_total\{method="GET",route="unmatched",status="404"\} \d+$/m);
  assert.match(
    text,
    /^polka_http_request_duration_seconds_bucket\{method="GET",route="\/api\/capabilities",status="200",le="\+Inf"\} \d+$/m,
  );
  assert.match(text, /^polka_db_pool_connections\{state="waiting"\} \d+$/m);
  assert.match(text, /^polka_event_loop_delay_seconds\{stat="p99"\} [\d.e-]+$/m);
  assert.match(text, /^process_resident_memory_bytes \d+$/m);
  assert.match(text, /^polka_worker_slots\{state="waiting"\} \d+$/m);
  assert.match(text, /^polka_webhook_deliveries_pending \d+$/m);
  // Every sample line is `name{labels} number`.
  for (const line of text
    .trim()
    .split("\n")
    .filter((entry) => !entry.startsWith("#")))
    assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[\d.e+-]+$/, line);
});

test("every request gets an x-request-id and one log line with its route pattern, never the URL", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  t.mock.method(console, "error", (line: string) => lines.push(line));
  // The suite runs with ACCESS_LOG=off (scripts/test-isolated.ts); the default is info.
  const settings = config as { ACCESS_LOG: string };
  const before = settings.ACCESS_LOG;
  settings.ACCESS_LOG = "info";
  t.after(() => {
    settings.ACCESS_LOG = before;
  });
  const secret = randomBytes(12).toString("hex");
  const answer = await app.inject({ method: "GET", url: `/api/capabilities?token=${secret}` });
  const id = answer.headers["x-request-id"] as string;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const line = lines.map((entry) => JSON.parse(entry)).find((entry) => entry.event === "request" && entry.reqId === id);
  assert.ok(line, lines.join("\n"));
  assert.deepEqual(
    { method: line.method, route: line.route, status: line.status, level: line.level },
    { method: "GET", route: "/api/capabilities", status: 200, level: "info" },
  );
  assert.equal(typeof line.ms, "number");
  assert.doesNotMatch(lines.join("\n"), new RegExp(secret));
  // Two requests, two ids.
  const other = await app.inject({ method: "GET", url: "/api/capabilities" });
  assert.notEqual(other.headers["x-request-id"], id);
  // ACCESS_LOG=off: no line, the header stays.
  settings.ACCESS_LOG = "off";
  lines.length = 0;
  const quiet = await app.inject({ method: "GET", url: "/api/capabilities" });
  assert.ok(quiet.headers["x-request-id"]);
  assert.equal(lines.filter((entry) => entry.includes('"event":"request"')).length, 0);
});
