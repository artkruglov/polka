import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import {
  getArtifactForAgent,
  listArtifactsForAgent,
  listFoldersForAgent,
  transitionArtifactFromAgent,
  updateArtifactFromAgent,
} from "../apps/server/agent-management.ts";
import {
  MCP_AUDIENCE,
  type ServiceActor,
} from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;

async function connection(
  account: Awaited<ReturnType<typeof createAccount>>,
  scopes: string[],
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'management test',$5,$6,now()+interval '1 day')`,
    [
      id,
      account.tenant,
      account.id,
      sha256(randomBytes(32)),
      scopes,
      MCP_AUDIENCE,
    ],
  );
  return {
    accountId: account.id,
    tenantId: account.tenant,
    connectionId: id,
    scopes,
    audience: MCP_AUDIENCE,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  } as ServiceActor;
}

async function artifact(
  account: Awaited<ReturnType<typeof createAccount>>,
  title: string,
  options: {
    folderId?: string | null;
    updatedAt?: string;
    trashedAt?: string | null;
  } = {},
) {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  await db.query(
    `INSERT INTO artifacts(
       id,tenant_id,created_by,folder_id,title,updated_at,trashed_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      artifactId,
      account.tenant,
      account.id,
      options.folderId ?? null,
      title,
      options.updatedAt ?? new Date().toISOString(),
      options.trashedAt ?? null,
    ],
  );
  await db.query(
    `INSERT INTO revisions(
       id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
       object_key,object_version,storage_kind,total_size
     ) VALUES($1,$2,$3,1,$4,'note.txt','text/plain',4,$5,$6,'version','single',4)`,
    [
      revisionId,
      account.tenant,
      artifactId,
      account.id,
      sha256("note"),
      `${account.tenant}/agent-management/${revisionId}`,
    ],
  );
  await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [
    artifactId,
    revisionId,
  ]);
  return { artifactId, revisionId };
}

const rejected = (status: number, code: string) => (error: any) =>
  error?.status === status && error?.code === code;

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`manage-a-${suffix}`, password);
  other = await createAccount(`manage-b-${suffix}`, password);
});

after(async () => {
  await db.end();
  s3.destroy();
});

test("agent reads are tenant-safe and preserve state-aware microsecond cursors", async () => {
  const actor = await connection(owner, ["read"]);
  const activeNewer = await artifact(owner, "Precision active newer", {
    updatedAt: "2026-09-21T12:00:00.123200Z",
  });
  const activeOlder = await artifact(owner, "Precision active older", {
    updatedAt: "2026-09-21T12:00:00.123100Z",
  });
  const trashedNewer = await artifact(owner, "Precision trash newer", {
    updatedAt: "2026-09-21T11:00:00Z",
    trashedAt: "2026-09-21T13:00:00.123200Z",
  });
  const trashedOlder = await artifact(owner, "Precision trash older", {
    updatedAt: "2026-09-21T11:00:00Z",
    trashedAt: "2026-09-21T13:00:00.123100Z",
  });
  const foreign = await artifact(other, "Foreign management secret");

  const first = await listArtifactsForAgent(actor, {
    state: "active",
    query: "Precision active",
    limit: 1,
  });
  assert.deepEqual(
    first.items.map((item) => item.id),
    [activeNewer.artifactId],
  );
  assert.ok(first.nextCursor);
  const second = await listArtifactsForAgent(actor, {
    state: "active",
    query: "Precision active",
    limit: 1,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    second.items.map((item) => item.id),
    [activeOlder.artifactId],
  );
  assert.equal(second.nextCursor, null);

  const trashFirst = await listArtifactsForAgent(actor, {
    state: "trashed",
    query: "Precision trash",
    limit: 1,
  });
  assert.deepEqual(
    trashFirst.items.map((item) => item.id),
    [trashedNewer.artifactId],
  );
  assert.equal(trashFirst.items[0].revision.inlineBuild, null);
  const trashSecond = await listArtifactsForAgent(actor, {
    state: "trashed",
    query: "Precision trash",
    limit: 1,
    cursor: trashFirst.nextCursor!,
  });
  assert.deepEqual(
    trashSecond.items.map((item) => item.id),
    [trashedOlder.artifactId],
  );
  await assert.rejects(
    listArtifactsForAgent(actor, {
      state: "active",
      cursor: trashFirst.nextCursor!,
    }),
    rejected(400, "invalid"),
  );
  const bogusStateCursor = Buffer.from(
    JSON.stringify({
      state: "bogus",
      date: "2026-09-21T12:00:00.123200Z",
      id: activeNewer.artifactId,
    }),
  ).toString("base64url");
  await assert.rejects(
    listArtifactsForAgent(actor, {
      state: "active",
      cursor: bogusStateCursor,
    }),
    rejected(400, "invalid"),
  );

  const visible = await getArtifactForAgent(actor, {
    artifactId: trashedNewer.artifactId,
  });
  assert.ok(visible.trashedAt);
  for (const secret of ["share", "token", "object_key", "url", "manifest"])
    assert.doesNotMatch(JSON.stringify(visible), new RegExp(secret, "i"));
  await assert.rejects(
    getArtifactForAgent(actor, { artifactId: foreign.artifactId }),
    rejected(404, "not_found"),
  );

  const folders = [
    { id: randomUUID(), name: "Management A" },
    { id: randomUUID(), name: "Management B" },
  ];
  for (const folder of folders)
    await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [
      folder.id,
      owner.tenant,
      folder.name,
    ]);
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [
    randomUUID(),
    other.tenant,
    "Foreign folder",
  ]);
  const folderFirst = await listFoldersForAgent(actor, { limit: 1 });
  const folderSecond = await listFoldersForAgent(actor, {
    limit: 1,
    cursor: folderFirst.nextCursor!,
  });
  assert.deepEqual(
    [...folderFirst.items, ...folderSecond.items].map((item) => item.name),
    ["Management A", "Management B"],
  );
});

