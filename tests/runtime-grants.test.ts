import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CURRENT_SCHEMA_VERSION } from "../packages/migrations.ts";

const testRunId = process.env.RUNTIME_GRANTS_TEST_RUN_ID ?? "";
const schemaOwner = process.env.RUNTIME_GRANTS_SCHEMA_OWNER ?? "";
const runtimeRole = process.env.RUNTIME_GRANTS_RUNTIME_ROLE ?? "";
const futureTable = process.env.RUNTIME_GRANTS_FUTURE_TABLE ?? "";
const futureFunction = process.env.RUNTIME_GRANTS_FUTURE_FUNCTION ?? "";
const expectedDatabase = `polka_r17_test_${testRunId}`;
const databaseUrl = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (
  !/^[a-z0-9]{10,24}$/.test(testRunId) ||
  schemaOwner !== `polka_schema_${testRunId}` ||
  runtimeRole !== `polka_runtime_${testRunId}` ||
  futureTable !== `runtime_future_table_${testRunId}` ||
  futureFunction !== `runtime_future_function_${testRunId}` ||
  databaseUrl.username !== runtimeRole ||
  decodeURIComponent(databaseUrl.pathname.slice(1)) !== expectedDatabase ||
  databaseUrl.search ||
  databaseUrl.hash ||
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname)
)
  throw new Error("Runtime grants tests require an isolated runtime identity");

const client = new pg.Client({
  connectionString: databaseUrl.toString(),
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});

async function denied(sql: string) {
  await client.query("SAVEPOINT expected_denial");
  try {
    await client.query(sql);
    assert.fail(
      `Expected SQLSTATE 42501 for ${sql.split(/\s+/).slice(0, 3).join(" ")}`,
    );
  } catch (error: any) {
    assert.equal(error.code, "42501");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_denial");
    await client.query("RELEASE SAVEPOINT expected_denial");
  }
}

before(async () => client.connect());
after(async () => client.end());

