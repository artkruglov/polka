import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

const runId = process.env.RESTORE_TEST_RUN_ID ?? "";
const expectedDatabase = `polka_r17_test_${runId}`;
const roles = {
  restore: `polka_restore_${runId}`,
  owner: `polka_schema_${runId}`,
  purge: `polka_purge_${runId}`,
  runtime: `polka_runtime_${runId}`,
};
const urls = {
  restore: new URL(process.env.DATABASE_URL ?? "http://invalid"),
  owner: new URL(process.env.RESTORE_TEST_OWNER_DATABASE_URL ?? "http://invalid"),
  purge: new URL(process.env.RESTORE_TEST_PURGE_DATABASE_URL ?? "http://invalid"),
  runtime: new URL(process.env.RESTORE_TEST_RUNTIME_DATABASE_URL ?? "http://invalid"),
};
const endpoint = `${urls.restore.hostname}:${urls.restore.port}`;
if (
  !/^[a-z0-9]{10,24}$/.test(runId) ||
  Object.entries(urls).some(([name, url]) =>
    url.username !== roles[name as keyof typeof roles] ||
    url.pathname !== `/${expectedDatabase}` ||
    `${url.hostname}:${url.port}` !== endpoint ||
    !!url.search || !!url.hash ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
)
  throw new Error("Restore SQL tests require guarded isolated identities");

const options = (url: URL) => ({
  connectionString: url.toString(),
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});
const clients = {
  restore: new pg.Client(options(urls.restore)),
  owner: new pg.Client(options(urls.owner)),
  purge: new pg.Client(options(urls.purge)),
  runtime: new pg.Client(options(urls.runtime)),
};
const ids = {
  restoreRun: randomUUID(),
  ledger: randomUUID(),
  revokedAccount: randomUUID(),
  revokedTenant: randomUUID(),
  revokedDeletion: randomUUID(),
  revokedAttempt: randomUUID(),
  purgedAccount: randomUUID(),
  purgedTenant: randomUUID(),
  purgedDeletion: randomUUID(),
  purgedAttempt: randomUUID(),
  absentAccount: randomUUID(),
  absentTenant: randomUUID(),
  absentDeletion: randomUUID(),
  ordinaryAttempt: randomUUID(),
};
const timeline = {
  requested: "2020-09-21T10:00:00.000Z",
  revoked: "2020-09-21T10:00:01.000Z",
  working: "2020-09-21T11:00:00.000Z",
  backup: "2020-09-22T10:00:00.000Z",
  source: "2020-09-21T10:00:02.000Z",
  mail: "2020-09-21T10:00:03.000Z",
  metadata: "2020-09-21T10:00:04.000Z",
};

async function exactIdentity(
  client: pg.Client,
  expectedRole: string,
) {
  const row = (
    await client.query(
      `SELECT current_user,session_user,current_database(),
              shobj_description(oid,'pg_database') AS sentinel
         FROM pg_database WHERE datname=current_database()`,
    )
  ).rows[0];
  assert.deepEqual(row, {
    current_user: expectedRole,
    session_user: expectedRole,
    current_database: expectedDatabase,
    sentinel: `polka-r17-test:${runId}`,
  });
}

async function denied(client: pg.Client, sql: string, values: unknown[] = []) {
  await client.query("BEGIN");
  try {
    await client.query(sql, values);
    assert.fail("Expected SQLSTATE 42501");
  } catch (error: any) {
    assert.equal(error.code, "42501");
  } finally {
    await client.query("ROLLBACK");
  }
}

function registerValues(input: {
  deletionId: string;
  accountId: string;
  tenantId: string;
  state: "revoked" | "purged";
}) {
  const prefix = `erasure/v1/${ids.ledger}/${input.deletionId}`;
  return [
    ids.restoreRun,
    input.deletionId,
    input.accountId,
    input.tenantId,
    ids.ledger,
    input.state,
    timeline.requested,
    timeline.revoked,
    "restore-test-v1",
    timeline.working,
    timeline.backup,
    `${prefix}/revoke.json`,
    input.state === "revoked" ? "1".repeat(64) : "2".repeat(64),
    input.state === "revoked" ? "revoke-v1" : "revoke-v2",
    input.state === "purged" ? `${prefix}/purged.json` : null,
    input.state === "purged" ? "3".repeat(64) : null,
    input.state === "purged" ? "purged-v2" : null,
    input.state === "purged" ? timeline.source : null,
    input.state === "purged" ? timeline.mail : null,
    input.state === "purged" ? timeline.metadata : null,
    input.state === "revoked" ? "4".repeat(64) : "5".repeat(64),
    input.state === "revoked" ? "6".repeat(64) : "7".repeat(64),
  ];
}

const registerSql = `SELECT register_restored_erasure(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
  $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
) AS metadata_present`;

async function finishMetadataRestore(
  deletionId: string,
  attemptId: string,
) {
  const claim = (
    await clients.restore.query(
      "SELECT * FROM claim_restored_account_purge_job($1,$2,$3,$4)",
      [ids.restoreRun, deletionId, attemptId, ids.ledger],
    )
  ).rows[0];
  assert.equal(claim.deletion_id, deletionId);
  assert.equal(claim.phase, "deleting_source");
  await clients.restore.query(
    "SELECT mark_account_purge_source_empty($1,$2,$3)",
    [deletionId, attemptId, timeline.source],
  );
  const mail = (
    await clients.restore.query("SELECT * FROM lock_account_purge_mail($1,$2)", [
      deletionId,
      attemptId,
    ])
  ).rows[0];
  assert.deepEqual(mail.challenges, []);
  await clients.restore.query(
    "SELECT complete_account_purge_mail($1,$2,$3,$4)",
    [deletionId, attemptId, timeline.mail, []],
  );
  const terminal = (
    await clients.restore.query(
      "SELECT * FROM terminal_erase_account_metadata($1,$2,$3)",
      [deletionId, attemptId, `${"8".repeat(32)}:${"9".repeat(128)}`],
    )
  ).rows[0];
  assert.equal(terminal.phase, "metadata_purged");
  assert.equal(
    (
      await clients.restore.query(
        "SELECT acknowledge_historic_restored_purge($1,$2,$3) AS value",
        [ids.restoreRun, deletionId, attemptId],
      )
    ).rows[0].value,
    true,
  );
}

before(async () => {
  await Promise.all(Object.values(clients).map((client) => client.connect()));
  await Promise.all([
    exactIdentity(clients.restore, roles.restore),
    exactIdentity(clients.owner, roles.owner),
    exactIdentity(clients.purge, roles.purge),
    exactIdentity(clients.runtime, roles.runtime),
  ]);
  await clients.owner.query("BEGIN");
  try {
    for (const [accountId, tenantId, suffix] of [
      [ids.revokedAccount, ids.revokedTenant, "revoked"],
      [ids.purgedAccount, ids.purgedTenant, "purged"],
    ]) {
      await clients.owner.query(
        "INSERT INTO accounts(id,name,password_hash,email) VALUES($1,$2,$3,$4)",
        [
          accountId,
          `restore-${suffix}-${runId}`,
          `${"a".repeat(32)}:${"b".repeat(128)}`,
          `restore-${suffix}-${runId}@example.test`,
        ],
      );
      await clients.owner.query(
        "INSERT INTO tenants(id,owner_id,used_bytes,derivative_used_bytes) VALUES($1,$2,0,0)",
        [tenantId, accountId],
      );
    }
    await clients.owner.query("COMMIT");
  } catch (error) {
    await clients.owner.query("ROLLBACK");
    throw error;
  }
});

after(async () => {
  await Promise.all(Object.values(clients).map((client) => client.end()));
});

test("restore identity alone can register historic erasure state", async () => {
  await denied(clients.restore, "SELECT * FROM account_restore_suppressions");
  await denied(
    clients.restore,
    "SELECT * FROM claim_account_purge_job($1,$2)",
    [randomUUID(), ids.ledger],
  );
  for (const client of [clients.runtime, clients.purge])
    await denied(client, registerSql, registerValues({
      deletionId: ids.absentDeletion,
      accountId: ids.absentAccount,
      tenantId: ids.absentTenant,
      state: "revoked",
    }));
});

test("restore registration is exact, idempotent and invisible to ordinary purge", async () => {
  const revoked = registerValues({
    deletionId: ids.revokedDeletion,
    accountId: ids.revokedAccount,
    tenantId: ids.revokedTenant,
    state: "revoked",
  });
  assert.equal((await clients.restore.query(registerSql, revoked)).rows[0].metadata_present, true);
  assert.equal((await clients.restore.query(registerSql, revoked)).rows[0].metadata_present, true);
  const nullKey = [...revoked];
  nullKey[11] = null;
  await assert.rejects(
    clients.restore.query(registerSql, nullKey),
    /invalid restore erasure registration/,
  );

  const purged = registerValues({
    deletionId: ids.purgedDeletion,
    accountId: ids.purgedAccount,
    tenantId: ids.purgedTenant,
    state: "purged",
  });
  assert.equal((await clients.restore.query(registerSql, purged)).rows[0].metadata_present, true);
  const changedProof = [...purged];
  changedProof[19] = "2020-09-21T10:00:05.000Z";
  await assert.rejects(
    clients.restore.query(registerSql, changedProof),
    /conflicting restore erasure registration/,
  );

  const ordinary = await clients.purge.query(
    "SELECT * FROM claim_account_purge_job($1,$2)",
    [ids.ordinaryAttempt, ids.ledger],
  );
  assert.equal(ordinary.rows[0]?.deletion_id ?? null, null);
});

test("historic completion scrubs restored metadata without rewriting ledger timestamps", async () => {
  await finishMetadataRestore(ids.revokedDeletion, ids.revokedAttempt);
  await finishMetadataRestore(ids.purgedDeletion, ids.purgedAttempt);

  const revoked = (
    await clients.owner.query(
      `SELECT deletion.state AS deletion_state,deletion.purged_at,job.phase,
              suppression.state AS suppression_state
         FROM account_deletions deletion
         JOIN account_purge_jobs job ON job.deletion_id=deletion.id
         JOIN account_restore_suppressions suppression ON suppression.deletion_id=deletion.id
        WHERE deletion.id=$1`,
      [ids.revokedDeletion],
    )
  ).rows[0];
  assert.deepEqual(revoked, {
    deletion_state: "access_revoked_pending_purge",
    purged_at: null,
    phase: "restore_suppressed",
    suppression_state: "completed",
  });
  const purged = (
    await clients.owner.query(
      `SELECT deletion.state AS deletion_state,deletion.purged_at,job.phase,
              suppression.state AS suppression_state
         FROM account_deletions deletion
         JOIN account_purge_jobs job ON job.deletion_id=deletion.id
         JOIN account_restore_suppressions suppression ON suppression.deletion_id=deletion.id
        WHERE deletion.id=$1`,
      [ids.purgedDeletion],
    )
  ).rows[0];
  assert.equal(purged.deletion_state, "purged");
  assert.equal(purged.phase, "purged");
  assert.equal(purged.suppression_state, "completed");
  assert.equal(new Date(purged.purged_at).toISOString(), timeline.metadata);

  const ordinary = await clients.purge.query(
    "SELECT * FROM claim_account_purge_job($1,$2)",
    [randomUUID(), ids.ledger],
  );
  assert.equal(ordinary.rows[0]?.deletion_id ?? null, null);
});

test("metadata-absent journal entry completes only through restore authority", async () => {
  const values = registerValues({
    deletionId: ids.absentDeletion,
    accountId: ids.absentAccount,
    tenantId: ids.absentTenant,
    state: "revoked",
  });
  assert.equal((await clients.restore.query(registerSql, values)).rows[0].metadata_present, false);
  await clients.restore.query(
    "SELECT complete_absent_restore_suppression($1,$2,$3)",
    [ids.restoreRun, ids.absentDeletion, timeline.source],
  );
  assert.deepEqual(
    (
      await clients.restore.query("SELECT * FROM restored_erasure_status($1,$2)", [
        ids.restoreRun,
        ids.absentDeletion,
      ])
    ).rows[0],
    { state: "completed", metadata_present: false, tenant_id: ids.absentTenant },
  );
});