test("metadata mutation has connection-bound atomic receipts and current auth rechecks", async () => {
  const actor = await connection(owner, ["manage"]);
  const otherConnection = await connection(owner, ["manage"]);
  const readOnly = await connection(owner, ["read"]);
  const target = await artifact(owner, "Metadata original");
  const folderId = randomUUID();
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [
    folderId,
    owner.tenant,
    `Metadata ${randomUUID()}`,
  ]);
  const firstInput = {
    key: randomUUID(),
    artifactId: target.artifactId,
    title: "Metadata first",
    folderId,
    expectedTitle: "Metadata original",
    expectedFolderId: null,
  };
  const first = await updateArtifactFromAgent(actor, firstInput);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.applied, {
    artifactId: target.artifactId,
    title: "Metadata first",
    folderId,
  });
  const second = await updateArtifactFromAgent(actor, {
    key: randomUUID(),
    artifactId: target.artifactId,
    title: "Metadata current",
    expectedTitle: "Metadata first",
    expectedFolderId: folderId,
  });
  assert.equal(second.replayed, false);
  const replay = await updateArtifactFromAgent(actor, firstInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.applied, first.applied);
  assert.equal(
    (
      await db.query("SELECT title FROM artifacts WHERE id=$1", [
        target.artifactId,
      ])
    ).rows[0].title,
    "Metadata current",
  );
  await assert.rejects(
    updateArtifactFromAgent(actor, {
      ...firstInput,
      title: "Changed replay",
    }),
    rejected(409, "conflict"),
  );
  await assert.rejects(
    updateArtifactFromAgent(otherConnection, firstInput),
    rejected(409, "conflict"),
  );
  await assert.rejects(
    updateArtifactFromAgent(readOnly, {
      ...firstInput,
      key: randomUUID(),
      expectedTitle: "Metadata current",
      expectedFolderId: folderId,
    }),
    rejected(403, "forbidden"),
  );
  const foreignFolderId = randomUUID();
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [
    foreignFolderId,
    other.tenant,
    `Foreign metadata ${randomUUID()}`,
  ]);
  await assert.rejects(
    updateArtifactFromAgent(otherConnection, {
      key: randomUUID(),
      artifactId: target.artifactId,
      folderId: foreignFolderId,
      expectedTitle: "Metadata current",
      expectedFolderId: folderId,
    }),
    rejected(404, "not_found"),
  );
  const operationCount = await db.query(
    "SELECT count(*) FROM agent_operations WHERE operation='metadata' AND tenant_id=$1 AND idempotency_key=$2",
    [owner.tenant, firstInput.key],
  );
  assert.equal(Number(operationCount.rows[0].count), 1);
  const auditRows = await db.query(
    `SELECT actor_type,connection_id FROM audit_outbox
     WHERE target_id=$1 AND action='artifact.metadata_updated'
     ORDER BY id`,
    [target.artifactId],
  );
  assert.equal(auditRows.rows.length, 2);
  assert.ok(
    auditRows.rows.every(
      (row) =>
        row.actor_type === "agent" && row.connection_id === actor.connectionId,
    ),
  );

  await db.query(
    "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1",
    [actor.connectionId],
  );
  await assert.rejects(
    updateArtifactFromAgent(actor, firstInput),
    rejected(401, "unauthorized"),
  );
  assert.equal(
    (
      await db.query("SELECT title FROM artifacts WHERE id=$1", [
        target.artifactId,
      ])
    ).rows[0].title,
    "Metadata current",
  );

  const expired = await connection(owner, ["manage"]);
  await db.query(
    `UPDATE agent_connections
     SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day'
     WHERE id=$1`,
    [expired.connectionId],
  );
  await assert.rejects(
    updateArtifactFromAgent(expired, {
      ...firstInput,
      key: randomUUID(),
      expectedTitle: "Metadata current",
      expectedFolderId: folderId,
    }),
    rejected(401, "unauthorized"),
  );
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  try {
    await assert.rejects(
      updateArtifactFromAgent(otherConnection, {
        ...firstInput,
        key: randomUUID(),
        expectedTitle: "Metadata current",
        expectedFolderId: folderId,
      }),
      rejected(401, "unauthorized"),
    );
  } finally {
    await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [
      owner.id,
    ]);
  }
});

