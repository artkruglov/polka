import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import pg from "pg";
import type { RevokeRecord } from "../packages/erasure-ledger.ts";
import { EXPECTED_MIGRATION_VERSIONS } from "../packages/migrations.ts";
import {
  ledgerManifestSha256,
  sha256Hex,
} from "../packages/restore-receipt.ts";
import { appendErasureRecord } from "../scripts/erasure-ledger-adapter.ts";
import { createErasureLedgerS3Transport } from "../scripts/erasure-ledger-s3.ts";
import { loadErasureRestorePlan } from "../scripts/erasure-restore.ts";

const root = path.resolve(import.meta.dirname, "..");
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const runId = required("RESTORE_TARGET_TEST_RUN_ID");
const runtimeDatabaseUrl = required("DATABASE_URL");
const restoreDatabaseUrl = required("RESTORE_TARGET_TEST_RESTORE_DATABASE_URL");
const ownerDatabaseUrl = required("RESTORE_TARGET_TEST_OWNER_DATABASE_URL");
const endpoint = required("S3_ENDPOINT");
const contentBucket = required("RESTORE_TARGET_TEST_CONTENT_BUCKET");
const ledgerBucket = required("RESTORE_TARGET_TEST_LEDGER_BUCKET");
const ledgerAccessKey = required("RESTORE_TARGET_TEST_LEDGER_ACCESS_KEY");
const ledgerSecretKey = required("RESTORE_TARGET_TEST_LEDGER_SECRET_KEY");
const contentAccessKey = required("S3_ACCESS_KEY");
const contentSecretKey = required("S3_SECRET_KEY");
const expectedDatabase = `polka_r17_test_${runId}`;
const urls = {
  runtime: new URL(runtimeDatabaseUrl),
  restore: new URL(restoreDatabaseUrl),
  owner: new URL(ownerDatabaseUrl),
};
const s3Url = new URL(endpoint);
if (
  !/^[a-z0-9]{10,24}$/.test(runId) ||
  contentBucket !== `polka-r17-test-${runId}` ||
  ledgerBucket !== `polka-r17-ledger-${runId}` ||
  ledgerAccessKey !== `r17${runId}` ||
  ledgerAccessKey === contentAccessKey ||
  urls.runtime.username !== `polka_runtime_${runId}` ||
  urls.restore.username !== `polka_restore_${runId}` ||
  urls.owner.username !== `polka_schema_${runId}` ||
  Object.values(urls).some(
    (url) =>
      decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase ||
      url.hostname !== urls.runtime.hostname ||
      url.port !== urls.runtime.port ||
      !!url.search ||
      !!url.hash ||
      !["127.0.0.1", "localhost"].includes(url.hostname),
  ) ||
  s3Url.port !== "9038" ||
  !["127.0.0.1", "localhost"].includes(s3Url.hostname) ||
  !!s3Url.search ||
  !!s3Url.hash ||
  contentAccessKey !== "polka-local"
)
  throw new Error(
    "Restore target integration requires exact synthetic resources",
  );

type ChildResult = { code: number; stderr: string };
const liveChildren = new Set<ChildProcess>();

function trackChild(child: ChildProcess) {
  liveChildren.add(child);
  child.once("close", () => liveChildren.delete(child));
  // An error is not proof that the OS process has exited. Keep it tracked
  // until close and retain a sanitized listener for late child errors.
  child.on("error", () => undefined);
  return child;
}

async function terminateChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1_500);
    force.unref();
    child.once("close", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function drainChildren() {
  await Promise.allSettled([...liveChildren].map(terminateChild));
}

let stopping = false;
const stopFixture = () => {
  if (stopping) return;
  stopping = true;
  void drainChildren().finally(() => process.exit(143));
};
process.once("SIGINT", stopFixture);
process.once("SIGTERM", stopFixture);

function spawnNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  stderr: "pipe" | "ignore",
) {
  if (stopping) throw new Error("Synthetic fixture is stopping");
  return trackChild(
    spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", stderr],
    }),
  );
}

function boundedChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawnNode(args, env, "pipe");
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192);
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      killTimer.unref();
    }, timeoutMs);
    deadline.unref();
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: signal ? 124 : (code ?? 1), stderr });
    });
  });
}

