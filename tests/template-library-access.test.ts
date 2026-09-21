import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { db, transaction } from "../apps/server/db.ts";
import { authorizeTemplateRevision } from "../apps/server/template-library-access.ts";

after(() => db.end());

const ids = {
  sourceAccount: randomUUID(),
  sourceTenant: randomUUID(),
  readerAccount: randomUUID(),
  readerTenant: randomUUID(),
  creatorAccount: randomUUID(),
  creatorTenant: randomUUID(),
  artifact: randomUUID(),
  revision: randomUUID(),
  release: randomUUID(),
  library: randomUUID(),
  otherLibrary: randomUUID(),
  publication: randomUUID(),
};

const actor = { id: ids.readerAccount, tenant: ids.readerTenant };
const request = {
  libraryId: ids.library,
  publicationId: ids.publication,
  artifactId: ids.artifact,
  revisionId: ids.revision,
};

async function seed() {
  for (const [id, name] of [
    [ids.sourceAccount, "library-source"],
    [ids.readerAccount, "library-reader"],
    [ids.creatorAccount, "library-creator"],
  ])
    await db.query(
      "INSERT INTO accounts(id,name,password_hash) VALUES($1,$2,$3)",
      [id, `${name}-${randomUUID().slice(0, 8)}`, "test"],
    );
  for (const [id, owner] of [
    [ids.sourceTenant, ids.sourceAccount],
    [ids.readerTenant, ids.readerAccount],
    [ids.creatorTenant, ids.creatorAccount],
  ])
    await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      id,
      owner,
    ]);
  await db.query(
    `INSERT INTO artifacts(id,tenant_id,created_by,title)
     VALUES($1,$2,$3,'Library source')`,
    [ids.artifact, ids.sourceTenant, ids.sourceAccount],
  );
  await db.query(
    `INSERT INTO revisions(
       id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
       object_key,object_version,total_size
     ) VALUES($1,$2,$3,1,$4,'source.pdf','application/pdf',1,$5,$6,'v1',1)`,
    [
      ids.revision,
      ids.sourceTenant,
      ids.artifact,
      ids.sourceAccount,
      "0".repeat(64),
      `library-test/${ids.revision}`,
    ],
  );
  await db.query(
    `INSERT INTO template_releases(id,artifact_id,revision_id,title,summary,rules,questions)
     VALUES($1,$2,$3,'Release','summary','rules','')`,
    [ids.release, ids.artifact, ids.revision],
  );
  await db.query(
    `INSERT INTO template_libraries(id,name,created_by) VALUES
       ($1,'Design',$3),($2,'Sibling',$3)`,
    [ids.library, ids.otherLibrary, ids.creatorAccount],
  );
  await db.query(
    `INSERT INTO template_library_members(library_id,account_id,role,joined_at)
     VALUES($1,$2,'reader','2026-09-21 12:34:56.123456+00'),
           ($3,$2,'reader','2026-09-21 12:34:56.654321+00')`,
    [ids.library, ids.readerAccount, ids.otherLibrary],
  );
  await db.query(
    `INSERT INTO template_library_publications(
       id,library_id,release_id,artifact_id,revision_id,publisher_id
     ) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      ids.publication,
      ids.library,
      ids.release,
      ids.artifact,
      ids.revision,
      ids.creatorAccount,
    ],
  );
}

async function deniedAfter(sql: string, values: unknown[]) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql, values);
    await assert.rejects(
      authorizeTemplateRevision(client, actor, request),
      (error: any) => error?.status === 404,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("authorizes only the exact active publication for an active member and source owner", async () => {
  await seed();
  const authorized = await transaction((client) =>
    authorizeTemplateRevision(client, actor, request),
  );
  assert.deepEqual(authorized, {
    libraryId: ids.library,
    publicationId: ids.publication,
    releaseId: ids.release,
    artifactId: ids.artifact,
    revisionId: ids.revision,
    sourceTenantId: ids.sourceTenant,
    membershipJoinedAt: authorized.membershipJoinedAt,
    role: "reader",
  });
  assert.match(authorized.membershipJoinedAt, /\.123456\+00$/);

  // The creator is provenance, not a perpetual authority. Disabling that
  // account leaves an independently administered active library readable.
  const creatorClient = await db.connect();
  try {
    await creatorClient.query("BEGIN");
    await creatorClient.query("UPDATE accounts SET disabled=true WHERE id=$1", [
      ids.creatorAccount,
    ]);
    assert.equal(
      (await authorizeTemplateRevision(creatorClient, actor, request))
        .revisionId,
      ids.revision,
    );
  } finally {
    await creatorClient.query("ROLLBACK");
    creatorClient.release();
  }

  for (const changed of [
    { publicationId: randomUUID() },
    { libraryId: ids.otherLibrary },
    { artifactId: randomUUID() },
    { revisionId: randomUUID() },
  ])
    await assert.rejects(
      transaction((client) =>
        authorizeTemplateRevision(client, actor, { ...request, ...changed }),
      ),
      (error: any) => error?.status === 404,
    );

  await assert.rejects(
    transaction((client) =>
      authorizeTemplateRevision(
        client,
        { id: ids.readerAccount, tenant: ids.sourceTenant },
        request,
      ),
    ),
    (error: any) => error?.status === 404,
  );

  await deniedAfter("UPDATE accounts SET disabled=true WHERE id=$1", [
    ids.readerAccount,
  ]);
  await deniedAfter(
    `UPDATE template_library_members
        SET state='revoked',revoked_at=clock_timestamp()
      WHERE library_id=$1 AND account_id=$2`,
    [ids.library, ids.readerAccount],
  );
  await deniedAfter(
    `UPDATE template_libraries
        SET state='archived',archived_at=clock_timestamp() WHERE id=$1`,
    [ids.library],
  );
  await deniedAfter(
    `UPDATE template_library_publications
        SET state='withdrawn',withdrawn_at=clock_timestamp(),
            withdrawal_reason='Superseded'
      WHERE id=$1`,
    [ids.publication],
  );
  await deniedAfter(
    "UPDATE artifacts SET trashed_at=clock_timestamp() WHERE id=$1",
    [ids.artifact],
  );
  await deniedAfter("UPDATE accounts SET disabled=true WHERE id=$1", [
    ids.sourceAccount,
  ]);
});

async function waitUntilBlocked(waiter: number, blocker: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await db.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [waiter, blocker]);
    if (result.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected a real database lock wait");
}

test("library read does not invert the tenant/account order of account deletion", async () => {
  const writer = await db.connect(), reader = await db.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN"); await reader.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout='2s'");
    await reader.query("SET LOCAL statement_timeout='4s'");
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const readerPid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await writer.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [ids.sourceTenant]);
    pending = authorizeTemplateRevision(reader, actor, request);
    // Observe the wait before asking the deletion transaction for its account
    // lock. Account-first readers would deadlock here against tenant-first deletion.
    await waitUntilBlocked(readerPid, writerPid);
    await writer.query("UPDATE accounts SET disabled=true WHERE id=$1", [ids.sourceAccount]);
    await writer.query("ROLLBACK");
    assert.equal((await pending as any).revisionId, ids.revision);
  } finally {
    await writer.query("ROLLBACK");
    if (pending) await pending.catch(() => {});
    await reader.query("ROLLBACK");
    writer.release(); reader.release();
  }
});

test("member revoke waits for an authorized read then denies subsequent reads", async () => {
  const reader = await db.connect(), writer = await db.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await reader.query("BEGIN"); await writer.query("BEGIN");
    await writer.query("SET LOCAL statement_timeout='4s'");
    const readerPid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await authorizeTemplateRevision(reader, actor, request);
    pending = writer.query("UPDATE template_library_members SET state='revoked',revoked_at=clock_timestamp() WHERE library_id=$1 AND account_id=$2", [ids.library, ids.readerAccount]);
    await waitUntilBlocked(writerPid, readerPid);
    await reader.query("COMMIT");
    await pending; await writer.query("COMMIT");
    await assert.rejects(transaction(c => authorizeTemplateRevision(c, actor, request)), (error: any) => error.status === 404);
  } finally {
    await reader.query("ROLLBACK");
    if (pending) await pending.catch(() => {});
    await writer.query("ROLLBACK");
    reader.release(); writer.release();
  }
});

test("source deletion cascades its library publication", async () => {
  await db.query("UPDATE artifacts SET latest_revision_id=NULL WHERE id=$1", [
    ids.artifact,
  ]);
  await db.query("DELETE FROM revisions WHERE id=$1", [ids.revision]);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM template_library_publications WHERE id=$1",
          [ids.publication],
        )
      ).rows[0].count,
    ),
    0,
  );
});