test("manage-only lifecycle is exact-retry safe, ABA-safe, and preserves source state", async () => {
  const actor = await connection(owner, ["manage"]);
  const foreignActor = await connection(other, ["manage"]);
  const target = await artifact(owner, "Lifecycle via agent");
  const shareId = randomUUID();
  await db.query(
    `INSERT INTO shares(id,tenant_id,artifact_id,revision_id,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,now()+interval '1 day')`,
    [
      shareId,
      owner.tenant,
      target.artifactId,
      target.revisionId,
      sha256(randomBytes(32)),
    ],
  );
  await db.query(
    `INSERT INTO grants(hash,share_id,revision_id,expires_at)
     VALUES($1,$2,$3,now()+interval '1 hour')`,
    [sha256(randomBytes(32)), shareId, target.revisionId],
  );
  const before = (
    await db.query(
      `SELECT tenant.used_bytes,revision.object_key,revision.object_version,
              revision.sha256,revision.size
       FROM tenants tenant JOIN revisions revision ON revision.tenant_id=tenant.id
       WHERE tenant.id=$1 AND revision.id=$2`,
      [owner.tenant, target.revisionId],
    )
  ).rows[0];
  const request = {
    artifactId: target.artifactId,
    expectedLifecycleVersion: 0,
    expectedRevisionId: target.revisionId,
  };
  await assert.rejects(
    transitionArtifactFromAgent(foreignActor, request, "trashed"),
    rejected(404, "not_found"),
  );
  const trashed = await transitionArtifactFromAgent(actor, request, "trashed");
  assert.equal(trashed.lifecycleVersion, 1);
  assert.ok(trashed.trashedAt);
  assert.deepEqual(
    await transitionArtifactFromAgent(actor, request, "trashed"),
    trashed,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM audit_outbox WHERE target_id=$1 AND action='artifact.trashed'",
          [target.artifactId],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.equal(
    (await db.query("SELECT revoked FROM shares WHERE id=$1", [shareId]))
      .rows[0].revoked,
    true,
  );
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM grants WHERE share_id=$1", [
          shareId,
        ])
      ).rows[0].count,
    ),
    0,
  );
  const restored = await transitionArtifactFromAgent(
    actor,
    { ...request, expectedLifecycleVersion: 1 },
    "active",
  );
  assert.deepEqual(restored, {
    id: target.artifactId,
    trashedAt: null,
    lifecycleVersion: 2,
  });
  assert.deepEqual(
    await transitionArtifactFromAgent(
      actor,
      { ...request, expectedLifecycleVersion: 1 },
      "active",
    ),
    restored,
  );
  await assert.rejects(
    transitionArtifactFromAgent(actor, request, "trashed"),
    rejected(409, "conflict"),
  );
  const afterSource = (
    await db.query(
      `SELECT tenant.used_bytes,revision.object_key,revision.object_version,
              revision.sha256,revision.size
       FROM tenants tenant JOIN revisions revision ON revision.tenant_id=tenant.id
       WHERE tenant.id=$1 AND revision.id=$2`,
      [owner.tenant, target.revisionId],
    )
  ).rows[0];
  assert.deepEqual(afterSource, before);
  assert.equal(
    (await db.query("SELECT revoked FROM shares WHERE id=$1", [shareId]))
      .rows[0].revoked,
    true,
  );
});
