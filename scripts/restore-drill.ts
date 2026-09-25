import { randomBytes, randomUUID, createHmac, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
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
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import {
  CURRENT_SCHEMA_VERSION,
  EXPECTED_MIGRATION_VERSIONS,
  migrationFileUrl,
  SCHEMA_MIGRATIONS,
} from "../packages/migrations.ts";
import {
  BUNDLE_BUILDER_VERSION,
  BUNDLE_RUNTIME_PROFILE,
} from "../apps/server/bundle-runtime-contract.ts";
import { createErasureLedgerS3Transport } from "./erasure-ledger-s3.ts";
import {
  assertErasureRestorePlanStable,
  loadErasureRestorePlan,
  requireBackupLedger,
  type ErasureRestorePlan,
} from "./erasure-restore.ts";
import { reconcileErasureRestore } from "./erasure-restore-reconcile.ts";
import { runAccountPurge } from "./account-purge.ts";
import {
  createMaintenanceDatabase,
  createMaintenanceObjectStore,
} from "./maintenance-adapters.ts";
import { runMaintenanceGuard } from "./maintenance-guard.ts";
import {
  assertDrillIdentity,
  assertPlainLoopbackUrl,
  assertSeparatedIdentities,
  bucketName,
  databaseName,
  decryptSecret,
  encryptSecret,
  fingerprint,
  type DrillRole,
} from "./restore-drill-lib.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const derive = promisify(scrypt);
async function syntheticPasswordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
const workingDatabaseUrl = new URL(required("DATABASE_URL"));
const s3Endpoint = new URL(required("S3_ENDPOINT"));
assertPlainLoopbackUrl(workingDatabaseUrl, "Restore drill database endpoint");
assertPlainLoopbackUrl(s3Endpoint, "Restore drill S3 endpoint");
if (!process.argv.includes("--confirm-synthetic"))
  throw new Error(
    "Pass --confirm-synthetic to create isolated drill resources",
  );

const drillId = `${new Date().toISOString().slice(2, 10).replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const names = {
  sourceDatabase: databaseName(drillId, "source"),
  targetDatabase: databaseName(drillId, "target"),
  sourceBucket: bucketName(drillId, "source"),
  targetBucket: bucketName(drillId, "target"),
  ledgerBucket: `polka-restore-${drillId}-ledger`,
};
const workingDatabase = decodeURIComponent(
  workingDatabaseUrl.pathname.slice(1),
);
const workingBucket = required("S3_BUCKET");
for (const role of ["source", "target"] as const)
  assertDrillIdentity(
    drillId,
    role,
    names[`${role}Database`],
    names[`${role}Bucket`],
  );
assertSeparatedIdentities({
  workingDatabase,
  ...names,
  workingBucket,
  sourceEndpoint: s3Endpoint.origin,
  targetEndpoint: s3Endpoint.origin,
});
if (
  !/^polka-restore-[a-z0-9]{10,24}-ledger$/.test(names.ledgerBucket) ||
  names.ledgerBucket === workingBucket ||
  names.ledgerBucket === names.sourceBucket ||
  names.ledgerBucket === names.targetBucket
)
  throw new Error("Synthetic erasure ledger identity is unsafe");

const databaseUrl = (database: string) => {
  const value = new URL(workingDatabaseUrl);
  value.pathname = `/${database}`;
  return value.toString();
};
const adminUrl = databaseUrl("postgres");
const sentinelKey = ".polka-restore-drill-sentinel";
const databaseSentinel = (role: DrillRole) =>
  `polka-restore-drill:${drillId}:${role}`;
const bucketSentinel = (role: DrillRole) =>
  Buffer.from(databaseSentinel(role), "utf8");
const ledgerSentinel = Buffer.from(
  `polka-restore-drill:${drillId}:ledger`,
  "utf8",
);

const s3 = new S3Client({
  endpoint: s3Endpoint.origin,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY"),
    secretAccessKey: required("S3_SECRET_KEY"),
  },
});

const created = {
  sourceDatabase: false,
  targetDatabase: false,
  sourceBucket: false,
  targetBucket: false,
  ledgerBucket: false,
};

async function databaseExists(client: pg.Client, name: string) {
  return !!(
    await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])
  ).rowCount;
}

async function bucketExists(bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error: any) {
    if (error.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function createDatabase(admin: pg.Client, name: string, role: DrillRole) {
  if (await databaseExists(admin, name))
    throw new Error(`Synthetic ${role} database already exists`);
  await admin.query(`CREATE DATABASE "${name}"`);
  created[`${role}Database`] = true;
  await admin.query(
    `COMMENT ON DATABASE "${name}" IS '${databaseSentinel(role)}'`,
  );
}

async function createBucket(bucket: string, role: DrillRole) {
  if (await bucketExists(bucket))
    throw new Error(`Synthetic ${role} bucket already exists`);
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  created[`${role}Bucket`] = true;
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: sentinelKey,
      Body: bucketSentinel(role),
      ContentType: "text/plain",
    }),
  );
  if (!result.VersionId || result.VersionId === "null")
    throw new Error("Synthetic bucket versioning is unavailable");
}

async function createLedgerBucket() {
  if (await bucketExists(names.ledgerBucket))
    throw new Error("Synthetic erasure ledger bucket already exists");
  await s3.send(new CreateBucketCommand({ Bucket: names.ledgerBucket }));
  created.ledgerBucket = true;
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: names.ledgerBucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: names.ledgerBucket,
      Key: sentinelKey,
      Body: ledgerSentinel,
      ContentType: "text/plain",
    }),
  );
  if (!result.VersionId || result.VersionId === "null")
    throw new Error("Synthetic erasure ledger versioning is unavailable");
}

async function applyMigrations(database: string) {
  const client = new pg.Client({ connectionString: databaseUrl(database) });
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

async function put(bucket: string, key: string, bytes: Buffer) {
  const sha256 = fingerprint(bytes);
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "application/octet-stream",
      Metadata: { sha256 },
      IfNoneMatch: "*",
    }),
  );
  if (!result.VersionId || result.VersionId === "null")
    throw new Error("Versioned object write required");
  return { key, version: result.VersionId, sha256, size: bytes.length };
}

type Seed = Awaited<ReturnType<typeof seedSource>>;
async function seedSource(linkKey: string) {
  const client = new pg.Client({
    connectionString: databaseUrl(names.sourceDatabase),
  });
  await client.connect();
  const ids = {
    account: randomUUID(),
    tenant: randomUUID(),
    singleUpload: randomUUID(),
    singleArtifact: randomUUID(),
    singleRevision: randomUUID(),
    bundleUpload: randomUUID(),
    bundleArtifact: randomUUID(),
    bundleRevision: randomUUID(),
    derivative: randomUUID(),
    activeShare: randomUUID(),
    revokedShare: randomUUID(),
    connection: randomUUID(),
    liveStageUpload: randomUUID(),
    reconciledUpload: randomUUID(),
    erasureAccount: randomUUID(),
    erasureTenant: randomUUID(),
    erasureArtifact: randomUUID(),
    erasureRevision: randomUUID(),
    erasureDeletion: randomUUID(),
  };
  const single = Buffer.from(
    "<!doctype html><title>Restore single</title><p>Exact source</p>",
  );
  const bundleFiles = [
    {
      path: "index.html",
      mime: "text/html",
      bytes: Buffer.from(
        "<!doctype html><link rel=stylesheet href=style.css><h1>Restore bundle</h1><script src=app.js></script>",
      ),
    },
    {
      path: "style.css",
      mime: "text/css",
      bytes: Buffer.from("h1{color:#164}"),
    },
    {
      path: "app.js",
      mime: "text/javascript",
      bytes: Buffer.from("document.body.dataset.ready='yes'"),
    },
    {
      path: "mark.svg",
      mime: "image/svg+xml",
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" cx="4" cy="4"/></svg>',
      ),
    },
  ];
  const capturedAt = new Date().toISOString();
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    files: bundleFiles.map((file) => ({
      path: file.path,
      mime: file.mime,
      size: file.bytes.length,
      sha256: fingerprint(file.bytes),
    })),
    runtime: "preserved-only-v1",
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt,
      attribution: "Synthetic restore drill",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  });
  const manifestSha256 = fingerprint(JSON.stringify(manifest));
  const derivativeBytes = Buffer.from(
    "<!doctype html><title>Inline restore</title><p>ready</p>",
  );
  const erasureBytes = Buffer.from("old snapshot content must be suppressed");
  const singleKey = `${ids.tenant}/${ids.singleUpload}`;
  const bundleBase = `${ids.tenant}/${ids.bundleUpload}`;
  const singleObject = await put(names.sourceBucket, singleKey, single);
  const bundleObjects = [];
  for (const [index, file] of manifest.files.entries()) {
    const bytes = bundleFiles.find(
      (candidate) => candidate.path === file.path,
    )?.bytes;
    if (!bytes) throw new Error("Canonical manifest lost a synthetic file");
    bundleObjects.push(
      await put(
        names.sourceBucket,
        file.path === manifest.entrypoint
          ? bundleBase
          : `${bundleBase}/files/${index}`,
        bytes,
      ),
    );
  }
  const derivativeObject = await put(
    names.sourceBucket,
    `${ids.tenant}/derivatives/${ids.derivative}/${randomUUID()}.html`,
    derivativeBytes,
  );
  const erasureObject = await put(
    names.sourceBucket,
    `${ids.erasureTenant}/snapshot-source`,
    erasureBytes,
  );
  const stagedBytes = Buffer.from("unfinished but live staging");
  const stagedObject = await put(
    names.sourceBucket,
    `${ids.tenant}/${ids.liveStageUpload}`,
    stagedBytes,
  );
  const sessionToken = randomBytes(32).toString("base64url");
  const agentToken = randomBytes(32).toString("base64url");
  const activeToken = createHmac("sha256", linkKey)
    .update(`share:${ids.activeShare}`)
    .digest("base64url");
  const revokedToken = createHmac("sha256", linkKey)
    .update(`share:${ids.revokedShare}`)
    .digest("base64url");
  const sourceBytes =
    single.length +
    bundleFiles.reduce((sum, file) => sum + file.bytes.length, 0);
  const attemptId = randomUUID();
  const singleManifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    files: [
      {
        path: "index.html",
        mime: "text/html",
        size: single.length,
        sha256: fingerprint(single),
      },
    ],
    runtime: "static-sandbox-v1",
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt,
      attribution: "Synthetic restore drill",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  });
  const singleManifestHash = fingerprint(JSON.stringify(singleManifest));
  const ownerPassword = randomBytes(24).toString("base64url");
  const ownerPasswordHash = await syntheticPasswordHash(ownerPassword);
  const bundleKey = randomUUID();
  const captureInput = {
    key: bundleKey,
    title: "Restore bundle",
    manifest,
    files: manifest.files.map((file) => ({
      path: file.path,
      encoding: "base64" as const,
      data: bundleFiles
        .find((candidate) => candidate.path === file.path)!
        .bytes.toString("base64"),
    })),
  };
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO accounts(id,name,password_hash) VALUES($1,$2,$3)",
      [ids.account, `restore-${drillId}`, ownerPasswordHash],
    );
    await client.query(
      `INSERT INTO accounts(
         id,name,password_hash,email,display_name,email_verified_at
       ) VALUES($1,$2,$3,$4,'Deleted fixture owner',now())`,
      [
        ids.erasureAccount,
        `erase-${drillId}`,
        ownerPasswordHash,
        `erase-${drillId}@example.test`,
      ],
    );
    await client.query(
      `INSERT INTO tenants(id,owner_id,used_bytes,quota_bytes,derivative_used_bytes,derivative_quota_bytes)
       VALUES($1,$2,$3,104857600,$4,33554432)`,
      [ids.tenant, ids.account, sourceBytes, derivativeBytes.length],
    );
    await client.query(
      `INSERT INTO tenants(
         id,owner_id,used_bytes,quota_bytes,derivative_used_bytes,derivative_quota_bytes
       ) VALUES($1,$2,$3,104857600,0,33554432)`,
      [ids.erasureTenant, ids.erasureAccount, erasureBytes.length],
    );
    await client.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Old private title')",
      [ids.erasureArtifact, ids.erasureTenant, ids.erasureAccount],
    );
    await client.query(
      `INSERT INTO revisions(
         id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
         object_key,object_version,storage_kind,total_size
       ) VALUES($1,$2,$3,1,$4,'private.txt','text/plain',$5,$6,$7,$8,'single',$5)`,
      [
        ids.erasureRevision,
        ids.erasureTenant,
        ids.erasureArtifact,
        ids.erasureAccount,
        erasureBytes.length,
        fingerprint(erasureBytes),
        erasureObject.key,
        erasureObject.version,
      ],
    );
    await client.query(
      "UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1",
      [ids.erasureArtifact, ids.erasureRevision],
    );
    await client.query(
      "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [fingerprint(`erasure-session-${drillId}`), ids.erasureAccount],
    );
    await client.query(
      "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [fingerprint(sessionToken), ids.account],
    );
    await client.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
       VALUES($1,$2,$3,$4,'restore drill',ARRAY['context','read','capture','revise','share'],$5,now()+interval '7 days')`,
      [
        ids.connection,
        ids.tenant,
        ids.account,
        fingerprint(agentToken),
        "http://127.0.0.1:4680/mcp",
      ],
    );
    await client.query(
      "INSERT INTO agent_connection_csrf(session_hash,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
      [fingerprint(sessionToken), fingerprint("synthetic-csrf")],
    );
    await client.query(
      `INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at)
       VALUES($1,$2,$3,$4,'local',now()+interval '10 minutes')`,
      [
        randomUUID(),
        `restore-${drillId}@example.test`,
        fingerprint("123456"),
        fingerprint("browser"),
      ],
    );
    const singleRequest = {
      key: randomUUID(),
      title: "Restore single",
      filename: "index.html",
      mime: "text/html",
      size: single.length,
      sha256: fingerprint(single),
    };
    const singleReceipt = {
      uploadId: ids.singleUpload,
      artifactId: ids.singleArtifact,
      revisionId: ids.singleRevision,
      number: 1,
      sha256: fingerprint(single),
      htmlProfile: "static",
      manifestSha256: singleManifestHash,
    };
    await client.query(
      `INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request,object_version,receipt,kind)
       VALUES($1,$2,$3,$4,$5,$6,$7,'single')`,
      [
        ids.singleUpload,
        ids.tenant,
        ids.account,
        singleRequest.key,
        singleRequest,
        singleObject.version,
        singleReceipt,
      ],
    );
    await client.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Restore single')",
      [ids.singleArtifact, ids.tenant, ids.account],
    );
    await client.query(
      `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,html_profile,manifest,manifest_sha256,storage_kind,total_size)
       VALUES($1,$2,$3,1,$4,'index.html','text/html',$5,$6,$7,$8,'static',$9,$10,'single',$5)`,
      [
        ids.singleRevision,
        ids.tenant,
        ids.singleArtifact,
        ids.account,
        single.length,
        fingerprint(single),
        singleKey,
        singleObject.version,
        singleManifest,
        singleManifestHash,
      ],
    );
    await client.query(
      "UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1",
      [ids.singleArtifact, ids.singleRevision],
    );
    const bundleTotal = bundleFiles.reduce(
      (sum, file) => sum + file.bytes.length,
      0,
    );
    const bundleRequest = {
      key: bundleKey,
      title: "Restore bundle",
      manifest,
      size: bundleTotal,
    };
    const bundleReceipt = {
      uploadId: ids.bundleUpload,
      artifactId: ids.bundleArtifact,
      revisionId: ids.bundleRevision,
      number: 1,
      sha256: manifest.files[0].sha256,
      htmlProfile: "unsupported",
      manifestSha256,
      storageKind: "bundle",
      totalSize: bundleTotal,
    };
    await client.query(
      `INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request,receipt,kind,connection_id)
       VALUES($1,$2,$3,$4,$5,$6,'bundle',$7)`,
      [
        ids.bundleUpload,
        ids.tenant,
        ids.account,
        bundleRequest.key,
        bundleRequest,
        bundleReceipt,
        ids.connection,
      ],
    );
    for (const [index, object] of bundleObjects.entries())
      await client.query(
        "INSERT INTO upload_files(upload_id,file_index,object_key,object_version) VALUES($1,$2,$3,$4)",
        [ids.bundleUpload, index, object.key, object.version],
      );
    await client.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Restore bundle')",
      [ids.bundleArtifact, ids.tenant, ids.account],
    );
    await client.query(
      `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,html_profile,manifest,manifest_sha256,storage_kind,total_size)
       VALUES($1,$2,$3,1,$4,'index.html','text/html',$5,$6,$7,$8,'unsupported',$9,$10,'bundle',$11)`,
      [
        ids.bundleRevision,
        ids.tenant,
        ids.bundleArtifact,
        ids.account,
        manifest.files[0].size,
        manifest.files[0].sha256,
        bundleObjects[0].key,
        bundleObjects[0].version,
        manifest,
        manifestSha256,
        bundleTotal,
      ],
    );
    for (const [index, object] of bundleObjects.entries()) {
      const file = manifest.files[index];
      await client.query(
        `INSERT INTO revision_files(revision_id,file_index,path,mime,size,sha256,object_key,object_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ids.bundleRevision,
          index,
          file.path,
          file.mime,
          file.size,
          file.sha256,
          object.key,
          object.version,
        ],
      );
    }
    await client.query(
      "UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1",
      [ids.bundleArtifact, ids.bundleRevision],
    );
    await client.query(
      `INSERT INTO revision_derivatives(id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,attempt_id,runtime_profile,size,sha256,object_key,object_version)
       VALUES($1,$2,$3,$4,$5,'ready',$6,$7,$8,$9,$10,$11)`,
      [
        ids.derivative,
        ids.tenant,
        ids.bundleRevision,
        manifestSha256,
        BUNDLE_BUILDER_VERSION,
        attemptId,
        BUNDLE_RUNTIME_PROFILE,
        derivativeBytes.length,
        fingerprint(derivativeBytes),
        derivativeObject.key,
        derivativeObject.version,
      ],
    );
    await client.query(
      `INSERT INTO shares(id,tenant_id,artifact_id,revision_id,derivative_id,token_hash,revoked,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,false,now()+interval '7 days'),
             ($7,$2,$8,$9,NULL,$10,true,now()+interval '7 days')`,
      [
        ids.activeShare,
        ids.tenant,
        ids.bundleArtifact,
        ids.bundleRevision,
        ids.derivative,
        fingerprint(activeToken),
        ids.revokedShare,
        ids.singleArtifact,
        ids.singleRevision,
        fingerprint(revokedToken),
      ],
    );
    const grantHash = fingerprint(randomBytes(32));
    await client.query(
      "INSERT INTO grants(hash,share_id,revision_id,derivative_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '50 seconds')",
      [grantHash, ids.activeShare, ids.bundleRevision, ids.derivative],
    );
    await client.query(
      `INSERT INTO viewer_grants(hash,revision_id,share_id,source_grant_hash,derivative_id,expires_at)
       VALUES($1,$2,$3,$4,$5,now()+interval '50 seconds')`,
      [
        fingerprint(randomBytes(32)),
        ids.bundleRevision,
        ids.activeShare,
        grantHash,
        ids.derivative,
      ],
    );
    const stageRequest = {
      key: randomUUID(),
      title: "Live stage",
      filename: "stage.txt",
      mime: "text/plain",
      size: stagedBytes.length,
      sha256: fingerprint(stagedBytes),
    };
    await client.query(
      `INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request,object_version,kind)
       VALUES($1,$2,$3,$4,$5,$6,'single')`,
      [
        ids.liveStageUpload,
        ids.tenant,
        ids.account,
        stageRequest.key,
        stageRequest,
        stagedObject.version,
      ],
    );
    const deadBytes = Buffer.from("already reconciled");
    const deadManifest = canonicalizeManifest({
      ...manifest,
      files: [
        {
          path: "index.html",
          mime: "text/html",
          size: deadBytes.length,
          sha256: fingerprint(deadBytes),
        },
      ],
    });
    const deadRequest = {
      key: randomUUID(),
      title: "Dead staging",
      manifest: deadManifest,
    };
    await client.query(
      `INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request,aborted,reconciled_at,kind)
       VALUES($1,$2,$3,$4,$5,true,now(),'bundle')`,
      [
        ids.reconciledUpload,
        ids.tenant,
        ids.account,
        deadRequest.key,
        deadRequest,
      ],
    );
    await client.query(
      "INSERT INTO upload_files(upload_id,file_index,object_key,object_version) VALUES($1,0,$2,'missing-version')",
      [ids.reconciledUpload, `${ids.tenant}/${ids.reconciledUpload}`],
    );
    await client.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'restore.fixture',$3)",
      [ids.tenant, ids.account, ids.bundleRevision],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
  return {
    ids,
    linkKey,
    sessionToken,
    agentToken,
    activeToken,
    revokedToken,
    ownerName: `restore-${drillId}`,
    ownerPassword,
    captureInput,
    hashes: {
      single: fingerprint(single),
      manifest: manifestSha256,
      bundleFiles: manifest.files.map((file) => file.sha256),
    },
    quotas: { used: sourceBytes, derivative: derivativeBytes.length },
    erasure: {
      accountId: ids.erasureAccount,
      tenantId: ids.erasureTenant,
      deletionId: ids.erasureDeletion,
    },
  };
}

async function purgeSourceErasure(
  seed: Seed,
  ledgerId: string,
  ledger: ReturnType<typeof createErasureLedgerS3Transport>,
) {
  const seeded = new pg.Client({
    connectionString: databaseUrl(names.sourceDatabase),
  });
  await seeded.connect();
  try {
    await seeded.query("BEGIN");
    await seeded.query(
      `INSERT INTO account_deletions(
         id,account_id,tenant_id,state,status_capability_hash,plan_expires_at,
         artifact_count,revision_count,source_bytes,derivative_bytes,
         policy_version,purge_max_hours,backup_retention_max_days
       ) VALUES($1,$2,$3,'planned',$4,clock_timestamp()+interval '10 minutes',
                1,1,$5,0,'restore-drill-v1',1,1)`,
      [
        seed.erasure.deletionId,
        seed.erasure.accountId,
        seed.erasure.tenantId,
        fingerprint(randomBytes(32)),
        (await seeded.query("SELECT used_bytes FROM tenants WHERE id=$1", [seed.erasure.tenantId])).rows[0].used_bytes,
      ],
    );
    await seeded.query(
      "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
      [seed.erasure.accountId],
    );
    await seeded.query(
      `UPDATE account_deletions SET state='access_revoked_pending_purge',
         requested_at=clock_timestamp(),revoked_at=clock_timestamp(),
         working_data_policy_deadline=clock_timestamp()+interval '1 hour',
         backup_retention_policy_deadline=clock_timestamp()+interval '1 day',
         confirmation_session_hash=$2 WHERE id=$1`,
      [seed.erasure.deletionId, fingerprint(randomBytes(32))],
    );
    await seeded.query("COMMIT");
  } catch (error) {
    await seeded.query("ROLLBACK");
    throw error;
  } finally {
    await seeded.end();
  }

  const database = createMaintenanceDatabase(databaseUrl(names.sourceDatabase));
  const content = createMaintenanceObjectStore({
    endpoint: s3Endpoint.origin,
    region: "us-east-1",
    accessKey: required("S3_ACCESS_KEY"),
    secretKey: required("S3_SECRET_KEY"),
    bucket: names.sourceBucket,
  });
  const abort = new AbortController();
  await database.connect();
  try {
    const result = await runMaintenanceGuard({
      client: database,
      signal: abort.signal,
      run: (scope) =>
        runAccountPurge(scope, {
          ledgerId,
          ledger,
          content,
        }),
    });
    if (
      result.state !== "completed" ||
      result.value.jobsClaimed !== 1 ||
      result.value.revokeRecordsAcknowledged !== 1 ||
      result.value.sourceVersionsDeleted !== 1 ||
      result.value.sourcePrefixesVerifiedEmpty !== 1 ||
      result.value.metadataPurged !== 1 ||
      result.value.terminalRecordsAcknowledged !== 1
    )
      throw new Error("Source account purge did not complete");
  } finally {
    abort.abort();
    content.close();
  }
  const listed = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: names.sourceBucket,
      Prefix: `${seed.erasure.tenantId}/`,
    }),
  );
  if (
    listed.IsTruncated !== false ||
    (listed.Versions?.length ?? 0) !== 0 ||
    (listed.DeleteMarkers?.length ?? 0) !== 0
  )
    throw new Error("Source account purge left content versions");
  return {
    sourceVersionsDeleted: 1,
    sourcePrefixEmpty: true,
    revokeAndPurgedLedgerAcknowledged: true,
  };
}

async function applyErasureBarrier(
  seed: Seed,
  plan: ErasureRestorePlan,
  ledger: ReturnType<typeof createErasureLedgerS3Transport>,
) {
  const database = createMaintenanceDatabase(databaseUrl(names.targetDatabase));
  const content = createMaintenanceObjectStore({
    endpoint: s3Endpoint.origin,
    region: "us-east-1",
    accessKey: required("S3_ACCESS_KEY"),
    secretKey: required("S3_SECRET_KEY"),
    bucket: names.targetBucket,
  });
  const abort = new AbortController();
  let reconciliation:
    | Awaited<ReturnType<typeof reconcileErasureRestore>>
    | undefined;
  await database.connect();
  try {
    const result = await runMaintenanceGuard({
      client: database,
      signal: abort.signal,
      run: (scope) =>
        reconcileErasureRestore({
          scope,
          content,
          ledger,
          plan,
          restoreRunId: randomUUID(),
        }),
    });
    if (
      result.state !== "completed" ||
      result.value.entriesCompleted !== 1 ||
      result.value.metadataTenantsCompleted !== 1 ||
      result.value.absentTenantsCompleted !== 0
    )
      throw new Error("Restored erasure barrier did not complete");
    reconciliation = result.value;
  } finally {
    abort.abort();
    content.close();
  }

  const checked = new pg.Client({
    connectionString: databaseUrl(names.targetDatabase),
  });
  await checked.connect();
  try {
    const row = (
      await checked.query(
        `SELECT account.name,account.email,account.display_name,
                tenant.used_bytes,tenant.derivative_used_bytes,
                deletion.state AS deletion_state,deletion.purged_at,job.phase,
                suppression.state AS suppression_state,
                (SELECT count(*)::int FROM artifacts WHERE tenant_id=$2) AS artifacts,
                (SELECT count(*)::int FROM revisions WHERE tenant_id=$2) AS revisions,
                (SELECT count(*)::int FROM sessions WHERE account_id=$1) AS sessions
           FROM accounts account
           JOIN tenants tenant ON tenant.owner_id=account.id
           JOIN account_deletions deletion ON deletion.account_id=account.id
           JOIN account_purge_jobs job ON job.deletion_id=deletion.id
           JOIN account_restore_suppressions suppression
             ON suppression.deletion_id=deletion.id
          WHERE account.id=$1 AND tenant.id=$2`,
        [seed.erasure.accountId, seed.erasure.tenantId],
      )
    ).rows[0];
    if (
      !row ||
      row.name !== `deleted-${seed.erasure.accountId}` ||
      row.email !== null ||
      row.display_name !== null ||
      Number(row.used_bytes) !== 0 ||
      Number(row.derivative_used_bytes) !== 0 ||
      row.deletion_state !== "purged" ||
      row.phase !== "purged" ||
      row.suppression_state !== "completed" ||
      Number(row.artifacts) !== 0 ||
      Number(row.revisions) !== 0 ||
      Number(row.sessions) !== 0
    )
      throw new Error("Restored erased tenant metadata survived suppression");
    const historic = plan.entries.find(
      (entry) => entry.requestId === seed.erasure.deletionId,
    );
    if (
      historic?.state !== "purged" ||
      new Date(row.purged_at).toISOString() !== historic.purged?.metadataPurgedAt
    )
      throw new Error("Restored erasure receipt changed historic proof time");
  } finally {
    await checked.end();
  }
  const listed = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: names.targetBucket,
      Prefix: `${seed.erasure.tenantId}/`,
    }),
  );
  if (
    listed.IsTruncated !== false ||
    (listed.Versions?.length ?? 0) !== 0 ||
    (listed.DeleteMarkers?.length ?? 0) !== 0
  )
    throw new Error("Restored erased tenant bytes survived suppression");
  const after = await loadErasureRestorePlan(
    ledger,
    plan.ledgerId,
    new AbortController().signal,
  );
  assertErasureRestorePlanStable(plan, after);
  return {
    entries: reconciliation!.entriesCompleted,
    sourceVersionsDeleted: reconciliation!.sourceVersionsDeleted,
    metadataPurged: reconciliation!.metadataPurged,
    oldSnapshotBytesRemoved: true,
    oldSnapshotPiiRemoved: true,
    historicPurgedReceiptPreserved: true,
    ledgerVersionsStable: true,
  };
}

type ObjectReference = {
  key: string;
  sourceVersionId: string;
  sha256: string;
  size: number;
  roles: string[];
};

const referenceSql = `
  SELECT 'revision' AS role,object_key AS key,object_version AS version,size,sha256 FROM revisions
  UNION ALL
  SELECT 'revision_file',object_key,object_version,size,sha256 FROM revision_files
  UNION ALL
  SELECT 'derivative',object_key,object_version,size,sha256 FROM revision_derivatives WHERE state='ready'
  UNION ALL
  SELECT 'upload',tenant_id::text||'/'||id::text,object_version,(request->>'size')::bigint,request->>'sha256'
  FROM uploads WHERE kind='single' AND object_version IS NOT NULL
  UNION ALL
  SELECT 'upload_file',uf.object_key,uf.object_version,
    (u.request->'manifest'->'files'->uf.file_index->>'size')::bigint,
    u.request->'manifest'->'files'->uf.file_index->>'sha256'
  FROM upload_files uf JOIN uploads u ON u.id=uf.upload_id
  WHERE u.receipt IS NOT NULL OR u.reconciled_at IS NULL
  ORDER BY 2,3,1`;

async function collectObjects(directory: string) {
  const client = new pg.Client({
    connectionString: databaseUrl(names.sourceDatabase),
  });
  await client.connect();
  const rows = (await client.query(referenceSql)).rows;
  await client.end();
  const references = new Map<string, ObjectReference>();
  for (const row of rows) {
    const identity = `${row.key}\0${row.version}`;
    const old = references.get(identity);
    if (old) {
      if (old.sha256 !== row.sha256 || old.size !== Number(row.size))
        throw new Error("Conflicting metadata for one object version");
      old.roles.push(row.role);
    } else
      references.set(identity, {
        key: row.key,
        sourceVersionId: row.version,
        sha256: row.sha256,
        size: Number(row.size),
        roles: [row.role],
      });
  }
  const objectDirectory = join(directory, "objects");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(objectDirectory));
  for (const reference of references.values()) {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: names.sourceBucket,
        Key: reference.key,
        VersionId: reference.sourceVersionId,
      }),
    );
    const bytes = Buffer.from(await response.Body!.transformToByteArray());
    if (
      bytes.length !== reference.size ||
      fingerprint(bytes) !== reference.sha256
    )
      throw new Error("Source object checksum mismatch");
    const path = join(objectDirectory, reference.sha256);
    try {
      const existing = await readFile(path);
      if (!existing.equals(bytes)) throw new Error("Content hash collision");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(path, bytes, { mode: 0o600 });
    }
  }
  const ordered = [...references.values()];
  const jsonl = ordered.map((value) => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(join(directory, "objects.jsonl"), jsonl, { mode: 0o600 });
  await writeFile(
    join(directory, "objects.jsonl.sha256"),
    `${fingerprint(jsonl)}  objects.jsonl\n`,
    { mode: 0o600 },
  );
  return ordered;
}

async function loadBackup(
  directory: string,
  expectedLinkKey: string,
  erasurePlan: ErasureRestorePlan,
) {
  const backup = JSON.parse(
    await readFile(join(directory, "backup.json"), "utf8"),
  );
  const dump = await readFile(join(directory, "database.dump"));
  const objectManifest = await readFile(
    join(directory, "objects.jsonl"),
    "utf8",
  );
  if (
    backup.formatVersion !== 1 ||
    backup.schemaMigrations?.join(",") !==
      EXPECTED_MIGRATION_VERSIONS.join(",") ||
    backup.databaseSha256 !== fingerprint(dump) ||
    backup.objectManifestSha256 !== fingerprint(objectManifest) ||
    backup.linkKeyFingerprint !== fingerprint(expectedLinkKey)
  )
    throw new Error("Backup envelope verification failed");
  requireBackupLedger(backup, erasurePlan);
  const references = objectManifest
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ObjectReference);
  if (
    references.length !== backup.objectReferences ||
    references.some(
      (reference) =>
        !reference.key ||
        !reference.sourceVersionId ||
        !/^[a-f0-9]{64}$/.test(reference.sha256) ||
        !Number.isSafeInteger(reference.size) ||
        reference.size < 0 ||
        !Array.isArray(reference.roles) ||
        !reference.roles.length,
    )
  )
    throw new Error("Backup object manifest validation failed");
  return { backup, references };
}

async function dockerPostgresContainer() {
  const output = await runCapture("docker", [
    "ps",
    "--filter",
    "label=com.docker.compose.project=polka-local",
    "--filter",
    "label=com.docker.compose.service=postgres",
    "--format",
    "{{.Names}}",
  ]);
  const names = output.trim().split("\n").filter(Boolean);
  if (names.length !== 1)
    throw new Error("Expected one reviewed local Postgres container");
  return names[0];
}

function runCapture(
  command: string,
  args: string[],
  options: {
    stdinFile?: string;
    stdoutFile?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return new Promise<string>(async (resolve, reject) => {
    const input = options.stdinFile ? await open(options.stdinFile, "r") : null;
    const output = options.stdoutFile
      ? await open(options.stdoutFile, "w", 0o600)
      : null;
    const child = spawn(command, args, {
      cwd: new URL("..", import.meta.url).pathname,
      env: options.env ?? process.env,
      stdio: [input?.fd ?? "ignore", output?.fd ?? "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (child.stdout) child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", async (code) => {
      await Promise.all([input?.close(), output?.close()]);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new Error(
            `${command} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`,
          ),
        );
    });
  });
}

async function proveSourceAgentReplay(seed: Seed, linkKey: string) {
  const shareKey = randomUUID();
  const shareInput = {
    key: shareKey,
    artifactId: seed.ids.singleArtifact,
    expectedRevisionId: seed.ids.singleRevision,
    expiresInDays: 7,
  };
  const output = await runCapture(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      const {authenticateServiceToken}=await import('./apps/server/service-auth.ts');
      const {captureFromAgent,statusForAgent}=await import('./apps/server/agent-capture.ts');
      const {shareFromAgent}=await import('./apps/server/shares.ts');
      const {db}=await import('./apps/server/db.ts');
      const {s3}=await import('./apps/server/storage.ts');
      const actor=await authenticateServiceToken(process.env.DRILL_AGENT_TOKEN,process.env.APP_ORIGIN+'/mcp','context');
      const before=(await db.query("SELECT (SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM revisions) revisions,(SELECT count(*)::int FROM shares) shares,(SELECT count(*)::int FROM agent_operations) operations")).rows[0];
      const captureInput=JSON.parse(process.env.DRILL_CAPTURE_INPUT);
      const status=await statusForAgent(actor,{key:captureInput.key});
      const replay=await captureFromAgent(actor,captureInput,'capture');
      const afterCapture=(await db.query("SELECT (SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM revisions) revisions,(SELECT count(*)::int FROM shares) shares,(SELECT count(*)::int FROM agent_operations) operations")).rows[0];
      const shareInput=JSON.parse(process.env.DRILL_SHARE_INPUT);
      const shared=await shareFromAgent(actor,shareInput);
      const replayed=await shareFromAgent(actor,shareInput);
      const afterShare=(await db.query("SELECT (SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM revisions) revisions,(SELECT count(*)::int FROM shares) shares,(SELECT count(*)::int FROM agent_operations) operations")).rows[0];
      process.stdout.write(JSON.stringify({
        captureStable:JSON.stringify(before)===JSON.stringify(afterCapture),
        receiptStable:JSON.stringify(status.receipt)===JSON.stringify(replay),
        shareReplayStable:shared.shareId===replayed.shareId&&replayed.state==='active',
        shareDelta:Number(afterShare.shares)-Number(afterCapture.shares),
        operationDelta:Number(afterShare.operations)-Number(afterCapture.operations),
        agentShareId:shared.shareId
      }));
      await db.end();s3.destroy();
    `,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(names.sourceDatabase),
        S3_BUCKET: names.sourceBucket,
        LINK_KEY: linkKey,
        APP_ORIGIN: "http://127.0.0.1:4680",
        HOST: "127.0.0.1",
        PORT: "4680",
        COOKIE_SECURE: "false",
        HTML_LIVE_ENABLED: "false",
        MAIL_MODE: "disabled",
        DRILL_AGENT_TOKEN: seed.agentToken,
        DRILL_CAPTURE_INPUT: JSON.stringify(seed.captureInput),
        DRILL_SHARE_INPUT: JSON.stringify(shareInput),
      },
    },
  );
  const result = JSON.parse(output);
  if (
    !result.captureStable ||
    !result.receiptStable ||
    !result.shareReplayStable ||
    result.shareDelta !== 1 ||
    result.operationDelta !== 1
  )
    throw new Error("Source agent replay acceptance failed");
  return {
    shareInput,
    shareId: result.agentShareId as string,
    shareToken: createHmac("sha256", linkKey)
      .update(`share:${result.agentShareId}`)
      .digest("base64url"),
  };
}