test("runtime is the actual unprivileged session identity for the isolated database", async () => {
  const identity = (
    await client.query(
      `SELECT current_user,session_user,current_database(),
              shobj_description(database.oid,'pg_database') AS sentinel
       FROM pg_database database WHERE datname=current_database()`,
    )
  ).rows[0];
  assert.equal(identity.current_user, runtimeRole);
  assert.equal(identity.session_user, runtimeRole);
  assert.equal(identity.current_database, expectedDatabase);
  assert.equal(identity.sentinel, `polka-r17-test:${testRunId}`);

  const role = (
    await client.query(
      `SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
              rolbypassrls,rolcanlogin
       FROM pg_roles WHERE rolname=current_user`,
    )
  ).rows[0];
  assert.deepEqual(
    {
      superuser: role.rolsuper,
      createDatabase: role.rolcreatedb,
      createRole: role.rolcreaterole,
      replication: role.rolreplication,
      bypassRls: role.rolbypassrls,
      login: role.rolcanlogin,
    },
    {
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      login: true,
    },
  );
  assert.equal(
    Number(
      (
        await client.query(
          "SELECT count(*) FROM pg_auth_members WHERE member=$1 OR roleid=$1",
          [role.oid],
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await client.query(
          `SELECT
             (SELECT count(*) FROM pg_database WHERE datdba=$1)+
             (SELECT count(*) FROM pg_namespace WHERE nspowner=$1)+
             (SELECT count(*) FROM pg_class WHERE relowner=$1)+
             (SELECT count(*) FROM pg_proc WHERE proowner=$1) AS count`,
          [role.oid],
        )
      ).rows[0].count,
    ),
    0,
  );
  const privileges = (
    await client.query(
      `SELECT has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
              has_database_privilege(current_user,current_database(),'CREATE') AS create`,
    )
  ).rows[0];
  assert.equal(privileges.connect, true);
  assert.equal(privileges.create, false);

  const ownership = (
    await client.query(
      `SELECT database_owner.rolname AS database_owner,
              schema_owner.rolname AS schema_owner
       FROM pg_database database
       JOIN pg_roles database_owner ON database_owner.oid=database.datdba
       JOIN pg_namespace namespace ON namespace.nspname='public'
       JOIN pg_roles schema_owner ON schema_owner.oid=namespace.nspowner
       WHERE database.datname=current_database()`,
    )
  ).rows[0];
  assert.equal(ownership.database_owner, schemaOwner);
  assert.equal(ownership.schema_owner, schemaOwner);
});

test("runtime has exact current grants and denied administrative paths", async () => {
  assert.deepEqual(
    (
      await client.query(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
    ).rows.map(({ version }) => version),
    Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  const privileges = (
    await client.query(
      `SELECT table_name,privilege_type FROM information_schema.role_table_grants
       WHERE grantee=current_user AND table_name IN ('comments','comment_reactions')
       ORDER BY table_name,privilege_type`,
    )
  ).rows.map((row) => `${row.table_name}:${row.privilege_type}`);
  assert.deepEqual(privileges, [
    "comment_reactions:DELETE",
    "comment_reactions:INSERT",
    "comment_reactions:SELECT",
    "comments:INSERT",
    "comments:SELECT",
    "comments:UPDATE",
  ]);
  await client.query("BEGIN");
  try {
    await denied("INSERT INTO schema_migrations(version) VALUES(1000)");
    await denied(`CREATE SCHEMA runtime_attempt_${testRunId}`);
    await denied(`CREATE TABLE public.runtime_attempt_${testRunId}(id int)`);
    await denied(
      `CREATE FUNCTION public.runtime_attempt_${testRunId}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
    );
    await denied("TRUNCATE TABLE accounts");
    await denied(`SET ROLE "${schemaOwner}"`);
    await denied("DELETE FROM account_deletions");
    await denied("DELETE FROM account_deletion_csrf");
    // Comments (030): soft delete only; reactions toggle by DELETE, never change.
    await denied("DELETE FROM comments");
    await denied("TRUNCATE TABLE comment_reactions");
    await denied("UPDATE comment_reactions SET emoji=emoji");
    await denied("UPDATE template_library_events SET action=action");
    await denied("DELETE FROM template_library_events");
    await denied("SELECT public.preserve_account_deletion_marker()");
    await denied("SELECT * FROM account_purge_jobs");
    await denied(
      `SELECT public.claim_account_purge_job('${randomUUID()}','${randomUUID()}')`,
    );
    await denied(
      `SELECT public.terminal_erase_account_metadata('${randomUUID()}','${randomUUID()}','${"a".repeat(32)}:${"b".repeat(128)}')`,
    );
    await denied(`SELECT * FROM public."${futureTable}"`);
    await denied(`SELECT public."${futureFunction}"()`);
  } finally {
    await client.query("ROLLBACK");
  }
});

test("runtime app DML, trigger enforcement and session CSRF cascade work", async () => {
  const accountId = randomUUID();
  const tenantId = randomUUID();
  const sessionHash = "a".repeat(64);
  const libraryId = randomUUID();
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO accounts(id,name,password_hash) VALUES($1,$2,$3)",
      [accountId, `runtime-${testRunId}`, "synthetic-password-hash"],
    );
    await client.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      tenantId,
      accountId,
    ]);
    await client.query(
      "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [sessionHash, accountId],
    );
    await client.query(
      "INSERT INTO account_deletion_csrf(session_hash,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
      [sessionHash, "b".repeat(64)],
    );
    await client.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'runtime.synthetic',$3)",
      [tenantId, accountId, accountId],
    );
    // Comments (030): what the application does, as the runtime role.
    const artifactId = randomUUID(),
      revisionId = randomUUID(),
      shareId = randomUUID(),
      commentId = randomUUID();
    await client.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,'Runtime work')",
      [artifactId, tenantId, accountId],
    );
    await client.query(
      `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,storage_kind,total_size,html_profile)
       VALUES($1,$2,$3,1,$4,'page.html','text/html',1,$5,$6,'v','single',1,'static')`,
      [revisionId, tenantId, artifactId, accountId, "c".repeat(64), `${tenantId}/runtime-${testRunId}`],
    );
    await client.query(
      `INSERT INTO shares(id,tenant_id,artifact_id,revision_id,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,now()+interval '1 day')`,
      [shareId, tenantId, artifactId, revisionId, "d".repeat(64)],
    );
    await client.query(
      `INSERT INTO comments(id,tenant_id,artifact_id,share_id,revision_id,author_account_id,anchor,body)
       VALUES($1,$2,$3,$4,$5,$6,'{"exact":"x","prefix":"","suffix":""}','Замечание')`,
      [commentId, tenantId, artifactId, shareId, revisionId, accountId],
    );
    await client.query(
      "UPDATE comments SET resolved_at=clock_timestamp(),resolved_by=$2 WHERE id=$1",
      [commentId, accountId],
    );
    await client.query(
      "UPDATE comments SET body='',deleted_at=clock_timestamp() WHERE id=$1",
      [commentId],
    );
    await client.query(
      `INSERT INTO comment_reactions(id,tenant_id,artifact_id,share_id,revision_id,author_account_id,anchor_sig,anchor,emoji)
       VALUES($1,$2,$3,$4,$5,$6,'',NULL,$7)`,
      [randomUUID(), tenantId, artifactId, shareId, revisionId, accountId, "👍"],
    );
    assert.equal(
      (
        await client.query(
          "DELETE FROM comment_reactions WHERE share_id=$1 AND author_account_id=$2",
          [shareId, accountId],
        )
      ).rowCount,
      1,
    );
    await client.query(
      "UPDATE viewer_grants SET comments=comments WHERE false",
    );
    await client.query(
      "INSERT INTO template_libraries(id,name,created_by) VALUES($1,'Runtime library',$2)",
      [libraryId, accountId],
    );
    await client.query(
      `INSERT INTO template_library_events(
         library_id,actor_id,action,target_type,target_object_id,new_role)
       VALUES($1,$2,'template_library.created','library',$1,'admin')`,
      [libraryId, accountId],
    );
    assert.equal(
      Number(
        (
          await client.query(
            "SELECT count(*) FROM template_library_events WHERE library_id=$1",
            [libraryId],
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(
      Number(
        (await client.query("SELECT currval('audit_outbox_id_seq') AS value"))
          .rows[0].value,
      ) > 0,
      true,
    );
    await client.query(
      "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
      [accountId],
    );
    await client.query("SAVEPOINT marker_immutable");
    try {
      await client.query(
        "UPDATE accounts SET deletion_requested_at=NULL WHERE id=$1",
        [accountId],
      );
      assert.fail("Deletion marker unexpectedly became mutable");
    } catch (error: any) {
      assert.equal(error.code, "P0001");
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT marker_immutable");
      await client.query("RELEASE SAVEPOINT marker_immutable");
    }
    await client.query("DELETE FROM sessions WHERE hash=$1", [sessionHash]);
    assert.equal(
      Number(
        (
          await client.query(
            "SELECT count(*) FROM account_deletion_csrf WHERE session_hash=$1",
            [sessionHash],
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    await client.query("ROLLBACK");
  }
});
