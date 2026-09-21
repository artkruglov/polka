import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  encodeErasureRecord,
  type RevokeRecord,
} from "../packages/erasure-ledger.ts";
import { runAccountPurge } from "../scripts/account-purge.ts";
import { reconcileErasureRestore } from "../scripts/erasure-restore-reconcile.ts";
import {
  assertErasureRestorePlanStable,
  loadErasureRestorePlan,
} from "../scripts/erasure-restore.ts";
import { appendErasureRecord } from "../scripts/erasure-ledger-adapter.ts";
import { createErasureLedgerS3Transport } from "../scripts/erasure-ledger-s3.ts";
import {
  createMaintenanceDatabase,
  createMaintenanceObjectStore,
} from "../scripts/maintenance-adapters.ts";
import { runMaintenanceGuard } from "../scripts/maintenance-guard.ts";
import type { MaintenanceScope } from "../scripts/maintenance-cleanup.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const runId = required("PURGE_RESTORE_TEST_RUN_ID");
const expectedDatabase = `polka_r17_test_${runId}`;
const urls = {
  purge: new URL(required("DATABASE_URL")),
  owner: new URL(required("PURGE_RESTORE_TEST_OWNER_DATABASE_URL")),
  restore: new URL(required("PURGE_RESTORE_TEST_RESTORE_DATABASE_URL")),
  runtime: new URL(required("PURGE_RESTORE_TEST_RUNTIME_DATABASE_URL")),
};
const roles = {
  purge: `polka_purge_${runId}`,
  owner: `polka_schema_${runId}`,
  restore: `polka_restore_${runId}`,
  runtime: `polka_runtime_${runId}`,
};
const endpointIdentity = `${urls.purge.protocol}//${urls.purge.hostname}:${urls.purge.port}`;
const contentBucket = required("PURGE_RESTORE_TEST_CONTENT_BUCKET");
const ledgerBucket = required("PURGE_RESTORE_TEST_LEDGER_BUCKET");
const s3Endpoint = new URL(required("S3_ENDPOINT"));
if (
  !/^[a-z0-9]{10,24}$/.test(runId) ||
  contentBucket !== `polka-r17-test-${runId}` ||
  ledgerBucket !== `polka-r17-ledger-${runId}` ||
  contentBucket === ledgerBucket ||
  Object.entries(urls).some(([key, url]) =>
    url.username !== roles[key as keyof typeof roles] ||
    url.pathname !== `/${expectedDatabase}` ||
    `${url.protocol}//${url.hostname}:${url.port}` !== endpointIdentity ||
    !!url.search || !!url.hash ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  ) ||
  !["127.0.0.1", "localhost"].includes(s3Endpoint.hostname) ||
  s3Endpoint.port !== "9038" ||
  !!s3Endpoint.search || !!s3Endpoint.hash ||
  required("S3_ACCESS_KEY") !== "polka-local"
)
  throw new Error("Purge/restore S3 test requires guarded isolated resources");

const pgOptions = (url: URL) => ({
  connectionString: url.toString(),
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});
const owner = new pg.Client(pgOptions(urls.owner));
const identities = {
  purge: new pg.Client(pgOptions(urls.purge)),
  restore: new pg.Client(pgOptions(urls.restore)),
  runtime: new pg.Client(pgOptions(urls.runtime)),
};
const s3 = new S3Client({
  endpoint: s3Endpoint.origin,
  region: "us-east-1",
  forcePathStyle: true,
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 1_000,
    requestTimeout: 5_000,
  }),
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY"),
    secretAccessKey: required("S3_SECRET_KEY"),
  },
});
const content = createMaintenanceObjectStore({
  endpoint: s3Endpoint.origin,
  region: "us-east-1",
  accessKey: required("S3_ACCESS_KEY"),
  secretKey: required("S3_SECRET_KEY"),
  bucket: contentBucket,
});
const ledger = createErasureLedgerS3Transport({
  client: s3,
  bucket: ledgerBucket,
  bodyTimeoutMs: 5_000,
});
const signal = new AbortController();
const ids = {
  ledger: randomUUID(),
  ordinaryAccount: randomUUID(),
  ordinaryTenant: randomUUID(),
  ordinaryDeletion: randomUUID(),
  revokedAccount: randomUUID(),
  revokedTenant: randomUUID(),
  revokedDeletion: randomUUID(),
  revokedArtifact: randomUUID(),
  revokedRevision: randomUUID(),
  revokedShare: randomUUID(),
  revokedConnection: randomUUID(),
  absentAccount: randomUUID(),
  absentTenant: randomUUID(),
  absentDeletion: randomUUID(),
  neighborAccount: randomUUID(),
  neighborTenant: randomUUID(),
  restoreRun: randomUUID(),
};
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const passwordHash = `${"a".repeat(32)}:${"b".repeat(128)}`;
const neighborBytes = Buffer.from("neighbor remains exact");
let neighborVersion = "";