async function trashSourceFixture(seed: Seed, linkKey: string) {
  const output = await runCapture(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      const {transitionOwnerArtifactLifecycle}=await import('./apps/server/artifact-trash.ts');
      const {db}=await import('./apps/server/db.ts');
      const {s3}=await import('./apps/server/storage.ts');
      const snapshot=await transitionOwnerArtifactLifecycle(
        {id:process.env.DRILL_ACCOUNT,tenant:process.env.DRILL_TENANT},
        process.env.DRILL_ARTIFACT,
        {expectedLifecycleVersion:0,expectedRevisionId:process.env.DRILL_REVISION},
        'trashed'
      );
      process.stdout.write(JSON.stringify(snapshot));
      await db.end();s3.destroy();
    `,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(names.sourceDatabase),
        S3_BUCKET: names.sourceBucket,
        LINK_KEY: linkKey,
        APP_ORIGIN: "http://127.0.0.1:4680",
        HOST: "127.0.0.1",
        PORT: "4680",
        COOKIE_SECURE: "false",
        HTML_LIVE_ENABLED: "false",
        MAIL_MODE: "disabled",
        DRILL_ACCOUNT: seed.ids.account,
        DRILL_TENANT: seed.ids.tenant,
        DRILL_ARTIFACT: seed.ids.singleArtifact,
        DRILL_REVISION: seed.ids.singleRevision,
      },
    },
  );
  const snapshot = JSON.parse(output);
  if (
    snapshot.id !== seed.ids.singleArtifact ||
    snapshot.lifecycleVersion !== 1 ||
    !snapshot.trashedAt
  )
    throw new Error("Source trash fixture transition failed");
}

async function dumpDatabase(container: string, path: string) {
  await runCapture(
    "docker",
    [
      "exec",
      container,
      "pg_dump",
      "-U",
      workingDatabaseUrl.username,
      "-d",
      names.sourceDatabase,
      "--format=custom",
      "--no-owner",
      "--no-acl",
    ],
    { stdoutFile: path },
  );
}

async function restoreDatabase(container: string, path: string) {
  await runCapture(
    "docker",
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "-U",
      workingDatabaseUrl.username,
      "-d",
      names.targetDatabase,
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
    ],
    { stdinFile: path },
  );
}

async function restoreObjects(
  directory: string,
  references: ObjectReference[],
) {
  const mapping = [];
  for (const reference of references) {
    const bytes = await readFile(join(directory, "objects", reference.sha256));
    if (
      bytes.length !== reference.size ||
      fingerprint(bytes) !== reference.sha256
    )
      throw new Error("Backup object checksum mismatch");
    const putResult = await s3.send(
      new PutObjectCommand({
        Bucket: names.targetBucket,
        Key: reference.key,
        Body: bytes,
        ContentType: "application/octet-stream",
        Metadata: { sha256: reference.sha256 },
        IfNoneMatch: "*",
      }),
    );
    if (!putResult.VersionId || putResult.VersionId === "null")
      throw new Error("Target object versioning required");
    if (putResult.VersionId === reference.sourceVersionId)
      throw new Error("Target storage reused a source VersionId");
    const read = await s3.send(
      new GetObjectCommand({
        Bucket: names.targetBucket,
        Key: reference.key,
        VersionId: putResult.VersionId,
      }),
    );
    const restored = Buffer.from(await read.Body!.transformToByteArray());
    if (
      restored.length !== reference.size ||
      fingerprint(restored) !== reference.sha256
    )
      throw new Error("Target object checksum mismatch");
    mapping.push({ ...reference, targetVersionId: putResult.VersionId });
  }
  return mapping;
}

async function remapAndClose(
  mapping: Awaited<ReturnType<typeof restoreObjects>>,
) {
  const client = new pg.Client({
    connectionString: databaseUrl(names.targetDatabase),
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE restore_object_versions(object_key text,source_version text,target_version text,sha256 text,size bigint,PRIMARY KEY(object_key,source_version)) ON COMMIT DROP",
    );
    for (const item of mapping)
      await client.query(
        "INSERT INTO restore_object_versions VALUES($1,$2,$3,$4,$5)",
        [
          item.key,
          item.sourceVersionId,
          item.targetVersionId,
          item.sha256,
          item.size,
        ],
      );
    const dead = await client.query(
      `DELETE FROM upload_files uf USING uploads u
       WHERE uf.upload_id=u.id AND u.receipt IS NULL AND u.reconciled_at IS NOT NULL
       RETURNING uf.upload_id`,
    );
    if (dead.rowCount !== 1)
      throw new Error("Expected one dead reconciled upload_file");
    const missing = await client.query(
      `WITH refs AS (${referenceSql})
       SELECT count(*)::int AS count FROM refs r
       LEFT JOIN restore_object_versions m ON m.object_key=r.key AND m.source_version=r.version
       WHERE m.object_key IS NULL`,
    );
    if (missing.rows[0].count !== 0)
      throw new Error("Target mapping misses live object references");
    await client.query(
      `UPDATE revisions r SET object_version=m.target_version FROM restore_object_versions m WHERE m.object_key=r.object_key AND m.source_version=r.object_version`,
    );
    await client.query(
      `UPDATE revision_files r SET object_version=m.target_version FROM restore_object_versions m WHERE m.object_key=r.object_key AND m.source_version=r.object_version`,
    );
    await client.query(
      "ALTER TABLE revision_derivatives DISABLE TRIGGER revision_derivative_ready_immutable",
    );
    await client.query(
      `UPDATE revision_derivatives r SET object_version=m.target_version FROM restore_object_versions m WHERE r.state='ready' AND m.object_key=r.object_key AND m.source_version=r.object_version`,
    );
    await client.query(
      "ALTER TABLE revision_derivatives ENABLE TRIGGER revision_derivative_ready_immutable",
    );
    await client.query(
      `UPDATE uploads u SET object_version=m.target_version FROM restore_object_versions m WHERE m.object_key=u.tenant_id::text||'/'||u.id::text AND m.source_version=u.object_version`,
    );
    await client.query(
      `UPDATE upload_files u SET object_version=m.target_version FROM restore_object_versions m WHERE m.object_key=u.object_key AND m.source_version=u.object_version`,
    );
    await client.query("UPDATE shares SET revoked=true WHERE NOT revoked");
    await client.query(
      "UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE revoked_at IS NULL",
    );
    await client.query("DELETE FROM viewer_grants");
    await client.query("DELETE FROM project_view_grants");
    await client.query("DELETE FROM grants");
    await client.query("DELETE FROM agent_connection_csrf");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM login_challenges");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function verify(
  seed: Seed,
  sourceAgent: Awaited<ReturnType<typeof proveSourceAgentReplay>>,
  mapping: Awaited<ReturnType<typeof restoreObjects>>,
  restoredLinkKey: string,
) {
  if (fingerprint(restoredLinkKey) !== fingerprint(seed.linkKey))
    throw new Error("Restored LINK_KEY fingerprint mismatch");
  const client = new pg.Client({
    connectionString: databaseUrl(names.targetDatabase),
  });
  await client.connect();
  const tenant = (
    await client.query(
      "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
      [seed.ids.tenant],
    )
  ).rows[0];
  if (
    Number(tenant.used_bytes) !== seed.quotas.used ||
    Number(tenant.derivative_used_bytes) !== seed.quotas.derivative
  )
    throw new Error("Quota counters changed during restore");
  const access = (
    await client.query(
      `SELECT
       (SELECT count(*)::int FROM shares WHERE NOT revoked) AS active_shares,
       (SELECT count(*)::int FROM agent_connections WHERE revoked_at IS NULL) AS active_connections,
       (SELECT count(*)::int FROM sessions) AS sessions,
       (SELECT count(*)::int FROM grants) AS grants,
       (SELECT count(*)::int FROM viewer_grants) AS viewer_grants,
       (SELECT count(*)::int FROM project_view_grants) AS project_view_grants,
       (SELECT count(*)::int FROM agent_connection_csrf) AS csrf,
       (SELECT count(*)::int FROM login_challenges) AS challenges,
       (SELECT count(*)::int FROM upload_files uf JOIN uploads u ON u.id=uf.upload_id WHERE u.id=$1) AS dead_files,
       (SELECT count(*)::int FROM uploads WHERE id=$1 AND reconciled_at IS NOT NULL) AS tombstone`,
      [seed.ids.reconciledUpload],
    )
  ).rows[0];
  if (
    Object.entries(access).some(
      ([key, value]) => key !== "tombstone" && Number(value) !== 0,
    ) ||
    Number(access.tombstone) !== 1
  )
    throw new Error("Fail-closed or reconciled tombstone invariant failed");
  const manifests = (
    await client.query(
      "SELECT manifest,manifest_sha256 FROM revisions WHERE manifest IS NOT NULL",
    )
  ).rows;
  for (const row of manifests)
    if (
      fingerprint(JSON.stringify(canonicalizeManifest(row.manifest))) !==
      row.manifest_sha256
    )
      throw new Error("Restored manifest checksum mismatch");
  const refs = (await client.query(referenceSql)).rows;
  await client.end();
  for (const row of refs) {
    const expected = mapping.find(
      (item) => item.key === row.key && item.targetVersionId === row.version,
    );
    if (!expected) throw new Error("Restored DB reference is not remapped");
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: names.targetBucket,
        Key: row.key,
        VersionId: row.version,
      }),
    );
    const bytes = Buffer.from(await response.Body!.transformToByteArray());
    if (bytes.length !== Number(row.size) || fingerprint(bytes) !== row.sha256)
      throw new Error("Restored exact-version read failed");
  }
  const child = await runCapture(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      const {createApp}=await import('./apps/server/app.ts');
      const {authenticateServiceToken}=await import('./apps/server/service-auth.ts');
      const {captureFromAgent,statusForAgent}=await import('./apps/server/agent-capture.ts');
      const {shareFromAgent}=await import('./apps/server/shares.ts');
      const {tokenFor}=await import('./apps/server/artifacts.ts');
      const {Problem}=await import('./apps/server/errors.ts');
      const {db}=await import('./apps/server/db.ts');
      const {s3,sha256}=await import('./apps/server/storage.ts');
      const app=await createApp();
      const resolve=await app.inject({method:'POST',url:'/api/resolve',headers:{origin:process.env.APP_ORIGIN},payload:{token:process.env.DRILL_SHARE_TOKEN}});
      const revokedResolve=await app.inject({method:'POST',url:'/api/resolve',headers:{origin:process.env.APP_ORIGIN},payload:{token:process.env.DRILL_REVOKED_SHARE_TOKEN}});
      const agentShareResolve=await app.inject({method:'POST',url:'/api/resolve',headers:{origin:process.env.APP_ORIGIN},payload:{token:process.env.DRILL_AGENT_SHARE_TOKEN}});
      const me=await app.inject({method:'GET',url:'/api/me',headers:{origin:process.env.APP_ORIGIN,cookie:'polka_session='+process.env.DRILL_SESSION_TOKEN}});
      const expectUnauthorized=error=>{if(error instanceof Problem&&error.status===401&&error.code==='unauthorized')return true;throw error};
      let agentDenied=false;try{await authenticateServiceToken(process.env.DRILL_AGENT_TOKEN,process.env.APP_ORIGIN+'/mcp','context')}catch(error){agentDenied=expectUnauthorized(error)}
      const tokenHashes=(await db.query('SELECT id,token_hash FROM shares')).rows.every(row=>sha256(tokenFor(row.id))===row.token_hash);
      const staleActor=JSON.parse(process.env.DRILL_STALE_ACTOR);
      const captureInput=JSON.parse(process.env.DRILL_CAPTURE_INPUT);
      const shareInput=JSON.parse(process.env.DRILL_AGENT_SHARE_INPUT);
      const beforeRejected=(await db.query("SELECT (SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM revisions) revisions,(SELECT count(*)::int FROM shares) shares,(SELECT count(*)::int FROM agent_operations) operations,(SELECT used_bytes FROM tenants WHERE id=$1) used,(SELECT derivative_used_bytes FROM tenants WHERE id=$1) derivative,(SELECT latest_revision_id FROM artifacts WHERE id=$2) latest",[staleActor.tenantId,process.env.DRILL_SINGLE_ARTIFACT])).rows[0];
      const rejected=[];
      for(const operation of [
        ()=>statusForAgent(staleActor,{key:captureInput.key}),
        ()=>captureFromAgent(staleActor,captureInput,'capture'),
        ()=>shareFromAgent(staleActor,shareInput)
      ])try{await operation();rejected.push(false)}catch(error){rejected.push(expectUnauthorized(error))}
      const afterRejected=(await db.query("SELECT (SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM revisions) revisions,(SELECT count(*)::int FROM shares) shares,(SELECT count(*)::int FROM agent_operations) operations,(SELECT used_bytes FROM tenants WHERE id=$1) used,(SELECT derivative_used_bytes FROM tenants WHERE id=$1) derivative,(SELECT latest_revision_id FROM artifacts WHERE id=$2) latest",[staleActor.tenantId,process.env.DRILL_SINGLE_ARTIFACT])).rows[0];
      const login=await app.inject({method:'POST',url:'/api/login',headers:{origin:process.env.APP_ORIGIN},payload:{name:process.env.DRILL_OWNER_NAME,password:process.env.DRILL_OWNER_PASSWORD}});
      const session=login.cookies.find(cookie=>cookie.name==='polka_session');
      const freshCookie=session?'polka_session='+session.value:'';
      const freshMe=await app.inject({method:'GET',url:'/api/me',headers:{origin:process.env.APP_ORIGIN,cookie:freshCookie}});
      const tenantSession=session?(await db.query("SELECT t.id FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN tenants t ON t.owner_id=a.id WHERE s.hash=$1",[sha256(session.value)])).rows[0]:null;
      const artifactBefore=await app.inject({method:'GET',url:'/api/artifacts/'+process.env.DRILL_SINGLE_ARTIFACT,headers:{origin:process.env.APP_ORIGIN,cookie:freshCookie}});
      const singleBytes=await app.inject({method:'GET',url:'/api/revisions/'+process.env.DRILL_SINGLE_REVISION+'/bytes',headers:{origin:process.env.APP_ORIGIN,cookie:freshCookie}});
      const bundleExport=await app.inject({method:'GET',url:'/api/revisions/'+process.env.DRILL_BUNDLE_REVISION+'/export',headers:{origin:process.env.APP_ORIGIN,cookie:freshCookie}});
      const exported=bundleExport.statusCode===200?bundleExport.json():null;
      const expectedFileHashes=JSON.parse(process.env.DRILL_BUNDLE_HASHES);
      const exportExact=!!exported&&exported.manifestSha256===process.env.DRILL_MANIFEST_HASH&&exported.files.length===expectedFileHashes.length&&exported.files.every((file,index)=>file.sha256===expectedFileHashes[index]&&sha256(Buffer.from(file.data,'base64'))===expectedFileHashes[index]);
      const restoredArtifact=await app.inject({method:'POST',url:'/api/artifacts/'+process.env.DRILL_SINGLE_ARTIFACT+'/restore',headers:{origin:process.env.APP_ORIGIN,cookie:freshCookie},payload:{expectedLifecycleVersion:1,expectedRevisionId:process.env.DRILL_SINGLE_REVISION}});
      const enabled=await app.inject({method:'POST',url:'/api/artifacts/'+process.env.DRILL_SINGLE_ARTIFACT+'/share',headers:{origin:process.env.APP_ORIGIN,cookie:freshCookie},payload:{expectedRevisionId:process.env.DRILL_SINGLE_REVISION,expiresInDays:7}});
      const newShare=enabled.statusCode===200?enabled.json().share:null;
      const newToken=newShare?new URL(newShare.url).hash.slice(1):'';
      const newResolve=await app.inject({method:'POST',url:'/api/resolve',headers:{origin:process.env.APP_ORIGIN},payload:{token:newToken}});
      const oldAfter=await Promise.all([process.env.DRILL_SHARE_TOKEN,process.env.DRILL_REVOKED_SHARE_TOKEN,process.env.DRILL_AGENT_SHARE_TOKEN].map(token=>app.inject({method:'POST',url:'/api/resolve',headers:{origin:process.env.APP_ORIGIN},payload:{token}})));
      process.stdout.write(JSON.stringify({
        resolve:resolve.statusCode,revokedResolve:revokedResolve.statusCode,agentShareResolve:agentShareResolve.statusCode,me:me.statusCode,agentDenied,tokenHashes,
        agentReplaysDenied:rejected.every(Boolean),agentStateUnchanged:JSON.stringify(beforeRejected)===JSON.stringify(afterRejected),
        freshLogin:login.statusCode===200&&!!session,freshIdentity:freshMe.statusCode===200&&freshMe.json().id===process.env.DRILL_ACCOUNT&&tenantSession?.id===process.env.DRILL_TENANT,
        trashStatePreserved:artifactBefore.statusCode===200&&!!artifactBefore.json().trashedAt&&artifactBefore.json().lifecycleVersion===1&&artifactBefore.json().share?.status==='revoked',
        explicitRestore:restoredArtifact.statusCode===200&&restoredArtifact.json().trashedAt===null&&restoredArtifact.json().lifecycleVersion===2,
        singleExact:singleBytes.statusCode===200&&sha256(singleBytes.rawPayload)===process.env.DRILL_SINGLE_HASH,
        exportExact,
        newShare:newShare&&newShare.id!==process.env.DRILL_REVOKED_SHARE&&newShare.id!==process.env.DRILL_AGENT_SHARE,
        newResolve:newResolve.statusCode===200&&newResolve.json().revision.id===process.env.DRILL_SINGLE_REVISION,
        oldStillDenied:oldAfter.every(response=>response.statusCode===404)
      }));
      await app.close();await db.end();s3.destroy();
    `,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(names.targetDatabase),
        S3_BUCKET: names.targetBucket,
        LINK_KEY: restoredLinkKey,
        APP_ORIGIN: "http://127.0.0.1:4680",
        HOST: "127.0.0.1",
        PORT: "4680",
        COOKIE_SECURE: "false",
        HTML_LIVE_ENABLED: "false",
        MAIL_MODE: "disabled",
        DRILL_SHARE_TOKEN: seed.activeToken,
        DRILL_REVOKED_SHARE_TOKEN: seed.revokedToken,
        DRILL_AGENT_SHARE_TOKEN: sourceAgent.shareToken,
        DRILL_SESSION_TOKEN: seed.sessionToken,
        DRILL_AGENT_TOKEN: seed.agentToken,
        DRILL_STALE_ACTOR: JSON.stringify({
          accountId: seed.ids.account,
          tenantId: seed.ids.tenant,
          connectionId: seed.ids.connection,
          scopes: ["context", "read", "capture", "revise", "share"],
          audience: "http://127.0.0.1:4680/mcp",
          expiresAt: Date.now() + 86400000,
        }),
        DRILL_CAPTURE_INPUT: JSON.stringify(seed.captureInput),
        DRILL_AGENT_SHARE_INPUT: JSON.stringify(sourceAgent.shareInput),
        DRILL_OWNER_NAME: seed.ownerName,
        DRILL_OWNER_PASSWORD: seed.ownerPassword,
        DRILL_ACCOUNT: seed.ids.account,
        DRILL_TENANT: seed.ids.tenant,
        DRILL_SINGLE_ARTIFACT: seed.ids.singleArtifact,
        DRILL_SINGLE_REVISION: seed.ids.singleRevision,
        DRILL_BUNDLE_REVISION: seed.ids.bundleRevision,
        DRILL_SINGLE_HASH: seed.hashes.single,
        DRILL_MANIFEST_HASH: seed.hashes.manifest,
        DRILL_BUNDLE_HASHES: JSON.stringify(seed.hashes.bundleFiles),
        DRILL_REVOKED_SHARE: seed.ids.revokedShare,
        DRILL_AGENT_SHARE: sourceAgent.shareId,
      },
    },
  );
  const denied = JSON.parse(child);
  if (
    denied.resolve !== 404 ||
    denied.revokedResolve !== 404 ||
    denied.agentShareResolve !== 404 ||
    denied.me !== 401 ||
    !denied.agentDenied ||
    !denied.tokenHashes ||
    !denied.agentReplaysDenied ||
    !denied.agentStateUnchanged ||
    !denied.freshLogin ||
    !denied.freshIdentity ||
    !denied.trashStatePreserved ||
    !denied.explicitRestore ||
    !denied.singleExact ||
    !denied.exportExact ||
    !denied.newShare ||
    !denied.newResolve ||
    !denied.oldStillDenied
  )
    throw new Error("Restored owner/agent/share acceptance failed");
  return { objects: mapping.length, revisions: manifests.length, ...denied };
}

