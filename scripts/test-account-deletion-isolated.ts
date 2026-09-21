import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CURRENT_SCHEMA_VERSION,
  migrationFileUrl,
  SCHEMA_MIGRATIONS,
} from "../packages/migrations.ts";
import { assertPlainLoopbackUrl } from "./restore-drill-lib.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (!process.argv.includes("--confirm-synthetic"))
  throw new Error(
    "Pass --confirm-synthetic to create an isolated account deletion test target",
  );

const workingDatabaseUrl = new URL(required("DATABASE_URL"));
const storageEndpoint = new URL(required("S3_ENDPOINT"));
assertPlainLoopbackUrl(
  workingDatabaseUrl,
  "Account deletion test database endpoint",
);
assertPlainLoopbackUrl(storageEndpoint, "Account deletion test S3 endpoint");
if (
  storageEndpoint.port !== "9038" ||
  required("S3_ACCESS_KEY") !== "polka-local"
)
  throw new Error(
    "Account deletion tests require the reviewed local S3 target",
  );

const testRunId = `${new Date().toISOString().slice(2, 10).replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
if (!/^[a-z0-9]{10,24}$/.test(testRunId))
  throw new Error("Unsafe account deletion test id");
const targetDatabase = `polka_r17_test_${testRunId}`;
const targetBucket = `polka-r17-test-${testRunId}`;
const workingDatabase = decodeURIComponent(
  workingDatabaseUrl.pathname.slice(1),
);
const workingBucket = required("S3_BUCKET");
if (
  targetDatabase === workingDatabase ||
  targetBucket === workingBucket ||
  !/^polka_r17_test_[a-z0-9]{10,24}$/.test(targetDatabase) ||
  !/^polka-r17-test-[a-z0-9]{10,24}$/.test(targetBucket)
)
  throw new Error("Synthetic account deletion target is not isolated");

const databaseUrl = (database: string) => {
  const value = new URL(workingDatabaseUrl);
  value.pathname = `/${database}`;
  return value.toString();
};
const sentinel = `polka-r17-test:${testRunId}`;
const sentinelKey = ".polka-r17-test";
const s3 = new S3Client({
  endpoint: storageEndpoint.origin,
  region: "us-east-1",
  forcePathStyle: true,
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
  }),
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY"),
    secretAccessKey: required("S3_SECRET_KEY"),
  },
});
const pgOptions = (connectionString: string) => ({
  connectionString,
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});
const admin = new pg.Client(pgOptions(databaseUrl("postgres")));
let databaseCreated = false;
let bucketCreated = false;

async function databaseExists(name: string) {
  return !!(
    await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])
  ).rowCount;
}

async function bucketExists(name: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch (error: any) {
    if (error.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function applyMigrations() {
  const client = new pg.Client(pgOptions(databaseUrl(targetDatabase)));
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const { version, file } of SCHEMA_MIGRATIONS) {
      await client.query(await readFile(migrationFileUrl(file), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        version,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function verifyDatabaseSentinel() {
  const row = (
    await admin.query(
      "SELECT shobj_description(oid,'pg_database') AS value FROM pg_database WHERE datname=$1",
      [targetDatabase],
    )
  ).rows[0];
  return row?.value === sentinel;
}

async function verifyBucketSentinel() {
  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: targetBucket, Key: sentinelKey }),
    );
    return (
      Buffer.from(await object.Body!.transformToByteArray()).toString(
        "utf8",
      ) === sentinel
    );
  } catch {
    return false;
  }
}

async function cleanupDatabase() {
  if (!databaseCreated) return;
  if (!(await verifyDatabaseSentinel()))
    throw new Error("Refusing to clean an unrecognized synthetic database");
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [targetDatabase],
  );
  await admin.query(`DROP DATABASE "${targetDatabase}"`);
}

async function cleanupBucket() {
  if (!bucketCreated) return;
  if (!(await verifyBucketSentinel()))
    throw new Error("Refusing to clean an unrecognized synthetic bucket");
  for (let pass = 0; pass < 100; pass++) {
    const listed = await s3.send(
      new ListObjectVersionsCommand({ Bucket: targetBucket, MaxKeys: 1000 }),
    );
    const objects = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ];
    if (!objects.length) {
      await s3.send(new DeleteBucketCommand({ Bucket: targetBucket }));
      return;
    }
    for (const object of objects)
      if (object.Key && object.VersionId)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: targetBucket,
            Key: object.Key,
            VersionId: object.VersionId,
          }),
        );
  }
  throw new Error("Synthetic bucket cleanup exceeded its pass bound");
}

async function runTest() {
  const testFile = fileURLToPath(
    new URL("../tests/account-deletion.test.ts", import.meta.url),
  );
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", testFile],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl(targetDatabase),
          S3_BUCKET: targetBucket,
          LINK_KEY: randomBytes(64).toString("base64url"),
          APP_ORIGIN: "http://127.0.0.1:4390",
          HOST: "127.0.0.1",
          PORT: "4390",
          COOKIE_SECURE: "false",
          MAIL_MODE: "disabled",
          HTML_LIVE_ENABLED: "true",
          VIEWER_ORIGIN: "http://localhost:4391",
          VIEWER_HOST: "localhost",
          VIEWER_PORT: "4391",
          ACCOUNT_DELETION_ENABLED: "true",
          ACCOUNT_PURGE_MAX_HOURS: "24",
          BACKUP_RETENTION_MAX_DAYS: "0",
          ACCOUNT_DELETION_POLICY_VERSION: "local-r17-test-v1",
          R17_TEST_RUN_ID: testRunId,
        },
        stdio: "inherit",
      },
    );
    let timedOut = false;
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
    });
    let settled = false;
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killDeadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killDeadline.unref();
    }, 120_000);
    deadline.unref();
    child.on("error", () => {
      // After spawn, only close proves the child stopped before cleanup.
      if (settled || spawned) return;
      settled = true;
      clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
      reject(new Error("Account deletion test child failed to start"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
      resolve(timedOut || signal ? 124 : (code ?? 1));
    });
  });
}

let adminConnected = false;
let testsPassed = false;
let residueRemoved = false;
let failed = false;
let failureStage = "setup";
try {
  await admin.connect();
  adminConnected = true;
  if (
    (await databaseExists(targetDatabase)) ||
    (await bucketExists(targetBucket))
  )
    throw new Error("Synthetic account deletion target already exists");
  await admin.query(`CREATE DATABASE "${targetDatabase}"`);
  databaseCreated = true;
  await admin.query(`COMMENT ON DATABASE "${targetDatabase}" IS '${sentinel}'`);
  await s3.send(new CreateBucketCommand({ Bucket: targetBucket }));
  bucketCreated = true;
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: targetBucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const stored = await s3.send(
    new PutObjectCommand({
      Bucket: targetBucket,
      Key: sentinelKey,
      Body: sentinel,
      ContentType: "text/plain",
    }),
  );
  if (!stored.VersionId || stored.VersionId === "null")
    throw new Error("Synthetic bucket versioning is unavailable");
  failureStage = "migration";
  await applyMigrations();
  failureStage = "test";
  testsPassed = (await runTest()) === 0;
  if (!testsPassed) throw new Error("Account deletion integration test failed");
} catch {
  failed = true;
} finally {
  const cleanupErrors: string[] = [];
  try {
    await cleanupBucket();
  } catch {
    cleanupErrors.push("bucket");
  }
  try {
    if (adminConnected) await cleanupDatabase();
  } catch {
    cleanupErrors.push("database");
  }
  if (!cleanupErrors.length) {
    const databaseRemains = adminConnected
      ? await databaseExists(targetDatabase)
      : databaseCreated;
    const bucketRemains = await bucketExists(targetBucket);
    residueRemoved = !databaseRemains && !bucketRemains;
    if (!residueRemoved) cleanupErrors.push("residue");
  }
  if (adminConnected) await admin.end().catch(() => undefined);
  s3.destroy();
  if (cleanupErrors.length) {
    failed = true;
    failureStage = `cleanup:${cleanupErrors.join(",")}`;
  }
}

const evidence = {
  event: "account-deletion.synthetic.completed",
  schemaVersion: CURRENT_SCHEMA_VERSION,
  testsPassed,
  sourceBytesPreserved: testsPassed,
  neighborTenantPreserved: testsPassed,
  immediateAccessRevoked: testsPassed,
  workerReadyCommitDenied: testsPassed,
  syntheticResidueRemoved: residueRemoved,
  workingResourcesUsed: false,
  productionPurgeProven: false,
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (failed)
  throw new Error(`Synthetic account deletion run failed (${failureStage})`);
