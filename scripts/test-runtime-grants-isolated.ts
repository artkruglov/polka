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

const root = fileURLToPath(new URL("..", import.meta.url));
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (!process.argv.includes("--confirm-synthetic"))
  throw new Error(
    "Pass --confirm-synthetic to create isolated runtime-role test resources",
  );

const expectedSchema = process.argv
  .find((arg) => arg.startsWith("--expected-schema="))
  ?.slice("--expected-schema=".length);
if (expectedSchema !== String(CURRENT_SCHEMA_VERSION))
  throw new Error(
    "Pass --expected-schema=<reviewed version>; current catalog must match before creating resources",
  );

const workingDatabaseUrl = new URL(required("DATABASE_URL"));
const storageEndpoint = new URL(required("S3_ENDPOINT"));
assertPlainLoopbackUrl(workingDatabaseUrl, "Runtime-role database endpoint");
assertPlainLoopbackUrl(storageEndpoint, "Runtime-role S3 endpoint");
if (
  storageEndpoint.port !== "9038" ||
  required("S3_ACCESS_KEY") !== "polka-local"
)
  throw new Error("Runtime-role acceptance requires reviewed local storage");

const testRunId = `${new Date().toISOString().slice(2, 10).replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
if (!/^[a-z0-9]{10,24}$/.test(testRunId))
  throw new Error("Unsafe runtime-role test id");
const targetDatabase = `polka_r17_test_${testRunId}`;
const targetBucket = `polka-r17-test-${testRunId}`;
const ledgerBucket = `polka-r17-ledger-${testRunId}`;
const ledgerSentinel = `polka-r17-ledger:${testRunId}`;
const schemaOwner = `polka_schema_${testRunId}`;
const runtimeRole = `polka_runtime_${testRunId}`;
const purgeRole = `polka_purge_${testRunId}`;
const restoreRole = `polka_restore_${testRunId}`;
const ledgerReaderAccessKey = `r17${testRunId}`;
const ledgerReaderSecretKey = randomBytes(32).toString("base64url");
const ledgerReaderPolicy = `r17ro-${testRunId}`;
const mcConfigDirectory = `/tmp/polka-r17-${testRunId}`;
const mcConfigSentinel = `polka-r17-mc:${testRunId}`;
const futureTable = `runtime_future_table_${testRunId}`;
const futureFunction = `runtime_future_function_${testRunId}`;
const workingDatabase = decodeURIComponent(
  workingDatabaseUrl.pathname.slice(1),
);
if (
  targetDatabase === workingDatabase ||
  targetBucket === required("S3_BUCKET") ||
  ledgerBucket === required("S3_BUCKET") ||
  ledgerBucket === targetBucket ||
  !/^polka-r17-ledger-[a-z0-9]{10,24}$/.test(ledgerBucket) ||
  !/^polka_r17_test_[a-z0-9]{10,24}$/.test(targetDatabase) ||
  !/^polka-r17-test-[a-z0-9]{10,24}$/.test(targetBucket) ||
  !/^polka_schema_[a-z0-9]{10,24}$/.test(schemaOwner) ||
  !/^polka_runtime_[a-z0-9]{10,24}$/.test(runtimeRole) ||
  !/^polka_purge_[a-z0-9]{10,24}$/.test(purgeRole) ||
  !/^polka_restore_[a-z0-9]{10,24}$/.test(restoreRole) ||
  !/^r17[a-z0-9]{10,24}$/.test(ledgerReaderAccessKey) ||
  ledgerReaderAccessKey.length > 20 ||
  !/^r17ro-[a-z0-9]{10,24}$/.test(ledgerReaderPolicy)
)
  throw new Error("Runtime-role synthetic identities are unsafe");

const databaseUrl = (
  database: string,
  username?: string,
  password?: string,
) => {
  const value = new URL(workingDatabaseUrl);
  value.pathname = `/${database}`;
  if (username !== undefined) value.username = username;
  if (password !== undefined) value.password = password;
  return value.toString();
};
const pgOptions = (connectionString: string) => ({
  connectionString,
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});
const sentinel = `polka-r17-test:${testRunId}`;
const sentinelKey = ".polka-r17-test";
const schemaPassword = randomBytes(32).toString("base64url");
const runtimePassword = randomBytes(32).toString("base64url");
const purgePassword = randomBytes(32).toString("base64url");
const restorePassword = randomBytes(32).toString("base64url");
const schemaUrl = databaseUrl(targetDatabase, schemaOwner, schemaPassword);
const runtimeUrl = databaseUrl(targetDatabase, runtimeRole, runtimePassword);
const purgeUrl = databaseUrl(targetDatabase, purgeRole, purgePassword);
const restoreUrl = databaseUrl(targetDatabase, restoreRole, restorePassword);
const admin = new pg.Client(pgOptions(databaseUrl("postgres")));
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

async function boundedPgEnd(client: pg.Client) {
  const ending = client.end().catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    ending.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) {
    (client as any).connection?.stream?.destroy();
    await Promise.race([
      ending,
      new Promise<void>((resolve) => {
        const forced = setTimeout(resolve, 1_000);
        forced.unref();
      }),
    ]);
  }
}

async function readBucketSentinel(bucket = targetBucket) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const reading = (async () => {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: sentinelKey }),
        { abortSignal: controller.signal },
      );
      return Buffer.from(await object.Body!.transformToByteArray()).toString(
        "utf8",
      );
    })();
    return await Promise.race([
      reading,
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Synthetic sentinel read timed out"));
        }, 10_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let adminConnected = false;
let databaseCreated = false;
let bucketCreated = false;
let ledgerBucketCreated = false;
let schemaRoleCreated = false;
let runtimeRoleCreated = false;
let purgeRoleCreated = false;
let restoreRoleCreated = false;
let ledgerReaderUserCleanupPending = false;
let ledgerReaderPolicyCleanupPending = false;
let mcConfigCleanupPending = false;
let schemaRoleOid: number | null = null;
let runtimeRoleOid: number | null = null;
let purgeRoleOid: number | null = null;
let restoreRoleOid: number | null = null;

async function databaseExists(name: string) {
  return !!(
    await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])
  ).rowCount;
}
async function role(name: string) {
  return (
    await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [name])
  ).rows[0];
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
  const owner = new pg.Client(pgOptions(schemaUrl));
  await owner.connect();
  try {
    const identity = (await owner.query("SELECT current_user,session_user"))
      .rows[0];
    if (
      identity.current_user !== schemaOwner ||
      identity.session_user !== schemaOwner
    )
      throw new Error("Migration did not use the schema-owner identity");
    await owner.query("BEGIN");
    await owner.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const { version, file } of SCHEMA_MIGRATIONS) {
      await owner.query(await readFile(migrationFileUrl(file), "utf8"));
      await owner.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        version,
      ]);
    }
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await boundedPgEnd(owner);
  }
}

type CommandResult = { code: number; stdout: string; stderr: string };
async function boundedCommand(
  command: string,
  args: string[],
  input?: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let killDeadline: NodeJS.Timeout | undefined;
    child.once("spawn", () => {
      spawned = true;
    });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 65_536) stdout += String(chunk).slice(0, 65_536);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65_536) stderr += String(chunk).slice(0, 65_536);
    });
    child.stdin.on("error", () => undefined);
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killDeadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killDeadline.unref();
    }, timeoutMs);
    deadline.unref();
    child.on("error", () => {
      if (settled || spawned) return;
      settled = true;
      clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
      reject(new Error("Bounded command failed to start"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
      resolve({
        code: timedOut || signal ? 124 : (code ?? 1),
        stdout,
        stderr,
      });
    });
    child.stdin.end(input);
  });
}

async function postgresContainer() {
  const result = await boundedCommand(
    "docker",
    ["compose", "-f", "deploy/compose.local.yml", "ps", "-q", "postgres"],
    undefined,
    10_000,
  );
  const id = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{12,64}$/.test(id))
    throw new Error("Reviewed local postgres container is unavailable");
  return id;
}

async function objectsContainer() {
  const result = await boundedCommand(
    "docker",
    ["compose", "-f", "deploy/compose.local.yml", "ps", "-q", "objects"],
    undefined,
    10_000,
  );
  const id = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{12,64}$/.test(id))
    throw new Error("Reviewed local object container is unavailable");
  return id;
}

function mcErrorCode(result: CommandResult) {
  try {
    const line = result.stdout.trim().split("\n").at(-1);
    const parsed = JSON.parse(line ?? "");
    return parsed?.error?.cause?.error?.Code as unknown;
  } catch {
    return undefined;
  }
}

async function boundedMc(script: string, args: string[], input: string) {
  const container = await objectsContainer();
  return boundedCommand(
    "docker",
    [
      "exec",
      "-i",
      container,
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5",
      "25",
      "sh",
      "-c",
      script,
      "polka-r17-mc",
      mcConfigDirectory,
      ...args,
    ],
    input,
    40_000,
  );
}

const mcPrelude = [
  "set -eu",
  'test -d "$1"',
  'test "$(cat "$1/.owner")" = "$4"',
  'export MC_CONFIG_DIR="$1"',
  "IFS= read -r ROOT_SECRET",
  'export MC_HOST_local="http://polka-local:${ROOT_SECRET}@127.0.0.1:9000"',
].join("; ");

async function createMcConfigDirectory() {
  const container = await objectsContainer();
  const preflight = await boundedCommand(
    "docker",
    [
      "exec",
      container,
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5",
      "20",
      "sh",
      "-c",
      'if [ -e "$1" ]; then printf collision; exit 17; fi',
      "polka-r17-mc-config-preflight",
      mcConfigDirectory,
    ],
    undefined,
    30_000,
  );
  if (preflight.code === 17 && preflight.stdout === "collision")
    throw new Error("Synthetic mc config directory collision");
  if (preflight.code !== 0)
    throw new Error("Synthetic mc config directory preflight was inconclusive");
  mcConfigCleanupPending = true;
  const result = await boundedCommand(
    "docker",
    [
      "exec",
      container,
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5",
      "20",
      "sh",
      "-c",
      'set -eu; umask 077; test ! -e "$1"; mkdir "$1"; chmod 700 "$1"; printf "%s" "$2" >"$1/.owner"; chmod 600 "$1/.owner"',
      "polka-r17-mc-config",
      mcConfigDirectory,
      mcConfigSentinel,
    ],
    undefined,
    30_000,
  );
  if (result.code !== 0)
    throw new Error(
      "Synthetic mc config directory collision or creation failure",
    );
}

async function provisionLedgerReader() {
  if ((await readBucketSentinel(ledgerBucket)) !== ledgerSentinel)
    throw new Error("Ledger bucket sentinel changed before IAM provisioning");
  const user = await boundedMc(
    `${mcPrelude}; exec mc --json admin user info local "$2"`,
    [ledgerReaderAccessKey, "unused", mcConfigSentinel],
    `${required("S3_SECRET_KEY")}\n`,
  );
  if (user.code === 0)
    throw new Error("Synthetic ledger reader user collision");
  if (mcErrorCode(user) !== "XMinioAdminNoSuchUser")
    throw new Error("Ledger reader user preflight was inconclusive");
  const policy = await boundedMc(
    `${mcPrelude}; exec mc --json admin policy info local "$2"`,
    [ledgerReaderPolicy, "unused", mcConfigSentinel],
    `${required("S3_SECRET_KEY")}\n`,
  );
  if (policy.code === 0)
    throw new Error("Synthetic ledger reader policy collision");
  if (mcErrorCode(policy) !== "XMinioAdminNoSuchPolicy")
    throw new Error("Ledger reader policy preflight was inconclusive");

  const policyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListBucketVersions"],
        Resource: [`arn:aws:s3:::${ledgerBucket}`],
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObjectVersion"],
        Resource: [`arn:aws:s3:::${ledgerBucket}/*`],
      },
    ],
  });
  ledgerReaderPolicyCleanupPending = true;
  const createdPolicy = await boundedMc(
    `${mcPrelude}; POLICY="$1/policy.json"; cat >"$POLICY"; chmod 600 "$POLICY"; mc admin policy create local "$2" "$POLICY" >/dev/null`,
    [ledgerReaderPolicy, "unused", mcConfigSentinel],
    `${required("S3_SECRET_KEY")}\n${policyDocument}`,
  );
  if (createdPolicy.code !== 0)
    throw new Error("Ledger reader policy creation failed");

  ledgerReaderUserCleanupPending = true;
  const createdUser = await boundedMc(
    `${mcPrelude}; IFS= read -r READER_SECRET; printf '%s\\n%s\\n' "$2" "$READER_SECRET" | mc admin user add local >/dev/null`,
    [ledgerReaderAccessKey, "unused", mcConfigSentinel],
    `${required("S3_SECRET_KEY")}\n${ledgerReaderSecretKey}\n`,
  );
  if (createdUser.code !== 0)
    throw new Error("Ledger reader user creation failed");
  const attached = await boundedMc(
    `${mcPrelude}; mc admin policy attach local "$2" --user "$3" >/dev/null`,
    [ledgerReaderPolicy, ledgerReaderAccessKey, mcConfigSentinel],
    `${required("S3_SECRET_KEY")}\n`,
  );
  if (attached.code !== 0)
    throw new Error("Ledger reader policy attachment failed");
}

async function cleanupLedgerReader() {
  const errors: string[] = [];
  if (ledgerReaderUserCleanupPending) {
    const removed = await boundedMc(
      `${mcPrelude}; mc --json admin user remove local "$2"`,
      [ledgerReaderAccessKey, "unused", mcConfigSentinel],
      `${required("S3_SECRET_KEY")}\n`,
    );
    if (removed.code !== 0 && mcErrorCode(removed) !== "XMinioAdminNoSuchUser")
      errors.push("ledger-reader-user");
  }
  if (ledgerReaderPolicyCleanupPending) {
    const removed = await boundedMc(
      `${mcPrelude}; mc --json admin policy remove local "$2"`,
      [ledgerReaderPolicy, "unused", mcConfigSentinel],
      `${required("S3_SECRET_KEY")}\n`,
    );
    if (
      removed.code !== 0 &&
      mcErrorCode(removed) !== "XMinioAdminNoSuchPolicy"
    )
      errors.push("ledger-reader-policy");
  }
  if (ledgerReaderUserCleanupPending) {
    const absent = await boundedMc(
      `${mcPrelude}; exec mc --json admin user info local "$2"`,
      [ledgerReaderAccessKey, "unused", mcConfigSentinel],
      `${required("S3_SECRET_KEY")}\n`,
    );
    if (absent.code === 0 || mcErrorCode(absent) !== "XMinioAdminNoSuchUser")
      errors.push("ledger-reader-user-readback");
  }
  if (ledgerReaderPolicyCleanupPending) {
    const absent = await boundedMc(
      `${mcPrelude}; exec mc --json admin policy info local "$2"`,
      [ledgerReaderPolicy, "unused", mcConfigSentinel],
      `${required("S3_SECRET_KEY")}\n`,
    );
    if (absent.code === 0 || mcErrorCode(absent) !== "XMinioAdminNoSuchPolicy")
      errors.push("ledger-reader-policy-readback");
  }
  if (mcConfigCleanupPending) {
    const container = await objectsContainer();
    const wiped = await boundedCommand(
      "docker",
      [
        "exec",
        container,
        "timeout",
        "-s",
        "TERM",
        "-k",
        "5",
        "20",
        "sh",
        "-c",
        'set -eu; if [ ! -e "$1" ]; then exit 0; fi; test -d "$1"; test "$(cat "$1/.owner")" = "$2"; rm -rf -- "$1"; test ! -e "$1"',
        "polka-r17-mc-cleanup",
        mcConfigDirectory,
        mcConfigSentinel,
      ],
      undefined,
      30_000,
    );
    if (wiped.code !== 0) errors.push("ledger-reader-config");
    const absent = await boundedCommand(
      "docker",
      [
        "exec",
        container,
        "timeout",
        "-s",
        "TERM",
        "-k",
        "5",
        "20",
        "sh",
        "-c",
        'test ! -e "$1"',
        "polka-r17-mc-config-readback",
        mcConfigDirectory,
      ],
      undefined,
      30_000,
    );
    if (absent.code !== 0) errors.push("ledger-reader-config-readback");
  }
  if (errors.length) throw new Error(errors.join(","));
}

async function applyExactRuntimeRecipe() {
  const container = await postgresContainer();
  const recipe = await readFile(
    new URL("../deploy/runtime-grants.sql", import.meta.url),
    "utf8",
  );
  const shell = [
    "unset PGPASSWORD PGSERVICE PGSERVICEFILE;",
    "export PGCONNECT_TIMEOUT=5;",
    "export PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=5000';",
    "IFS= read -r PGPASSWORD || exit 97; export PGPASSWORD;",
    'exec psql -X --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$1" --dbname="$2" --set="schema_owner=$1" --set="runtime_role=$3"',
  ].join(" ");
  const result = await boundedCommand(
    "docker",
    [
      "exec",
      "-i",
      container,
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5",
      "25",
      "sh",
      "-c",
      shell,
      "runtime-grants",
      schemaOwner,
      targetDatabase,
      runtimeRole,
    ],
    `${schemaPassword}\n${recipe}`,
    40_000,
  );
  if (result.code !== 0) throw new Error("Exact runtime grants recipe failed");
}

async function applyExactPurgeRecipe() {
  const container = await postgresContainer();
  const recipe = await readFile(
    new URL("../deploy/purge-worker-grants.sql", import.meta.url),
    "utf8",
  );
  const shell = [
    "unset PGPASSWORD PGSERVICE PGSERVICEFILE;",
    "export PGCONNECT_TIMEOUT=5;",
    "export PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=5000';",
    "IFS= read -r PGPASSWORD || exit 97; export PGPASSWORD;",
    'exec psql -X --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$1" --dbname="$2" --set="schema_owner=$1" --set="worker_role=$3"',
  ].join(" ");
  const result = await boundedCommand(
    "docker",
    [
      "exec",
      "-i",
      container,
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5",
      "25",
      "sh",
      "-c",
      shell,
      "purge-grants",
      schemaOwner,
      targetDatabase,
      purgeRole,
    ],
    `${schemaPassword}\n${recipe}`,
    40_000,
  );
  if (result.code !== 0) throw new Error("Exact purge grants recipe failed");
}

async function applyExactRestoreRecipe() {
  const container = await postgresContainer();
  const recipe = await readFile(
    new URL("../deploy/restore-worker-grants.sql", import.meta.url),
    "utf8",
  );
  const shell = [
    "unset PGPASSWORD PGSERVICE PGSERVICEFILE;",
    "export PGCONNECT_TIMEOUT=5;",
    "export PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=5000';",
    "IFS= read -r PGPASSWORD || exit 97; export PGPASSWORD;",
    'exec psql -X --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$1" --dbname="$2" --set="schema_owner=$1" --set="worker_role=$3" --set="runtime_role=$4" --set="restore_role=$5"',
  ].join(" ");
  const result = await boundedCommand(
    "docker",
    [
      "exec",
      "-i",
      container,
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5",
      "25",
      "sh",
      "-c",
      shell,
      "restore-grants",
      schemaOwner,
      targetDatabase,
      purgeRole,
      runtimeRole,
      restoreRole,
    ],
    `${schemaPassword}\n${recipe}`,
    40_000,
  );
  if (result.code !== 0) throw new Error("Exact restore grants recipe failed");
}

async function createFutureAclProbes() {
  const owner = new pg.Client(pgOptions(schemaUrl));
  await owner.connect();
  try {
    await owner.query(`CREATE TABLE public."${futureTable}"(id integer)`);
    await owner.query(
      `CREATE FUNCTION public."${futureFunction}"() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
    );
  } finally {
    await boundedPgEnd(owner);
  }
}

async function spawnTestWithEnv(
  file: string,
  extraEnv: Record<string, string>,
  timeoutMs: number,
) {
  const testPath = fileURLToPath(new URL(file, import.meta.url));
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", testPath],
      {
        cwd: root,
        env: { ...process.env, ...extraEnv },
        stdio: "inherit",
      },
    );
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let killDeadline: NodeJS.Timeout | undefined;
    child.once("spawn", () => {
      spawned = true;
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killDeadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killDeadline.unref();
    }, timeoutMs);
    deadline.unref();
    child.on("error", () => {
      if (settled || spawned) return;
      settled = true;
      clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
      reject(new Error("Synthetic child failed to start"));
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

async function verifyDatabaseSentinel() {
  const row = (
    await admin.query(
      "SELECT shobj_description(oid,'pg_database') AS value FROM pg_database WHERE datname=$1",
      [targetDatabase],
    )
  ).rows[0];
  return row?.value === sentinel;
}
async function verifyBucketSentinel(bucket: string, expectedSentinel: string) {
  try {
    return (await readBucketSentinel(bucket)) === expectedSentinel;
  } catch {
    return false;
  }
}
async function cleanupBucket(
  bucket: string,
  expectedSentinel: string,
  created: boolean,
) {
  if (!created) return;
  if (!(await verifyBucketSentinel(bucket, expectedSentinel)))
    throw new Error("Unrecognized synthetic bucket");
  for (let pass = 0; pass < 100; pass++) {
    const listed = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
    );
    if (typeof listed.IsTruncated !== "boolean")
      throw new Error("Incomplete cleanup listing");
    const objects = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ];
    if (!objects.length && listed.IsTruncated)
      throw new Error("Incomplete cleanup page");
    if (!objects.length) {
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      return;
    }
    for (const object of objects)
      if (object.Key && object.VersionId && object.VersionId !== "null")
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: object.Key,
            VersionId: object.VersionId,
          }),
        );
  }
  throw new Error("Synthetic bucket cleanup exceeded its pass bound");
}
async function cleanupDatabase() {
  if (!databaseCreated) return;
  if (!(await verifyDatabaseSentinel()))
    throw new Error("Unrecognized synthetic database");
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [targetDatabase],
  );
  await admin.query(`DROP DATABASE "${targetDatabase}"`);
}
async function cleanupRole(
  name: string,
  expectedOid: number | null,
  created: boolean,
) {
  if (!created) return;
  const current = await role(name);
  if (!expectedOid || !current || Number(current.oid) !== expectedOid)
    throw new Error("Unrecognized synthetic role");
  const memberships = await admin.query(
    "SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1",
    [expectedOid],
  );
  if (memberships.rowCount) throw new Error("Synthetic role has memberships");
  await admin.query(`DROP ROLE "${name}"`);
}

let recipeApplied = false;
let roleAssertionsPassed = false;
let purgeAssertionsPassed = false;
let mailRacePassed = false;
let restoreAssertionsPassed = false;
let purgeRestoreS3Passed = false;
let restoreTargetOperationalPassed = false;
let ledgerReaderResidueRemoved = false;
let appFlowPassed = false;
let residueRemoved = false;
let failed = false;
let failureStage = "setup";
try {
  await admin.connect();
  adminConnected = true;
  if (
    (await databaseExists(targetDatabase)) ||
    (await bucketExists(targetBucket)) ||
    (await bucketExists(ledgerBucket)) ||
    (await role(schemaOwner)) ||
    (await role(runtimeRole)) ||
    (await role(purgeRole)) ||
    (await role(restoreRole))
  )
    throw new Error("Synthetic runtime-role identity collision");

  await admin.query(
    `CREATE ROLE "${schemaOwner}" LOGIN PASSWORD '${schemaPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  schemaRoleCreated = true;
  schemaRoleOid = Number((await role(schemaOwner)).oid);
  await admin.query(
    `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  runtimeRoleCreated = true;
  runtimeRoleOid = Number((await role(runtimeRole)).oid);
  await admin.query(
    `CREATE ROLE "${purgeRole}" LOGIN PASSWORD '${purgePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  purgeRoleCreated = true;
  purgeRoleOid = Number((await role(purgeRole)).oid);
  await admin.query(
    `CREATE ROLE "${restoreRole}" LOGIN PASSWORD '${restorePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  restoreRoleCreated = true;
  restoreRoleOid = Number((await role(restoreRole)).oid);
  await admin.query(
    `CREATE DATABASE "${targetDatabase}" OWNER "${schemaOwner}"`,
  );
  databaseCreated = true;
  await admin.query(`COMMENT ON DATABASE "${targetDatabase}" IS '${sentinel}'`);
  await admin.query(`REVOKE ALL ON DATABASE "${targetDatabase}" FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT ON DATABASE "${targetDatabase}" TO "${schemaOwner}","${runtimeRole}","${purgeRole}","${restoreRole}"`,
  );
  await admin.query(
    `ALTER ROLE "${runtimeRole}" IN DATABASE "${targetDatabase}" SET search_path TO pg_catalog,public`,
  );
  await admin.query(
    `ALTER ROLE "${purgeRole}" IN DATABASE "${targetDatabase}" SET search_path TO pg_catalog,public`,
  );
  await admin.query(
    `ALTER ROLE "${restoreRole}" IN DATABASE "${targetDatabase}" SET search_path TO pg_catalog,public`,
  );
  const setup = new pg.Client(pgOptions(databaseUrl(targetDatabase)));
  await setup.connect();
  try {
    await setup.query(`ALTER SCHEMA public OWNER TO "${schemaOwner}"`);
    await setup.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  } finally {
    await boundedPgEnd(setup);
  }

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

  await s3.send(new CreateBucketCommand({ Bucket: ledgerBucket }));
  ledgerBucketCreated = true;
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: ledgerBucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const ledgerMarker = await s3.send(
    new PutObjectCommand({
      Bucket: ledgerBucket,
      Key: sentinelKey,
      Body: ledgerSentinel,
      ContentType: "text/plain",
    }),
  );
  if (!ledgerMarker.VersionId || ledgerMarker.VersionId === "null")
    throw new Error("Synthetic ledger versioning unavailable");

  failureStage = "migration";
  await applyMigrations();
  failureStage = "recipe";
  await applyExactRuntimeRecipe();
  await applyExactPurgeRecipe();
  await applyExactRestoreRecipe();
  recipeApplied = true;
  failureStage = "ledger-reader-provision";
  await createMcConfigDirectory();
  await provisionLedgerReader();
  await createFutureAclProbes();
  failureStage = "runtime-tests";
  const common = { DATABASE_URL: runtimeUrl };
  const roleCode = await spawnTestWithEnv(
    "../tests/runtime-grants.test.ts",
    {
      ...common,
      RUNTIME_GRANTS_TEST_RUN_ID: testRunId,
      RUNTIME_GRANTS_SCHEMA_OWNER: schemaOwner,
      RUNTIME_GRANTS_RUNTIME_ROLE: runtimeRole,
      RUNTIME_GRANTS_FUTURE_TABLE: futureTable,
      RUNTIME_GRANTS_FUTURE_FUNCTION: futureFunction,
    },
    60_000,
  );
  roleAssertionsPassed = roleCode === 0;
  if (!roleAssertionsPassed) throw new Error("Runtime grant assertions failed");
  failureStage = "purge-worker-tests";
  const purgeCode = await spawnTestWithEnv(
    "../tests/account-purge-sql.test.ts",
    {
      DATABASE_URL: purgeUrl,
      PURGE_TEST_RUN_ID: testRunId,
      PURGE_TEST_WORKER_ROLE: purgeRole,
      PURGE_TEST_OWNER_DATABASE_URL: schemaUrl,
    },
    60_000,
  );
  purgeAssertionsPassed = purgeCode === 0;
  if (!purgeAssertionsPassed) throw new Error("Purge worker assertions failed");
  failureStage = "mail-race";
  const mailCode = await spawnTestWithEnv(
    "../tests/email-purge-race.test.ts",
    {
      DATABASE_URL: runtimeUrl,
      PURGE_TEST_WORKER_DATABASE_URL: purgeUrl,
      PURGE_TEST_OWNER_DATABASE_URL: schemaUrl,
      EMAIL_PURGE_TEST_RUN_ID: testRunId,
    },
    60_000,
  );
  mailRacePassed = mailCode === 0;
  if (!mailRacePassed) throw new Error("Local mail race assertions failed");
  failureStage = "restore-sql";
  const restoreCode = await spawnTestWithEnv(
    "../tests/erasure-restore-sql.test.ts",
    {
      DATABASE_URL: restoreUrl,
      RESTORE_TEST_RUN_ID: testRunId,
      RESTORE_TEST_OWNER_DATABASE_URL: schemaUrl,
      RESTORE_TEST_PURGE_DATABASE_URL: purgeUrl,
      RESTORE_TEST_RUNTIME_DATABASE_URL: runtimeUrl,
    },
    60_000,
  );
  restoreAssertionsPassed = restoreCode === 0;
  if (!restoreAssertionsPassed)
    throw new Error("Restore SQL assertions failed");
  failureStage = "purge-restore-s3";
  const s3Code = await spawnTestWithEnv(
    "../tests/account-purge-restore-s3.test.ts",
    {
      DATABASE_URL: purgeUrl,
      PURGE_RESTORE_TEST_RUN_ID: testRunId,
      PURGE_RESTORE_TEST_CONTENT_BUCKET: targetBucket,
      PURGE_RESTORE_TEST_LEDGER_BUCKET: ledgerBucket,
      PURGE_RESTORE_TEST_OWNER_DATABASE_URL: schemaUrl,
      PURGE_RESTORE_TEST_RESTORE_DATABASE_URL: restoreUrl,
      PURGE_RESTORE_TEST_RUNTIME_DATABASE_URL: runtimeUrl,
      S3_ENDPOINT: storageEndpoint.toString(),
      S3_ACCESS_KEY: required("S3_ACCESS_KEY"),
      S3_SECRET_KEY: required("S3_SECRET_KEY"),
      S3_BUCKET: targetBucket,
    },
    180_000,
  );
  purgeRestoreS3Passed = s3Code === 0;
  if (!purgeRestoreS3Passed)
    throw new Error("Real S3 purge/restore assertions failed");
  failureStage = "restore-target-operational";
  const restoreTargetCode = await spawnTestWithEnv(
    "../tests/restore-target-integration.test.ts",
    {
      DATABASE_URL: runtimeUrl,
      RESTORE_TARGET_TEST_RUN_ID: testRunId,
      RESTORE_TARGET_TEST_OWNER_DATABASE_URL: schemaUrl,
      RESTORE_TARGET_TEST_RESTORE_DATABASE_URL: restoreUrl,
      RESTORE_TARGET_TEST_CONTENT_BUCKET: targetBucket,
      RESTORE_TARGET_TEST_LEDGER_BUCKET: ledgerBucket,
      RESTORE_TARGET_TEST_LEDGER_ACCESS_KEY: ledgerReaderAccessKey,
      RESTORE_TARGET_TEST_LEDGER_SECRET_KEY: ledgerReaderSecretKey,
      S3_ENDPOINT: storageEndpoint.toString(),
      S3_ACCESS_KEY: required("S3_ACCESS_KEY"),
      S3_SECRET_KEY: required("S3_SECRET_KEY"),
      S3_BUCKET: targetBucket,
    },
    150_000,
  );
  restoreTargetOperationalPassed = restoreTargetCode === 0;
  if (!restoreTargetOperationalPassed)
    throw new Error("Operational restore target assertions failed");
  failureStage = "runtime-app";
  const appCode = await spawnTestWithEnv(
    "../tests/account-deletion.test.ts",
    {
      ...common,
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
      ACCOUNT_DELETION_POLICY_VERSION: "local-runtime-role-v1",
      R17_TEST_RUN_ID: testRunId,
      RUNTIME_GRANTS_EXPECT_ROLE: runtimeRole,
    },
    150_000,
  );
  appFlowPassed = appCode === 0;
  if (!appFlowPassed) throw new Error("Runtime app flow failed");
} catch {
  failed = true;
} finally {
  const cleanupErrors: string[] = [];
  try {
    await cleanupLedgerReader();
    ledgerReaderResidueRemoved = true;
  } catch {
    cleanupErrors.push("ledger-reader");
  }
  try {
    await cleanupBucket(targetBucket, sentinel, bucketCreated);
  } catch {
    cleanupErrors.push("bucket");
  }
  try {
    await cleanupBucket(ledgerBucket, ledgerSentinel, ledgerBucketCreated);
  } catch {
    cleanupErrors.push("ledger-bucket");
  }
  try {
    if (adminConnected) await cleanupDatabase();
  } catch {
    cleanupErrors.push("database");
  }
  try {
    if (adminConnected)
      await cleanupRole(restoreRole, restoreRoleOid, restoreRoleCreated);
  } catch {
    cleanupErrors.push("restore-role");
  }
  try {
    if (adminConnected)
      await cleanupRole(purgeRole, purgeRoleOid, purgeRoleCreated);
  } catch {
    cleanupErrors.push("purge-role");
  }
  try {
    if (adminConnected)
      await cleanupRole(runtimeRole, runtimeRoleOid, runtimeRoleCreated);
  } catch {
    cleanupErrors.push("runtime-role");
  }
  try {
    if (adminConnected)
      await cleanupRole(schemaOwner, schemaRoleOid, schemaRoleCreated);
  } catch {
    cleanupErrors.push("schema-role");
  }
  if (!cleanupErrors.length && adminConnected) {
    const remains =
      (await databaseExists(targetDatabase)) ||
      (await bucketExists(targetBucket)) ||
      (await bucketExists(ledgerBucket)) ||
      !!(await role(schemaOwner)) ||
      !!(await role(runtimeRole)) ||
      !!(await role(purgeRole)) ||
      !!(await role(restoreRole));
    residueRemoved = !remains;
    if (remains) cleanupErrors.push("residue");
  }
  if (adminConnected) await boundedPgEnd(admin);
  s3.destroy();
  if (cleanupErrors.length) {
    failed = true;
    failureStage = `cleanup:${cleanupErrors.join(",")}`;
  }
}

const evidence = {
  event: "runtime-grants.synthetic.completed",
  schemaVersion: CURRENT_SCHEMA_VERSION,
  recipeApplied,
  runtimeIdentityExact: roleAssertionsPassed,
  ownerBypassAbsent: roleAssertionsPassed && appFlowPassed,
  directDenials: roleAssertionsPassed,
  purgeWorkerExact: purgeAssertionsPassed,
  mailRacePassed,
  restoreWorkerExact: restoreAssertionsPassed,
  purgeRestoreS3Passed,
  restoreTargetOperationalPassed,
  ledgerReaderReadOnly: restoreTargetOperationalPassed,
  ledgerReaderResidueRemoved,
  defaultAclDenials: roleAssertionsPassed,
  appFlowPassed,
  triggerAndCascadePassed: roleAssertionsPassed && appFlowPassed,
  syntheticResidueRemoved: residueRemoved,
  workingResourcesUsed: false,
  productionRoleModelProven: false,
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (failed)
  throw new Error(`Synthetic runtime grants failed (${failureStage})`);