async function proveMaintenanceCleanup(
  seed: Seed,
  mapping: Awaited<ReturnType<typeof restoreObjects>>,
  restoredLinkKey: string,
) {
  const stagedKey = `${seed.ids.tenant}/${seed.ids.liveStageUpload}`;
  const staged = mapping.find((item) => item.key === stagedKey);
  if (!staged) throw new Error("Staged restore mapping is missing");
  const client = new pg.Client({
    connectionString: databaseUrl(names.targetDatabase),
  });
  await client.connect();
  const quotaBefore = (
    await client.query(
      "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
      [seed.ids.tenant],
    )
  ).rows[0];
  await client.query(
    "UPDATE uploads SET aborted=true,expires_at=now()-interval '1 second' WHERE id=$1 AND receipt IS NULL AND reconciled_at IS NULL",
    [seed.ids.liveStageUpload],
  );
  await client.end();
  const maintenanceOutput = await runCapture(
    process.execPath,
    ["--import", "tsx", "scripts/maintenance.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(names.targetDatabase),
        S3_BUCKET: names.targetBucket,
        LINK_KEY: restoredLinkKey,
        APP_ORIGIN: "http://127.0.0.1:4680",
        HOST: "127.0.0.1",
        PORT: "4680",
        COOKIE_SECURE: "false",
        HTML_LIVE_ENABLED: "false",
        MAIL_MODE: "disabled",
      },
    },
  );
  const maintenanceEvents = maintenanceOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const maintenance = maintenanceEvents.find(
    (event) => event.event === "maintenance.completed",
  );
  if (
    maintenanceEvents.length !== 2 ||
    maintenanceEvents[0]?.event !== "maintenance.started" ||
    !maintenance ||
    maintenance.expiredUploadsReconciled !== 1 ||
    maintenance.expiredDerivativesReconciled !== 0 ||
    maintenance.emailChallengesRemoved !== 0
  )
    throw new Error("Maintenance did not reconcile the staged fixture");
  const checked = new pg.Client({
    connectionString: databaseUrl(names.targetDatabase),
  });
  await checked.connect();
  const upload = (
    await checked.query(
      "SELECT aborted,reconciled_at,object_version,receipt FROM uploads WHERE id=$1",
      [seed.ids.liveStageUpload],
    )
  ).rows[0];
  const quotaAfter = (
    await checked.query(
      "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
      [seed.ids.tenant],
    )
  ).rows[0];
  const refs = (await checked.query(referenceSql)).rows;
  await checked.end();
  if (
    !upload?.aborted ||
    !upload.reconciled_at ||
    upload.object_version !== null ||
    upload.receipt !== null ||
    JSON.stringify(quotaBefore) !== JSON.stringify(quotaAfter)
  )
    throw new Error("Maintenance staging tombstone or quota invariant failed");
  const expectedReferences = mapping
    .flatMap((item) =>
      item.roles.map((role) => ({
        role,
        key: item.key,
        targetVersionId: item.targetVersionId,
        size: item.size,
        sha256: item.sha256,
      })),
    )
    .filter(
      (reference) =>
        !reference.key.startsWith(`${seed.erasure.tenantId}/`) &&
        !(
          reference.role === "upload" &&
          reference.key === staged.key &&
          reference.targetVersionId === staged.targetVersionId
        ),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const actualReferences = refs
    .map((row) => ({
      role: row.role,
      key: row.key,
      targetVersionId: row.version,
      size: Number(row.size),
      sha256: row.sha256,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences))
    throw new Error("Maintenance changed the committed reference multiset");
  let targetStageMissing = false;
  try {
    await s3.send(
      new GetObjectCommand({
        Bucket: names.targetBucket,
        Key: staged.key,
        VersionId: staged.targetVersionId,
      }),
    );
  } catch (error: any) {
    targetStageMissing = error.$metadata?.httpStatusCode === 404;
  }
  if (!targetStageMissing)
    throw new Error("Maintenance left the target staged object readable");
  const sourceStage = await s3.send(
    new GetObjectCommand({
      Bucket: names.sourceBucket,
      Key: staged.key,
      VersionId: staged.sourceVersionId,
    }),
  );
  const sourceBytes = Buffer.from(
    await sourceStage.Body!.transformToByteArray(),
  );
  if (
    sourceBytes.length !== staged.size ||
    fingerprint(sourceBytes) !== staged.sha256
  )
    throw new Error("Target maintenance affected source staging");
  for (const row of refs) {
    const expected = mapping.find(
      (item) => item.key === row.key && item.targetVersionId === row.version,
    );
    if (!expected || expected.key === stagedKey)
      throw new Error("Committed reference changed during maintenance");
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: names.targetBucket,
        Key: row.key,
        VersionId: row.version,
      }),
    );
    const bytes = Buffer.from(await response.Body!.transformToByteArray());
    if (bytes.length !== Number(row.size) || fingerprint(bytes) !== row.sha256)
      throw new Error("Maintenance damaged a committed object");
  }
  return {
    stagedTargetDeleted: true,
    stagedSourcePreserved: true,
    committedReferencesPreserved: true,
    quotaPreserved: true,
  };
}