async function boundedPgEnd(client: pg.Client) {
  const ending = client.end().then(
    () => true,
    () => true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    ending,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 3_000);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) {
    (client as any).connection?.stream?.destroy?.();
    const forced = await Promise.race([
      ending,
      new Promise<false>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 1_000);
        timeout.unref();
      }),
    ]);
    if (!forced) throw new Error("Synthetic database client did not close");
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function providerStatus(error: unknown) {
  return typeof error === "object" && error !== null
    ? (error as any).$metadata?.httpStatusCode
    : undefined;
}

function isAccessDenied(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; Code?: unknown };
  return (
    providerStatus(error) === 403 &&
    (value.name === "AccessDenied" || value.Code === "AccessDenied")
  );
}

async function stopChild(child: ChildProcess) {
  await terminateChild(child);
}

async function boundedBody(body: unknown) {
  if (
    !body ||
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray !==
      "function"
  )
    throw new Error("Synthetic storage body is unreadable");
  const readable = body as {
    transformToByteArray: () => Promise<Uint8Array>;
    destroy?: () => void;
  };
  const pending = Promise.resolve().then(() => readable.transformToByteArray());
  void pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic storage body timed out")),
          3_000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    readable.destroy?.();
  }
}

async function waitForHealth(port: number, child: ChildProcess) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Application exited before health check");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The listener has not opened yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Application did not open its health listener");
}

function appEnvironment(input: {
  port: number;
  receiptPath: string;
  restoreRunId: string;
  backupSha256: string;
  ledgerId: string;
  ledgerManifestSha256: string;
  bucket?: string;
}) {
  return {
    DATABASE_URL: runtimeDatabaseUrl,
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: contentAccessKey,
    S3_SECRET_KEY: contentSecretKey,
    S3_BUCKET: input.bucket ?? contentBucket,
    LINK_KEY: randomBytes(64).toString("base64url"),
    APP_ORIGIN: `http://127.0.0.1:${input.port}`,
    HOST: "127.0.0.1",
    PORT: String(input.port),
    COOKIE_SECURE: "false",
    MAIL_MODE: "disabled",
    HTML_LIVE_ENABLED: "false",
    ACCOUNT_DELETION_ENABLED: "false",
    RESTORE_MODE: "required",
    RESTORE_RECEIPT_PATH: input.receiptPath,
    RESTORE_RUN_ID: input.restoreRunId,
    RESTORE_BACKUP_SHA256: input.backupSha256,
    RESTORE_LEDGER_ID: input.ledgerId,
    RESTORE_LEDGER_MANIFEST_SHA256: input.ledgerManifestSha256,
    PATH: process.env.PATH,
  } satisfies NodeJS.ProcessEnv;
}

