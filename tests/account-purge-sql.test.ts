import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

const runId = process.env.PURGE_TEST_RUN_ID ?? "";
const workerRole = process.env.PURGE_TEST_WORKER_ROLE ?? "";
const ownerRole = `polka_schema_${runId}`;
const expectedDatabase = `polka_r17_test_${runId}`;
const workerUrl = new URL(process.env.DATABASE_URL ?? "http://invalid");
const ownerUrl = new URL(
  process.env.PURGE_TEST_OWNER_DATABASE_URL ?? "http://invalid",
);
if (
  !/^[a-z0-9]{10,24}$/.test(runId) ||
  workerRole !== `polka_purge_${runId}` ||
  ownerUrl.username !== ownerRole ||
  workerUrl.username !== workerRole ||
  workerUrl.hostname !== ownerUrl.hostname ||
  workerUrl.port !== ownerUrl.port ||
  workerUrl.pathname !== `/${expectedDatabase}` ||
  ownerUrl.pathname !== `/${expectedDatabase}` ||
  workerUrl.search ||
  ownerUrl.search ||
  workerUrl.hash ||
  ownerUrl.hash ||
  !["127.0.0.1", "localhost"].includes(workerUrl.hostname)
)
  throw new Error("Purge SQL tests require guarded isolated identities");

const options = (connectionString: string) => ({
  connectionString,
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});
const worker = new pg.Client(options(workerUrl.toString()));
const owner = new pg.Client(options(ownerUrl.toString()));
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const ids = {
  account: randomUUID(),
  tenant: randomUUID(),
  deletion: randomUUID(),
  ledger: randomUUID(),
  attempt1: randomUUID(),
  attempt2: randomUUID(),
  challenge1: randomUUID(),
  challenge2: randomUUID(),
  colleague: randomUUID(),
  colleagueTenant: randomUUID(),
  sharedLibrary: randomUUID(),
  soleLibrary: randomUUID(),
  colleagueArtifact: randomUUID(),
  colleagueRevision: randomUUID(),
  colleagueRelease: randomUUID(),
  sharedPublication: randomUUID(),
  acceptedInvite: randomUUID(),
  pendingInvite: randomUUID(),
  issuedInvite: randomUUID(),
};
const name = `purge-${runId}`;
const email = `purge-${runId}@example.test`;
const neighborLimit = hash(`name:neighbor-${runId}`);

async function denied(sql: string, values: unknown[] = []) {
  await worker.query("SAVEPOINT expected_denial");
  try {
    await worker.query(sql, values);
    assert.fail("Expected SQLSTATE 42501");
  } catch (error: any) {
    assert.equal(error.code, "42501");
  } finally {
    await worker.query("ROLLBACK TO SAVEPOINT expected_denial");
    await worker.query("RELEASE SAVEPOINT expected_denial");
  }
}