async function mutateSourceAfterSnapshot(seed: Seed) {
  const client = new pg.Client({
    connectionString: databaseUrl(names.sourceDatabase),
  });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("UPDATE shares SET revoked=true WHERE id=$1", [
      seed.ids.activeShare,
    ]);
    await client.query(
      "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1",
      [seed.ids.connection],
    );
    await client.query("DELETE FROM sessions WHERE account_id=$1", [
      seed.ids.account,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function verifyDatabaseSentinel(
  admin: pg.Client,
  name: string,
  role: DrillRole,
) {
  const row = (
    await admin.query(
      "SELECT shobj_description(oid,'pg_database') AS value FROM pg_database WHERE datname=$1",
      [name],
    )
  ).rows[0];
  return row?.value === databaseSentinel(role);
}

async function cleanupDatabase(
  admin: pg.Client,
  name: string,
  role: DrillRole,
) {
  assertDrillIdentity(drillId, role, name, names[`${role}Bucket`]);
  if (!(await verifyDatabaseSentinel(admin, name, role)))
    throw new Error(`Refusing to clean unknown ${role} database`);
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [name],
  );
  await admin.query(`DROP DATABASE "${name}"`);
}

async function cleanupBucket(bucket: string, role: DrillRole) {
  assertDrillIdentity(drillId, role, names[`${role}Database`], bucket);
  const sentinel = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: sentinelKey }),
  );
  const bytes = Buffer.from(await sentinel.Body!.transformToByteArray());
  if (!bytes.equals(bucketSentinel(role)))
    throw new Error(`Refusing to clean unknown ${role} bucket`);
  // MinIO can expose more versions immediately after a deletion pass even when
  // the preceding response was not truncated. Re-list from the start until the
  // bucket is observably empty; authorization was already proven by sentinel.
  for (let pass = 0; pass < 100; pass++) {
    const listed = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        MaxKeys: 1000,
      }),
    );
    const stored = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ];
    if (!stored.length) {
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      return;
    }
    for (const item of stored)
      if (item.Key && item.VersionId)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: item.Key,
            VersionId: item.VersionId,
          }),
        );
  }
  throw new Error("Bucket cleanup exceeded pass bound");
}