async function identity(client: pg.Client, role: string) {
  const row = (
    await client.query(
      `SELECT current_user,session_user,current_database(),
              shobj_description(oid,'pg_database') AS sentinel
         FROM pg_database WHERE datname=current_database()`,
    )
  ).rows[0];
  assert.deepEqual(row, {
    current_user: role,
    session_user: role,
    current_database: expectedDatabase,
    sentinel: `polka-r17-test:${runId}`,
  });
}

async function body(bucket: string, key: string, versionId?: string) {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    { abortSignal: AbortSignal.timeout(5_000) },
  );
  return Buffer.from(await response.Body!.transformToByteArray());
}

async function put(bucket: string, key: string, value: Buffer) {
  const result = await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: value }),
    { abortSignal: AbortSignal.timeout(5_000) },
  );
  assert.ok(result.VersionId && result.VersionId !== "null");
  return result.VersionId;
}

async function versions(bucket: string, prefix: string) {
  const result = await s3.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
    { abortSignal: AbortSignal.timeout(5_000) },
  );
  assert.equal(result.IsTruncated, false);
  return [
    ...(result.Versions ?? []).map((value) => ({
      kind: "version" as const,
      key: value.Key!,
      versionId: value.VersionId!,
    })),
    ...(result.DeleteMarkers ?? []).map((value) => ({
      kind: "marker" as const,
      key: value.Key!,
      versionId: value.VersionId!,
    })),
  ];
}