test(
  "operational restore CLI reconciles stale state and gates real startup",
  { timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `polka-restore-target-${runId}-`),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const backupDirectory = path.join(directory, "backup");
    const receiptDirectory = path.join(directory, "receipt");
    await mkdir(backupDirectory, { mode: 0o700 });
    await mkdir(receiptDirectory, { mode: 0o700 });
    const backupPath = path.join(backupDirectory, "backup.json");
    const receiptPath = path.join(receiptDirectory, "completion.json");

    const adminStorage = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 1_000,
        requestTimeout: 3_000,
      }),
      credentials: {
        accessKeyId: contentAccessKey,
        secretAccessKey: contentSecretKey,
      },
    });
    t.after(() => adminStorage.destroy());
    const sentinelBody = async (bucket: string) => {
      const result = await adminStorage.send(
        new GetObjectCommand({ Bucket: bucket, Key: ".polka-r17-test" }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
      return Buffer.from(await boundedBody(result.Body)).toString("utf8");
    };
    assert.equal(await sentinelBody(contentBucket), `polka-r17-test:${runId}`);
    assert.equal(await sentinelBody(ledgerBucket), `polka-r17-ledger:${runId}`);

    const owner = new pg.Client({
      connectionString: ownerDatabaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
    });
    await owner.connect();
    let ownerClosed = false;
    t.after(async () => {
      if (!ownerClosed) await boundedPgEnd(owner);
    });
    assert.deepEqual(
      (
        await owner.query(
          `SELECT current_user,session_user,current_database(),shobj_description(oid,'pg_database') AS sentinel FROM pg_database WHERE datname=current_database()`,
        )
      ).rows[0],
      {
        current_user: `polka_schema_${runId}`,
        session_user: `polka_schema_${runId}`,
        current_database: expectedDatabase,
        sentinel: `polka-r17-test:${runId}`,
      },
    );

    const ledgerReader = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 1_000,
        requestTimeout: 3_000,
      }),
      credentials: {
        accessKeyId: ledgerAccessKey,
        secretAccessKey: ledgerSecretKey,
      },
    });
    t.after(() => ledgerReader.destroy());
    const listed = await ledgerReader.send(
      new ListObjectVersionsCommand({ Bucket: ledgerBucket, MaxKeys: 100 }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
    assert.equal(listed.IsTruncated, false);
    const sentinel = listed.Versions?.find(
      (value) => value.Key === ".polka-r17-test",
    );
    assert.ok(sentinel?.VersionId && sentinel.VersionId !== "null");
    const read = await ledgerReader.send(
      new GetObjectCommand({
        Bucket: ledgerBucket,
        Key: sentinel.Key,
        VersionId: sentinel.VersionId,
      }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
    await boundedBody(read.Body);
    await assert.rejects(
      ledgerReader.send(
        new PutObjectCommand({
          Bucket: ledgerBucket,
          Key: "denied",
          Body: "x",
        }),
        { abortSignal: AbortSignal.timeout(3_000) },
      ),
      isAccessDenied,
    );
    await assert.rejects(
      ledgerReader.send(
        new DeleteObjectCommand({
          Bucket: ledgerBucket,
          Key: sentinel.Key,
          VersionId: sentinel.VersionId,
        }),
        { abortSignal: AbortSignal.timeout(3_000) },
      ),
      isAccessDenied,
    );
    // This MinIO release also permits latest reads with GetObjectVersion.
    // Read-only authority is tested by write/delete and other-bucket denials;
    // the restore transport itself always pins reads to exact VersionIds.
    const latest = await ledgerReader.send(
      new GetObjectCommand({ Bucket: ledgerBucket, Key: sentinel.Key }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
    assert.equal(latest.VersionId, sentinel.VersionId);
    assert.equal(
      Buffer.from(await boundedBody(latest.Body)).toString("utf8"),
      `polka-r17-ledger:${runId}`,
    );
    await assert.rejects(
      ledgerReader.send(
        new GetObjectCommand({ Bucket: contentBucket, Key: ".polka-r17-test" }),
        { abortSignal: AbortSignal.timeout(3_000) },
      ),
      isAccessDenied,
    );

    const ledgerId = randomUUID();
    const accountId = randomUUID();
    const tenantId = randomUUID();
    const deletionId = randomUUID();
    const stale = await adminStorage.send(
      new PutObjectCommand({
        Bucket: contentBucket,
        Key: `${tenantId}/restored-stale-object`,
        Body: "stale restored bytes",
      }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
    assert.ok(stale.VersionId && stale.VersionId !== "null");
    await owner.query("BEGIN");
    try {
      await owner.query(
        `INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at) VALUES($1,$2,$3,$4,$5,now())`,
        [
          accountId,
          `restore-target-${runId}`,
          `${"a".repeat(32)}:${"b".repeat(128)}`,
          `restore-target-${runId}@example.test`,
          "Stale restore owner",
        ],
      );
      await owner.query(
        "INSERT INTO tenants(id,owner_id,used_bytes,derivative_used_bytes) VALUES($1,$2,0,0)",
        [tenantId, accountId],
      );
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
    const adminLedger = createErasureLedgerS3Transport({
      client: adminStorage,
      bucket: ledgerBucket,
      bodyTimeoutMs: 3_000,
    });
    const revoke: RevokeRecord = {
      schemaVersion: 1,
      event: "revoke",
      ledgerId,
      requestId: deletionId,
      accountId,
      tenantId,
      requestedAt: "2020-09-21T10:00:00.000Z",
      revokedAt: "2020-09-21T10:00:01.000Z",
      policyVersion: "restore-target-v1",
      workingDataPolicyDeadline: "2020-09-21T11:00:00.000Z",
      backupRetentionPolicyDeadline: "2020-09-22T10:00:00.000Z",
    };
    await appendErasureRecord(
      adminLedger,
      revoke,
      ledgerId,
      AbortSignal.timeout(5_000),
    );
    const plan = await loadErasureRestorePlan(
      adminLedger,
      ledgerId,
      AbortSignal.timeout(5_000),
    );
    assert.equal(plan.entries.length, 1);
    const ledgerSha256 = ledgerManifestSha256(plan.records);
    const backupBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        schemaMigrations: EXPECTED_MIGRATION_VERSIONS,
        erasureLedgerId: ledgerId,
        localMailSpool: "absent",
      }),
    );
    await writeFile(backupPath, backupBytes, { mode: 0o600 });
    const backupSha256 = sha256Hex(backupBytes);
    await boundedPgEnd(owner);
    ownerClosed = true;

    const cliEnv = {
      DATABASE_URL: runtimeDatabaseUrl,
      RESTORE_DATABASE_URL: restoreDatabaseUrl,
      RESTORE_RUN_ID: randomUUID(),
      RESTORE_BACKUP_SHA256: backupSha256,
      RESTORE_LEDGER_MANIFEST_SHA256: ledgerSha256,
      RESTORE_BACKUP_DESCRIPTOR: backupPath,
      RESTORE_RECEIPT_PATH: receiptPath,
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY: contentAccessKey,
      S3_SECRET_KEY: contentSecretKey,
      S3_BUCKET: contentBucket,
      ERASURE_LEDGER_ID: ledgerId,
      ERASURE_LEDGER_ENDPOINT: endpoint,
      ERASURE_LEDGER_ACCESS_KEY: ledgerAccessKey,
      ERASURE_LEDGER_SECRET_KEY: ledgerSecretKey,
      ERASURE_LEDGER_BUCKET: ledgerBucket,
      PATH: process.env.PATH,
    } satisfies NodeJS.ProcessEnv;
    const cliArgs = [
      "--import",
      "tsx",
      "scripts/restore-target.ts",
      "--confirm-closed-target",
    ];
    assert.equal((await boundedChild(cliArgs, cliEnv, 30_000)).code, 0);
    const firstBytes = await readFile(receiptPath);
    const firstStat = await stat(receiptPath);
    assert.equal((await boundedChild(cliArgs, cliEnv, 30_000)).code, 0);
    assert.deepEqual(await readFile(receiptPath), firstBytes);
    assert.equal((await stat(receiptPath)).ino, firstStat.ino);

    const verifier = new pg.Client({
      connectionString: ownerDatabaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
    });
    await verifier.connect();
    try {
      assert.deepEqual(
        (
          await verifier.query(
            "SELECT email,display_name,disabled FROM accounts WHERE id=$1",
            [accountId],
          )
        ).rows[0],
        { email: null, display_name: null, disabled: true },
      );
      assert.deepEqual(
        (
          await verifier.query(
            "SELECT state FROM account_restore_suppressions WHERE restore_run_id=$1 AND deletion_id=$2",
            [cliEnv.RESTORE_RUN_ID, deletionId],
          )
        ).rows[0],
        { state: "completed" },
      );
    } finally {
      await boundedPgEnd(verifier);
    }
    const staleVersions = await adminStorage.send(
      new ListObjectVersionsCommand({
        Bucket: contentBucket,
        Prefix: `${tenantId}/`,
      }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
    assert.equal(staleVersions.IsTruncated, false);
    assert.deepEqual(staleVersions.Versions ?? [], []);
    assert.deepEqual(staleVersions.DeleteMarkers ?? [], []);

    const baseApp = {
      receiptPath,
      restoreRunId: cliEnv.RESTORE_RUN_ID!,
      backupSha256,
      ledgerId,
      ledgerManifestSha256: ledgerSha256,
    };
    for (const candidate of [
      { ...baseApp, receiptPath: path.join(receiptDirectory, "missing.json") },
      { ...baseApp, restoreRunId: randomUUID() },
      { ...baseApp, backupSha256: "f".repeat(64) },
      { ...baseApp, bucket: ledgerBucket },
    ]) {
      const port = await freePort();
      const result = await boundedChild(
        ["--import", "tsx", "apps/server/main.ts"],
        appEnvironment({ ...candidate, port }),
        8_000,
      );
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /Restore startup gate refused application startup/,
      );
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(300),
        }),
      );
    }

    const port = await freePort();
    const app = spawnNode(
      ["--import", "tsx", "apps/server/main.ts"],
      appEnvironment({ ...baseApp, port }),
      "ignore",
    );
    try {
      await waitForHealth(port, app);
    } finally {
      await stopChild(app);
    }
  },
);