const started = Date.now();
const directory = await mkdtemp(join(tmpdir(), "polka-restore-drill-"));
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
let report: Record<string, unknown> | null = null;
let syntheticResidueRemoved = false;
try {
  if (
    (await databaseExists(admin, names.sourceDatabase)) ||
    (await databaseExists(admin, names.targetDatabase))
  )
    throw new Error("Synthetic database collision before writes");
  if (
    (await bucketExists(names.sourceBucket)) ||
    (await bucketExists(names.targetBucket)) ||
    (await bucketExists(names.ledgerBucket))
  )
    throw new Error("Synthetic bucket collision before writes");
  await createDatabase(admin, names.sourceDatabase, "source");
  await createDatabase(admin, names.targetDatabase, "target");
  await createBucket(names.sourceBucket, "source");
  await createBucket(names.targetBucket, "target");
  await createLedgerBucket();
  await applyMigrations(names.sourceDatabase);
  const erasureLedgerId = randomUUID();
  const ledger = createErasureLedgerS3Transport({
    client: s3,
    bucket: names.ledgerBucket,
    bodyTimeoutMs: 5_000,
  });
  const linkKey = randomBytes(64).toString("base64url");
  const wrappingKey = randomBytes(32);
  const encryptedSecret = encryptSecret(linkKey, wrappingKey);
  await writeFile(join(directory, "secrets.enc"), encryptedSecret, {
    mode: 0o600,
  });
  const seed = await seedSource(linkKey);
  const sourceAgent = await proveSourceAgentReplay(seed, linkKey);
  await trashSourceFixture(seed, linkKey);
  const container = await dockerPostgresContainer();
  const dumpPath = join(directory, "database.dump");
  await dumpDatabase(container, dumpPath);
  const dump = await readFile(dumpPath);
  await writeFile(
    join(directory, "database.dump.sha256"),
    `${fingerprint(dump)}  database.dump\n`,
    { mode: 0o600 },
  );
  const references = await collectObjects(directory);
  const backup = {
    formatVersion: 1,
    backupId: drillId,
    cutoffAt: new Date().toISOString(),
    schemaMigrations: [...EXPECTED_MIGRATION_VERSIONS],
    databaseSha256: fingerprint(dump),
    objectManifestSha256: fingerprint(
      await readFile(join(directory, "objects.jsonl")),
    ),
    linkKeyFingerprint: fingerprint(linkKey),
    objectReferences: references.length,
    erasureLedgerId,
  };
  await writeFile(
    join(directory, "backup.json"),
    JSON.stringify(backup, null, 2),
    { mode: 0o600 },
  );
  // The backup owns its private object copy before the live source tenant is
  // actually purged. The worker writes both external ledger records.
  const sourcePurge = await purgeSourceErasure(
    seed,
    erasureLedgerId,
    ledger,
  );
  // The complete external journal is loaded and bound to the backup before
  // pg_restore or any target object write begins.
  const erasurePlan = await loadErasureRestorePlan(
    ledger,
    erasureLedgerId,
    new AbortController().signal,
  );
  const loadedBackup = await loadBackup(directory, linkKey, erasurePlan);
  await mutateSourceAfterSnapshot(seed);
  await restoreDatabase(container, dumpPath);
  const mapping = await restoreObjects(directory, loadedBackup.references);
  const restoredLinkKey = decryptSecret(
    await readFile(join(directory, "secrets.enc")),
    wrappingKey,
  );
  await remapAndClose(mapping);
  const erasure = await applyErasureBarrier(seed, erasurePlan, ledger);
  const verified = await verify(seed, sourceAgent, mapping, restoredLinkKey);
  const maintenance = await proveMaintenanceCleanup(
    seed,
    mapping,
    restoredLinkKey,
  );
  report = {
    drill: "synthetic-local",
    backupId: drillId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    objectReferences: loadedBackup.references.length,
    remappedVersions: mapping.length,
    oldRecipientStatus: verified.resolve,
    previouslyRevokedRecipientStatus: verified.revokedResolve,
    oldSessionStatus: verified.me,
    oldAgentDenied: verified.agentDenied,
    shareTokenHashesVerified: verified.tokenHashes,
    freshOwnerLogin: verified.freshLogin && verified.freshIdentity,
    ownerSourceAndExportExact: verified.singleExact && verified.exportExact,
    explicitNewShare: verified.newShare && verified.newResolve,
    rejectedAgentReplaysStable:
      verified.agentReplaysDenied && verified.agentStateUnchanged,
    trashStatePreserved: verified.trashStatePreserved,
    explicitTrashRestore: verified.explicitRestore,
    maintenance,
    erasure,
    sourcePurge,
    erasureLedgerLoadedBeforeRestore: true,
    erasureAppliedBeforeAppCreation: true,
    quotaBytes: seed.quotas,
    elapsedMs: Date.now() - started,
    sourceMutatedAfterSnapshot: true,
    failClosed: true,
    productionRestoreProven: false,
  };
} finally {
  const cleanupErrors: string[] = [];
  if (created.ledgerBucket)
    try {
      const sentinel = await s3.send(
        new GetObjectCommand({
          Bucket: names.ledgerBucket,
          Key: sentinelKey,
        }),
      );
      const bytes = Buffer.from(await sentinel.Body!.transformToByteArray());
      if (!bytes.equals(ledgerSentinel))
        throw new Error("Refusing to clean unknown erasure ledger bucket");
      for (let pass = 0; pass < 100; pass++) {
        const listed = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: names.ledgerBucket,
            MaxKeys: 1000,
          }),
        );
        const stored = [
          ...(listed.Versions ?? []),
          ...(listed.DeleteMarkers ?? []),
        ];
        if (!stored.length) {
          await s3.send(
            new DeleteBucketCommand({ Bucket: names.ledgerBucket }),
          );
          break;
        }
        for (const item of stored)
          if (item.Key && item.VersionId)
            await s3.send(
              new DeleteObjectCommand({
                Bucket: names.ledgerBucket,
                Key: item.Key,
                VersionId: item.VersionId,
              }),
            );
        if (pass === 99)
          throw new Error("Erasure ledger cleanup exceeded pass bound");
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  for (const role of ["target", "source"] as const) {
    if (created[`${role}Bucket`])
      try {
        await cleanupBucket(names[`${role}Bucket`], role);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    if (created[`${role}Database`])
      try {
        await cleanupDatabase(admin, names[`${role}Database`], role);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
  }
  if (!cleanupErrors.length) {
    const databasesRemain =
      (await databaseExists(admin, names.sourceDatabase)) ||
      (await databaseExists(admin, names.targetDatabase));
    const bucketsRemain =
      (await bucketExists(names.sourceBucket)) ||
      (await bucketExists(names.targetBucket)) ||
      (await bucketExists(names.ledgerBucket));
    if (databasesRemain || bucketsRemain)
      cleanupErrors.push("Synthetic residue remains after cleanup");
    else syntheticResidueRemoved = true;
  }
  await admin.end();
  s3.destroy();
  await rm(directory, { recursive: true, force: true });
  if (cleanupErrors.length)
    throw new Error(`Synthetic cleanup failed: ${cleanupErrors.join("; ")}`);
}
if (!report) throw new Error("Restore drill did not produce a report");
report.syntheticResidueRemoved = syntheticResidueRemoved;
process.stdout.write(`${JSON.stringify(report)}\n`);