async function guarded<T>(databaseUrl: URL, run: (scope: MaintenanceScope) => Promise<T>) {
  const database = createMaintenanceDatabase(databaseUrl.toString());
  const query = database.query.bind(database);
  let failure: { operation: string; sqlstate: string; constraint?: string } | undefined;
  database.query = async (sql, values) => {
    try {
      return await query(sql, values);
    } catch (error: any) {
      const functionName = sql.match(
        /(?:FROM|SELECT)\s+(?:\*\s+FROM\s+)?([a-z_][a-z0-9_]*)\s*\(/i,
      )?.[1];
      failure ??= {
        operation: functionName ?? sql.trim().split(/\s+/)[0]?.toLowerCase() ?? "query",
        sqlstate: typeof error?.code === "string" ? error.code : "unknown",
        constraint:
          typeof error?.constraint === "string" &&
          /^[a-z_][a-z0-9_]{0,127}$/.test(error.constraint)
            ? error.constraint
            : undefined,
      };
      throw error;
    }
  };
  await database.connect();
  const result = await runMaintenanceGuard({
    client: database,
    signal: signal.signal,
    run,
  });
  if (result.state !== "completed")
    throw new Error(
      `Guarded maintenance did not complete: ${result.state}` +
      (failure
        ? ` (${failure.operation}:${failure.sqlstate}${failure.constraint ? `:${failure.constraint}` : ""})`
        : ""),
    );
  return result.value;
}

function revokeRecord(input: {
  requestId: string;
  accountId: string;
  tenantId: string;
}): RevokeRecord {
  return {
    schemaVersion: 1,
    event: "revoke",
    ledgerId: ids.ledger,
    requestId: input.requestId,
    accountId: input.accountId,
    tenantId: input.tenantId,
    requestedAt: "2020-09-21T10:00:00.000Z",
    revokedAt: "2020-09-21T10:00:01.000Z",
    policyVersion: "restore-s3-v1",
    workingDataPolicyDeadline: "2020-09-21T11:00:00.000Z",
    backupRetentionPolicyDeadline: "2020-09-22T10:00:00.000Z",
  };
}

async function seedDatabase() {
  const ordinaryEmail = `ordinary-${runId}@example.test`;
  const revokedEmail = `revoked-${runId}@example.test`;
  const revokedBytes = Buffer.from("restored old revision");
  const revokedKey = `${ids.revokedTenant}/old-revision`;
  const revokedVersion = await put(contentBucket, revokedKey, revokedBytes);
  const ordinaryKey = `${ids.ordinaryTenant}/multi-version`;
  await put(contentBucket, ordinaryKey, Buffer.from("first version"));
  await put(contentBucket, ordinaryKey, Buffer.from("second version"));
  const marker = await s3.send(
    new DeleteObjectCommand({ Bucket: contentBucket, Key: ordinaryKey }),
    { abortSignal: AbortSignal.timeout(5_000) },
  );
  assert.ok(marker.VersionId && marker.VersionId !== "null");
  await put(
    contentBucket,
    `${ids.ordinaryTenant}/orphan`,
    Buffer.from("unreferenced source"),
  );
  await put(
    contentBucket,
    `${ids.absentTenant}/snapshot-orphan`,
    Buffer.from("metadata absent source"),
  );
  neighborVersion = await put(
    contentBucket,
    `${ids.neighborTenant}/neighbor`,
    neighborBytes,
  );

  await owner.query("BEGIN");
  try {
    for (const [accountId, tenantId, name, email, used] of [
      [ids.ordinaryAccount, ids.ordinaryTenant, `ordinary-${runId}`, ordinaryEmail, 40],
      [ids.revokedAccount, ids.revokedTenant, `revoked-${runId}`, revokedEmail, revokedBytes.length],
      [ids.neighborAccount, ids.neighborTenant, `neighbor-${runId}`, `neighbor-${runId}@example.test`, neighborBytes.length],
    ] as const) {
      await owner.query(
        "INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at) VALUES($1,$2,$3,$4,$5,now())",
        [accountId, name, passwordHash, email, name,],
      );
      await owner.query(
        "INSERT INTO tenants(id,owner_id,used_bytes,derivative_used_bytes) VALUES($1,$2,$3,0)",
        [tenantId, accountId, used],
      );
    }
    await owner.query(
      `INSERT INTO sessions(hash,account_id,expires_at)
       VALUES($1,$2,now()+interval '1 day')`,
      [hash(`revoked-session-${runId}`), ids.revokedAccount],
    );
    await owner.query(
      `INSERT INTO agent_connections(
         id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
       ) VALUES($1,$2,$3,$4,'restore fixture',ARRAY['context'],$5,now()+interval '1 day')`,
      [
        ids.revokedConnection,
        ids.revokedTenant,
        ids.revokedAccount,
        hash(`revoked-agent-${runId}`),
        "http://127.0.0.1:4390/mcp",
      ],
    );
    await owner.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Old restored title')",
      [ids.revokedArtifact, ids.revokedTenant, ids.revokedAccount],
    );
    await owner.query(
      `INSERT INTO revisions(
         id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
         object_key,object_version,storage_kind,total_size
       ) VALUES($1,$2,$3,1,$4,'old.txt','text/plain',$5,$6,$7,$8,'single',$5)`,
      [
        ids.revokedRevision,
        ids.revokedTenant,
        ids.revokedArtifact,
        ids.revokedAccount,
        revokedBytes.length,
        hash(revokedBytes),
        revokedKey,
        revokedVersion,
      ],
    );
    await owner.query(
      "UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1",
      [ids.revokedArtifact, ids.revokedRevision],
    );
    await owner.query(
      `INSERT INTO shares(
         id,tenant_id,artifact_id,revision_id,token_hash,revoked,expires_at
       ) VALUES($1,$2,$3,$4,$5,false,now()+interval '1 day')`,
      [
        ids.revokedShare,
        ids.revokedTenant,
        ids.revokedArtifact,
        ids.revokedRevision,
        hash(`revoked-share-${runId}`),
      ],
    );
    await owner.query(
      `INSERT INTO account_deletions(
         id,account_id,tenant_id,state,status_capability_hash,plan_expires_at,
         artifact_count,revision_count,source_bytes,derivative_bytes,
         policy_version,purge_max_hours,backup_retention_max_days
       ) VALUES($1,$2,$3,'planned',$4,now()+interval '10 minutes',0,0,40,0,'restore-s3-v1',24,1)`,
      [ids.ordinaryDeletion, ids.ordinaryAccount, ids.ordinaryTenant, hash(randomUUID())],
    );
    await owner.query(
      "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
      [ids.ordinaryAccount],
    );
    await owner.query(
      `UPDATE account_deletions SET state='access_revoked_pending_purge',
         requested_at=clock_timestamp(),revoked_at=clock_timestamp(),
         working_data_policy_deadline=clock_timestamp()+interval '24 hours',
         backup_retention_policy_deadline=clock_timestamp()+interval '1 day',
         confirmation_session_hash=$2 WHERE id=$1`,
      [ids.ordinaryDeletion, hash(randomUUID())],
    );
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

before(async () => {
  await Promise.all([
    owner.connect(),
    ...Object.values(identities).map((client) => client.connect()),
  ]);
  await Promise.all([
    identity(owner, roles.owner),
    identity(identities.purge, roles.purge),
    identity(identities.restore, roles.restore),
    identity(identities.runtime, roles.runtime),
  ]);
  assert.equal(
    (await body(contentBucket, ".polka-r17-test")).toString("utf8"),
    `polka-r17-test:${runId}`,
  );
  assert.equal(
    (await body(ledgerBucket, ".polka-r17-test")).toString("utf8"),
    `polka-r17-ledger:${runId}`,
  );
  await seedDatabase();
});

after(async () => {
  signal.abort();
  content.close();
  s3.destroy();
  await Promise.all([
    owner.end(),
    ...Object.values(identities).map((client) => client.end()),
  ]);
});

test("real versioned purge and pre-open restore suppression preserve journal and neighbor", { timeout: 150_000 }, async () => {
  const ordinary = await guarded(urls.purge, (scope) =>
    runAccountPurge(scope, {
      ledgerId: ids.ledger,
      ledger,
      content,
      now: () => new Date(),
    }),
  );
  assert.deepEqual(ordinary, {
    jobsClaimed: 1,
    revokeRecordsAcknowledged: 1,
    sourceVersionsDeleted: 4,
    sourcePrefixesVerifiedEmpty: 1,
    metadataPurged: 1,
    terminalRecordsAcknowledged: 1,
  });
  assert.deepEqual(await versions(contentBucket, `${ids.ordinaryTenant}/`), []);

  // A content backup can be restored after the DB already says purged.
  await put(
    contentBucket,
    `${ids.ordinaryTenant}/restored-after-purge`,
    Buffer.from("stale backup bytes"),
  );
  const revokedRecord = revokeRecord({
    requestId: ids.revokedDeletion,
    accountId: ids.revokedAccount,
    tenantId: ids.revokedTenant,
  });
  const absentRecord = revokeRecord({
    requestId: ids.absentDeletion,
    accountId: ids.absentAccount,
    tenantId: ids.absentTenant,
  });
  await appendErasureRecord(ledger, revokedRecord, ids.ledger, signal.signal);
  await appendErasureRecord(ledger, absentRecord, ids.ledger, signal.signal);
  const beforePlan = await loadErasureRestorePlan(ledger, ids.ledger, signal.signal);
  assert.equal(beforePlan.entries.length, 3);
  assert.equal(
    beforePlan.entries.find((entry) => entry.requestId === ids.ordinaryDeletion)?.state,
    "purged",
  );

  // Failed preload must not register any target reconciliation state.
  for (const failingLedger of [
    { ...ledger, async list() { throw new Error("Injected journal unavailable"); } },
    { ...ledger, async list() { return { items: [{ key: "invalid", versionId: "v1", bytes: Buffer.from("not-json") }] }; } },
  ]) {
    await assert.rejects(loadErasureRestorePlan(failingLedger, ids.ledger, signal.signal));
    assert.equal(Number((await owner.query(
      "SELECT count(*) FROM account_restore_suppressions WHERE restore_run_id=$1", [ids.restoreRun],
    )).rows[0].count), 0);
  }

  // Real first deletion succeeds; the second exact-version request fails.
  let deleteCalls = 0;
  let successfulDeletes = 0;
  let reconciliationCompleted = false;
  const failingContent = {
    ...content,
    async deleteVersion(key: string, versionId: string, abortSignal: AbortSignal) {
      if (++deleteCalls === 2) throw new Error("Injected exact deletion failure");
      await content.deleteVersion(key, versionId, abortSignal);
      successfulDeletes++;
    },
  };
  await assert.rejects(guarded(urls.restore, async (scope) => {
    const value = await reconcileErasureRestore({ scope, content: failingContent,
      ledger, plan: beforePlan, restoreRunId: ids.restoreRun });
    reconciliationCompleted = true;
    return value;
  }));
  assert.equal(deleteCalls, 2);
  assert.equal(successfulDeletes, 1);
  assert.equal(reconciliationCompleted, false);
  const interruptedPlan = await loadErasureRestorePlan(ledger, ids.ledger, signal.signal);
  assert.doesNotThrow(() => assertErasureRestorePlanStable(beforePlan, interruptedPlan));

  // Same target generation and run id resume the persisted checkpoints.
  const restored = await guarded(urls.restore, (scope) =>
    reconcileErasureRestore({
      scope,
      content,
      ledger,
      plan: beforePlan,
      restoreRunId: ids.restoreRun,
    }),
  );
  assert.equal(restored.entriesCompleted, 3);
  assert.equal(restored.metadataTenantsCompleted, 2);
  assert.equal(restored.absentTenantsCompleted, 1);
  assert.equal(restored.sourceVersionsDeleted, 2);
  assert.ok(restored.metadataPurged >= 1 && restored.metadataPurged <= 2);
  const repeated = await guarded(urls.restore, (scope) =>
    reconcileErasureRestore({ scope, content, ledger, plan: beforePlan, restoreRunId: ids.restoreRun }));
  assert.deepEqual(repeated, { entriesCompleted: 3, metadataTenantsCompleted: 2,
    absentTenantsCompleted: 1, sourceVersionsDeleted: 0, metadataPurged: 0 });

  for (const tenantId of [ids.ordinaryTenant, ids.revokedTenant, ids.absentTenant])
    assert.deepEqual(await versions(contentBucket, `${tenantId}/`), []);
  assert.deepEqual(
    await body(contentBucket, `${ids.neighborTenant}/neighbor`, neighborVersion),
    neighborBytes,
  );
  assert.equal(
    Number((await owner.query("SELECT count(*) FROM accounts WHERE id=$1", [ids.absentAccount])).rows[0].count),
    0,
  );
  assert.equal(
    Number((await owner.query("SELECT count(*) FROM tenants WHERE id=$1", [ids.absentTenant])).rows[0].count),
    0,
  );
  const revoked = (
    await owner.query(
      `SELECT account.email,account.display_name,deletion.state,job.phase,
              suppression.state AS suppression_state
         FROM accounts account
         JOIN account_deletions deletion ON deletion.account_id=account.id
         JOIN account_purge_jobs job ON job.deletion_id=deletion.id
         JOIN account_restore_suppressions suppression ON suppression.deletion_id=deletion.id
        WHERE account.id=$1`,
      [ids.revokedAccount],
    )
  ).rows[0];
  assert.deepEqual(revoked, {
    email: null,
    display_name: null,
    state: "access_revoked_pending_purge",
    phase: "restore_suppressed",
    suppression_state: "completed",
  });
  assert.equal(
    Number((await owner.query("SELECT count(*) FROM sessions WHERE account_id=$1", [ids.revokedAccount])).rows[0].count),
    0,
  );
  assert.equal(
    Number((await owner.query("SELECT count(*) FROM agent_connections WHERE account_id=$1", [ids.revokedAccount])).rows[0].count),
    0,
  );
  assert.equal(
    Number((await owner.query("SELECT count(*) FROM artifacts WHERE tenant_id=$1", [ids.revokedTenant])).rows[0].count),
    0,
  );
  const ordinaryLedger = beforePlan.entries.find(
    (entry) => entry.requestId === ids.ordinaryDeletion,
  );
  assert.equal(ordinaryLedger?.state, "purged");
  const ordinaryReceipt = (
    await owner.query("SELECT state,purged_at FROM account_deletions WHERE id=$1", [
      ids.ordinaryDeletion,
    ])
  ).rows[0];
  assert.equal(ordinaryReceipt.state, "purged");
  assert.equal(
    new Date(ordinaryReceipt.purged_at).toISOString(),
    ordinaryLedger?.purged?.metadataPurgedAt,
  );
  const neighbor = (
    await owner.query("SELECT disabled,email FROM accounts WHERE id=$1", [ids.neighborAccount])
  ).rows[0];
  assert.equal(neighbor.disabled, false);
  assert.equal(neighbor.email, `neighbor-${runId}@example.test`);
  assert.equal(
    Number((await owner.query("SELECT count(*) FROM account_restore_suppressions WHERE restore_run_id=$1 AND state='completed'", [ids.restoreRun])).rows[0].count),
    3,
  );

  const afterPlan = await loadErasureRestorePlan(ledger, ids.ledger, signal.signal);
  assert.doesNotThrow(() => assertErasureRestorePlanStable(beforePlan, afterPlan));
  assert.deepEqual(
    afterPlan.records.map(({ key, versionId, sha256 }) => ({ key, versionId, sha256 })),
    beforePlan.records.map(({ key, versionId, sha256 }) => ({ key, versionId, sha256 })),
  );
  const ordinaryClaim = await identities.purge.query(
    "SELECT * FROM claim_account_purge_job($1,$2)",
    [randomUUID(), ids.ledger],
  );
  assert.equal(ordinaryClaim.rows[0]?.deletion_id ?? null, null);
  assert.equal(encodeErasureRecord(revokedRecord).record.event, "revoke");
});