before(async () => {
  await Promise.all([worker.connect(), owner.connect()]);
  const [workerIdentity, ownerIdentity] = await Promise.all([
    worker.query(
      `SELECT current_user,session_user,current_database(),
              shobj_description(oid,'pg_database') AS sentinel
         FROM pg_database WHERE datname=current_database()`,
    ),
    owner.query(
      `SELECT current_user,session_user,current_database(),
              shobj_description(oid,'pg_database') AS sentinel
         FROM pg_database WHERE datname=current_database()`,
    ),
  ]);
  assert.deepEqual(workerIdentity.rows[0], {
    current_user: workerRole,
    session_user: workerRole,
    current_database: expectedDatabase,
    sentinel: `polka-r17-test:${runId}`,
  });
  assert.deepEqual(ownerIdentity.rows[0], {
    current_user: ownerRole,
    session_user: ownerRole,
    current_database: expectedDatabase,
    sentinel: `polka-r17-test:${runId}`,
  });
  await owner.query("BEGIN");
  try {
    await owner.query(
      `INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [
        ids.account,
        name,
        `${"1".repeat(32)}:${"2".repeat(128)}`,
        email,
        "Owner",
      ],
    );
    await owner.query(
      "INSERT INTO tenants(id,owner_id,used_bytes,derivative_used_bytes) VALUES($1,$2,10,20)",
      [ids.tenant, ids.account],
    );
    await owner.query(
      "INSERT INTO accounts(id,name,password_hash) VALUES($1,$2,'synthetic')",
      [ids.colleague, `library-colleague-${runId}`],
    );
    await owner.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      ids.colleagueTenant,
      ids.colleague,
    ]);
    await owner.query(
      "INSERT INTO template_libraries(id,name,created_by) VALUES($1,'Shared team library',$3),($2,'Last admin library',$3)",
      [ids.sharedLibrary, ids.soleLibrary, ids.account],
    );
    await owner.query(
      "INSERT INTO template_library_members(library_id,account_id,role) VALUES($1,$3,'admin'),($2,$3,'admin'),($1,$4,'admin')",
      [ids.sharedLibrary, ids.soleLibrary, ids.account, ids.colleague],
    );
    await owner.query(
      `INSERT INTO template_library_events(
         library_id,actor_id,action,target_type,target_account_id,old_role,new_role)
       VALUES($1,$2,'template_library.member_role_changed','account',$3,'reader','curator'),
             ($1,$3,'template_library.member_revoked','account',$2,'reader',NULL)`,
      [ids.sharedLibrary, ids.account, ids.colleague],
    );
    await owner.query(
      `INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id)
       VALUES($1,$2,'template_library.member_role_changed',$3),
             ($1,$2,'runtime.synthetic',$3)`,
      [ids.colleagueTenant, ids.colleague, ids.account],
    );
    await owner.query(
      `INSERT INTO template_library_invitations(
         id,library_id,email,role,token_hash,invited_by,state,created_at,expires_at,
         accepted_at,accepted_by,accepted_membership_joined_at)
       SELECT $1,$2,$3,'admin',$4,$5,'accepted',now(),now()+interval '1 day',
              now(),$6,joined_at FROM template_library_members
        WHERE library_id=$2 AND account_id=$6 AND state='active'`,
      [
        ids.acceptedInvite,
        ids.sharedLibrary,
        email,
        hash("accepted-" + runId),
        ids.colleague,
        ids.account,
      ],
    );
    await owner.query(
      `INSERT INTO template_library_invitations(
         id,library_id,email,role,token_hash,invited_by,created_at,expires_at)
       VALUES($1,$2,$3,'reader',$4,$5,now(),now()+interval '1 day'),
             ($6,$2,$7,'reader',$8,$9,now(),now()+interval '1 day')`,
      [
        ids.pendingInvite,
        ids.sharedLibrary,
        email,
        hash("pending-" + runId),
        ids.colleague,
        ids.issuedInvite,
        "neighbor@example.test",
        hash("issued-" + runId),
        ids.account,
      ],
    );
    await owner.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Colleague-owned template')",
      [ids.colleagueArtifact, ids.colleagueTenant, ids.colleague],
    );
    await owner.query(
      "INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,total_size) VALUES($1,$2,$3,1,$4,'sample.txt','text/plain',1,$5,$6,'synthetic',1)",
      [
        ids.colleagueRevision,
        ids.colleagueTenant,
        ids.colleagueArtifact,
        ids.colleague,
        "0".repeat(64),
        `purge-library/${ids.colleagueRevision}`,
      ],
    );
    await owner.query(
      "INSERT INTO template_releases(id,artifact_id,revision_id,title,summary,rules,questions) VALUES($1,$2,$3,'Template','Synthetic summary','Synthetic rules','')",
      [ids.colleagueRelease, ids.colleagueArtifact, ids.colleagueRevision],
    );
    await owner.query(
      "INSERT INTO template_library_publications(id,library_id,release_id,artifact_id,revision_id,publisher_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ids.sharedPublication,
        ids.sharedLibrary,
        ids.colleagueRelease,
        ids.colleagueArtifact,
        ids.colleagueRevision,
        ids.account,
      ],
    );
    for (const memberId of [ids.account, ids.colleague]) {
      const sessionHash = hash("library-view-session-" + memberId);
      await owner.query(
        "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [sessionHash, memberId],
      );
      await owner.query(
        `INSERT INTO template_library_viewer_grants(
           hash,session_hash,library_id,publication_id,artifact_id,revision_id,
           member_account_id,membership_joined_at,created_at,expires_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,joined_at,now(),now()+interval '60 seconds'
           FROM template_library_members WHERE library_id=$3 AND account_id=$7 AND state='active'`,
        [
          hash("library-view-" + memberId),
          sessionHash,
          ids.sharedLibrary,
          ids.sharedPublication,
          ids.colleagueArtifact,
          ids.colleagueRevision,
          memberId,
        ],
      );
    }
    await owner.query(
      `INSERT INTO account_deletions(
         id,account_id,tenant_id,state,status_capability_hash,plan_expires_at,
         artifact_count,revision_count,source_bytes,derivative_bytes,
         policy_version,purge_max_hours,backup_retention_max_days
       ) VALUES($1,$2,$3,'planned',$4,now()+interval '10 minutes',1,2,10,20,'test-v1',24,1)`,
      [ids.deletion, ids.account, ids.tenant, "3".repeat(64)],
    );
    await owner.query(
      `INSERT INTO url_import_jobs(id,tenant_id,account_id,idempotency_key,request,request_hash,state,prepared)
       VALUES($1,$2,$3,$4,'{"url":"https://example.test/private-report"}',$5,'prepared','{"html":"private report bytes"}')`,
      [randomUUID(), ids.tenant, ids.account, randomUUID(), "a".repeat(64)],
    );
    await owner.query(
      "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
      [ids.account],
    );
    await owner.query(
      `UPDATE account_deletions SET state='access_revoked_pending_purge',
         requested_at=clock_timestamp(),revoked_at=clock_timestamp(),
         working_data_policy_deadline=clock_timestamp()+interval '24 hours',
         backup_retention_policy_deadline=clock_timestamp()+interval '1 day',
         confirmation_session_hash=$2 WHERE id=$1`,
      [ids.deletion, "4".repeat(64)],
    );
    await owner.query(
      `INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at)
       VALUES($1,$3,$4,$5,'local',now()+interval '10 minutes'),
             ($2,$3,$4,$5,'local',now()+interval '10 minutes')`,
      [ids.challenge1, ids.challenge2, email, "5".repeat(64), "6".repeat(64)],
    );
    await owner.query(
      "INSERT INTO login_limits(key,attempts,reset_at) VALUES($1,1,now()+interval '10 minutes'),($2,1,now()+interval '10 minutes'),($3,1,now()+interval '10 minutes')",
      [hash(`name:${name}`), hash(`email-send:${email}`), neighborLimit],
    );
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
});

after(async () => {
  await Promise.all([worker.end(), owner.end()]);
});

test("purge worker is exact session identity with function-only authority", async () => {
  const identity = (await worker.query("SELECT current_user,session_user"))
    .rows[0];
  assert.equal(identity.current_user, workerRole);
  assert.equal(identity.session_user, workerRole);
  await worker.query("BEGIN");
  try {
    await denied("SELECT * FROM account_purge_jobs");
    await denied("DELETE FROM editorial_publications");
    await denied("UPDATE accounts SET disabled=false");
    await denied("SELECT preserve_editorial_publication()");
  } finally {
    await worker.query("ROLLBACK");
  }
});

test("protected SQL lifecycle enforces stale attempts, exact mail inventory and tombstone scrub", async () => {
  let job = (
    await worker.query("SELECT * FROM claim_account_purge_job($1,$2)", [
      ids.attempt1,
      ids.ledger,
    ])
  ).rows[0];
  assert.equal(job.deletion_id, ids.deletion);
  assert.equal(job.phase, "awaiting_revoke_ledger");
  await worker.query(
    "SELECT acknowledge_account_purge_revoke($1,$2,$3,$4,$5)",
    [
      ids.deletion,
      ids.attempt1,
      `erasure/v1/${ids.ledger}/${ids.deletion}/revoke.json`,
      "7".repeat(64),
      "revoke-v1",
    ],
  );
  await worker.query("SELECT yield_account_purge_attempt($1,$2)", [
    ids.deletion,
    ids.attempt1,
  ]);
  job = (
    await worker.query("SELECT * FROM claim_account_purge_job($1,$2)", [
      ids.attempt2,
      ids.ledger,
    ])
  ).rows[0];
  assert.equal(job.phase, "deleting_source");
  await assert.rejects(
    worker.query(
      "SELECT mark_account_purge_source_empty($1,$2,clock_timestamp())",
      [ids.deletion, ids.attempt1],
    ),
    /stale purge attempt/,
  );
  await worker.query(
    "SELECT mark_account_purge_source_empty($1,$2,clock_timestamp())",
    [ids.deletion, ids.attempt2],
  );

  await owner.query("BEGIN");
  await owner.query("SELECT id FROM login_challenges WHERE id=$1 FOR UPDATE", [
    ids.challenge2,
  ]);
  await worker.query("BEGIN");
  const firstMail = (
    await worker.query("SELECT * FROM lock_account_purge_mail($1,$2)", [
      ids.deletion,
      ids.attempt2,
    ])
  ).rows[0];
  assert.deepEqual(
    firstMail.challenges.map((value: any) => value.id),
    [ids.challenge1],
  );
  await owner.query("ROLLBACK");
  await assert.rejects(
    worker.query(
      "SELECT complete_account_purge_mail($1,$2,clock_timestamp(),$3)",
      [ids.deletion, ids.attempt2, [ids.challenge1]],
    ),
    /challenges are busy/,
  );
  await worker.query("ROLLBACK");

  await worker.query("BEGIN");
  const secondMail = (
    await worker.query("SELECT * FROM lock_account_purge_mail($1,$2)", [
      ids.deletion,
      ids.attempt2,
    ])
  ).rows[0];
  assert.deepEqual(
    secondMail.challenges.map((value: any) => value.id).sort(),
    [ids.challenge1, ids.challenge2].sort(),
  );
  await worker.query(
    "SELECT complete_account_purge_mail($1,$2,clock_timestamp(),$3)",
    [
      ids.deletion,
      ids.attempt2,
      secondMail.challenges.map((value: any) => value.id),
    ],
  );
  await worker.query("COMMIT");

  const terminal = (
    await worker.query(
      "SELECT * FROM terminal_erase_account_metadata($1,$2,$3)",
      [ids.deletion, ids.attempt2, `${"8".repeat(32)}:${"9".repeat(128)}`],
    )
  ).rows[0];
  assert.equal(terminal.phase, "metadata_purged");
  assert.equal(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM template_library_members WHERE account_id=$1",
          [ids.account],
        )
      ).rows[0].count,
    ),
    0,
  );
  for (const inviteId of [ids.acceptedInvite, ids.pendingInvite]) {
    assert.deepEqual(
      (
        await owner.query(
          "SELECT state,email,token_hash,accepted_by,accepted_membership_joined_at FROM template_library_invitations WHERE id=$1",
          [inviteId],
        )
      ).rows[0],
      {
        state: "redacted",
        email: null,
        token_hash: null,
        accepted_by: null,
        accepted_membership_joined_at: null,
      },
    );
  }
  assert.deepEqual(
    (
      await owner.query(
        "SELECT state,email,token_hash,invited_by FROM template_library_invitations WHERE id=$1",
        [ids.issuedInvite],
      )
    ).rows[0],
    {
      state: "revoked",
      email: "neighbor@example.test",
      token_hash: null,
      invited_by: null,
    },
  );
  assert.equal(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM template_library_viewer_grants WHERE member_account_id=$1",
          [ids.account],
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM template_library_viewer_grants WHERE member_account_id=$1",
          [ids.colleague],
        )
      ).rows[0].count,
    ),
    1,
  );
  const shared = (
    await owner.query(
      "SELECT state,created_by FROM template_libraries WHERE id=$1",
      [ids.sharedLibrary],
    )
  ).rows[0];
  assert.deepEqual(shared, { state: "active", created_by: null });
  const sole = (
    await owner.query(
      "SELECT state,created_by,archived_at IS NOT NULL AS archived FROM template_libraries WHERE id=$1",
      [ids.soleLibrary],
    )
  ).rows[0];
  assert.deepEqual(sole, {
    state: "archived",
    created_by: null,
    archived: true,
  });
  assert.equal(
    (
      await owner.query(
        "SELECT state FROM template_library_members WHERE account_id=$1 AND library_id=$2",
        [ids.colleague, ids.sharedLibrary],
      )
    ).rows[0].state,
    "active",
  );
  assert.deepEqual(
    (
      await owner.query(
        "SELECT publisher_id,state,revision_id FROM template_library_publications WHERE id=$1",
        [ids.sharedPublication],
      )
    ).rows[0],
    { publisher_id: null, state: "active", revision_id: ids.colleagueRevision },
  );
  const libraryEvents = (
    await owner.query(
      `SELECT actor_id,target_account_id FROM template_library_events
      WHERE library_id=$1 ORDER BY id`,
      [ids.sharedLibrary],
    )
  ).rows;
  assert.deepEqual(libraryEvents, [
    { actor_id: null, target_account_id: ids.colleague },
    { actor_id: ids.colleague, target_account_id: null },
  ]);
  assert.equal(
    Number(
      (
        await owner.query(
          `SELECT count(*) FROM audit_outbox
      WHERE target_id=$1 AND action='template_library.member_role_changed'`,
          [ids.account],
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await owner.query(
          `SELECT count(*) FROM audit_outbox WHERE target_id=$1 AND action='runtime.synthetic'`,
          [ids.account],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await owner.query("SELECT count(*) FROM revisions WHERE id=$1", [
          ids.colleagueRevision,
        ])
      ).rows[0].count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM url_import_jobs WHERE tenant_id=$1",
          [ids.tenant],
        )
      ).rows[0].count,
    ),
    0,
  );
  await worker.query(
    "SELECT acknowledge_account_purge_terminal($1,$2,$3,$4,$5)",
    [
      ids.deletion,
      ids.attempt2,
      `erasure/v1/${ids.ledger}/${ids.deletion}/purged.json`,
      "a".repeat(64),
      "purged-v1",
    ],
  );

  const account = (
    await owner.query("SELECT * FROM accounts WHERE id=$1", [ids.account])
  ).rows[0];
  assert.equal(account.disabled, true);
  assert.equal(account.email, null);
  assert.equal(account.display_name, null);
  assert.equal(account.name, `deleted-${ids.account}`);
  const tenant = (
    await owner.query("SELECT * FROM tenants WHERE id=$1", [ids.tenant])
  ).rows[0];
  assert.equal(Number(tenant.used_bytes), 0);
  assert.equal(Number(tenant.derivative_used_bytes), 0);
  const receipt = (
    await owner.query("SELECT * FROM account_deletions WHERE id=$1", [
      ids.deletion,
    ])
  ).rows[0];
  assert.equal(receipt.state, "purged");
  assert.equal(receipt.confirmation_session_hash, null);
  assert.equal(Number(receipt.source_bytes), 0);
  assert.deepEqual(
    (await owner.query("SELECT key FROM login_limits ORDER BY key")).rows.map(
      ({ key }) => key,
    ),
    [neighborLimit],
  );
  assert.equal(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM login_challenges WHERE email=$1",
          [email],
        )
      ).rows[0].count,
    ),
    0,
  );
});

test("terminal purge redacts a no-email account from another library journal", async () => {
  const accountId = randomUUID();
  const tenantId = randomUUID();
  const deletionId = randomUUID();
  const ledgerId = randomUUID();
  const attemptId = randomUUID();
  await owner.query("BEGIN");
  try {
    await owner.query(
      "INSERT INTO accounts(id,name,password_hash) VALUES($1,$2,'synthetic')",
      [accountId, `no-email-${runId}`],
    );
    await owner.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      tenantId,
      accountId,
    ]);
    await owner.query(
      "INSERT INTO template_library_members(library_id,account_id,role) VALUES($1,$2,'reader')",
      [ids.sharedLibrary, accountId],
    );
    await owner.query(
      `INSERT INTO template_library_events(
         library_id,actor_id,action,target_type,target_account_id,old_role,new_role)
       VALUES($1,$2,'template_library.member_role_changed','account',$2,'reader','curator')`,
      [ids.sharedLibrary, accountId],
    );
    await owner.query(
      `INSERT INTO account_deletions(
         id,account_id,tenant_id,state,status_capability_hash,plan_expires_at,
         artifact_count,revision_count,source_bytes,derivative_bytes,
         policy_version,purge_max_hours,backup_retention_max_days
       ) VALUES($1,$2,$3,'planned',$4,now()+interval '10 minutes',0,0,0,0,'test-v1',24,1)`,
      [deletionId, accountId, tenantId, "c".repeat(64)],
    );
    await owner.query(
      "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
      [accountId],
    );
    await owner.query(
      `UPDATE account_deletions SET state='access_revoked_pending_purge',
         requested_at=clock_timestamp(),revoked_at=clock_timestamp(),
         working_data_policy_deadline=clock_timestamp()+interval '24 hours',
         backup_retention_policy_deadline=clock_timestamp()+interval '1 day',
         confirmation_session_hash=$2 WHERE id=$1`,
      [deletionId, "d".repeat(64)],
    );
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }

  const claimed = (
    await worker.query("SELECT * FROM claim_account_purge_job($1,$2)", [
      attemptId,
      ledgerId,
    ])
  ).rows[0];
  assert.equal(claimed.deletion_id, deletionId);
  await worker.query(
    "SELECT acknowledge_account_purge_revoke($1,$2,$3,$4,$5)",
    [
      deletionId,
      attemptId,
      `erasure/v1/${ledgerId}/${deletionId}/revoke.json`,
      "e".repeat(64),
      "revoke-v1",
    ],
  );
  await worker.query(
    "SELECT mark_account_purge_source_empty($1,$2,clock_timestamp())",
    [deletionId, attemptId],
  );
  const mail = (
    await worker.query("SELECT * FROM lock_account_purge_mail($1,$2)", [
      deletionId,
      attemptId,
    ])
  ).rows[0];
  assert.deepEqual(mail.challenges, []);
  await worker.query(
    "SELECT complete_account_purge_mail($1,$2,clock_timestamp(),$3)",
    [deletionId, attemptId, []],
  );
  await worker.query("SELECT terminal_erase_account_metadata($1,$2,$3)", [
    deletionId,
    attemptId,
    `${"f".repeat(32)}:${"0".repeat(128)}`,
  ]);

  assert.deepEqual(
    (
      await owner.query(
        `SELECT actor_id,target_account_id FROM template_library_events
      WHERE library_id=$1 AND action='template_library.member_role_changed'
      ORDER BY id DESC LIMIT 1`,
        [ids.sharedLibrary],
      )
    ).rows[0],
    { actor_id: null, target_account_id: null },
  );
  assert.equal(
    (await owner.query("SELECT email FROM accounts WHERE id=$1", [accountId]))
      .rows[0].email,
    null,
  );
});
