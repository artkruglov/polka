import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import { acceptRevision, setWorkOwner } from "../apps/server/artifact-acceptance.ts";
import { shelfSnapshotForAgent } from "../apps/server/shelf-snapshot.ts";
import { listEventsForAgent } from "../apps/server/agent-events.ts";
import {
  getArtifactForAgent,
  listArtifactsForAgent,
  listFoldersForAgent,
  transitionArtifactFromAgent,
  updateArtifactFromAgent,
} from "../apps/server/agent-management.ts";
import { MCP_AUDIENCE, type ServiceActor } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;

async function connection(account: Awaited<ReturnType<typeof createAccount>>, scopes: string[]) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'management test',$5,$6,now()+interval '1 day')`,
    [id, account.tenant, account.id, sha256(randomBytes(32)), scopes, MCP_AUDIENCE],
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
  await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [artifactId, revisionId]);
  return { artifactId, revisionId };
}

const rejected = (status: number, code: string) => (error: any) => error?.status === status && error?.code === code;

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
  // The owner pastes the page's address: the same work, the same tenant check.
  const byAddress = await getArtifactForAgent(actor, {
    artifactId: `https://polochka.app/works/${trashedNewer.artifactId}?revision=x`,
  });
  assert.equal(byAddress.id, visible.id);
  await assert.rejects(
    getArtifactForAgent(actor, {
      artifactId: `https://polochka.app/works/${foreign.artifactId}`,
    }),
    rejected(404, "not_found"),
  );
  for (const secret of ["share", "token", "object_key", "url", "manifest"])
    assert.doesNotMatch(JSON.stringify(visible), new RegExp(secret, "i"));
  await assert.rejects(getArtifactForAgent(actor, { artifactId: foreign.artifactId }), rejected(404, "not_found"));

  const folders = [
    { id: randomUUID(), name: "Management A" },
    { id: randomUUID(), name: "Management B" },
  ];
  for (const folder of folders)
    await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [folder.id, owner.tenant, folder.name]);
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
    (await db.query("SELECT title FROM artifacts WHERE id=$1", [target.artifactId])).rows[0].title,
    "Metadata current",
  );
  await assert.rejects(
    updateArtifactFromAgent(actor, {
      ...firstInput,
      title: "Changed replay",
    }),
    rejected(409, "conflict"),
  );
  await assert.rejects(updateArtifactFromAgent(otherConnection, firstInput), rejected(409, "conflict"));
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
  assert.ok(auditRows.rows.every((row) => row.actor_type === "agent" && row.connection_id === actor.connectionId));

  await db.query("UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1", [actor.connectionId]);
  await assert.rejects(updateArtifactFromAgent(actor, firstInput), rejected(401, "unauthorized"));
  assert.equal(
    (await db.query("SELECT title FROM artifacts WHERE id=$1", [target.artifactId])).rows[0].title,
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
    await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [owner.id]);
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
    [shareId, owner.tenant, target.artifactId, target.revisionId, sha256(randomBytes(32))],
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
  await assert.rejects(transitionArtifactFromAgent(foreignActor, request, "trashed"), rejected(404, "not_found"));
  const trashed = await transitionArtifactFromAgent(actor, request, "trashed");
  assert.equal(trashed.lifecycleVersion, 1);
  assert.ok(trashed.trashedAt);
  assert.deepEqual(await transitionArtifactFromAgent(actor, request, "trashed"), trashed);
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM audit_outbox WHERE target_id=$1 AND action='artifact.trashed'", [
          target.artifactId,
        ])
      ).rows[0].count,
    ),
    1,
  );
  assert.equal((await db.query("SELECT revoked FROM shares WHERE id=$1", [shareId])).rows[0].revoked, true);
  assert.equal(Number((await db.query("SELECT count(*) FROM grants WHERE share_id=$1", [shareId])).rows[0].count), 0);
  const restored = await transitionArtifactFromAgent(actor, { ...request, expectedLifecycleVersion: 1 }, "active");
  assert.deepEqual(restored, {
    id: target.artifactId,
    trashedAt: null,
    lifecycleVersion: 2,
  });
  assert.deepEqual(
    await transitionArtifactFromAgent(actor, { ...request, expectedLifecycleVersion: 1 }, "active"),
    restored,
  );
  await assert.rejects(transitionArtifactFromAgent(actor, request, "trashed"), rejected(409, "conflict"));
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
  assert.equal((await db.query("SELECT revoked FROM shares WHERE id=$1", [shareId])).rows[0].revoked, true);
});

async function untilEvents(actor: ServiceActor, after: string, count: number) {
  // Other tests' open transactions can hold the feed back for a moment.
  for (let tries = 0; ; tries++) {
    const page = await listEventsForAgent(actor, { after });
    if (page.events.length >= count || tries > 60) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("the events feed shows works' events by cursor, only its own shelf, without noise", async () => {
  const actor = await connection(owner, ["context", "read"]);
  const mine = await artifact(owner, "Events work");
  const theirs = await artifact(other, "Foreign events work");
  const emit = (account: typeof owner, action: string, target: string, payload: object | null = null) =>
    db.query("INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,payload) VALUES($1,$2,$3,$4,$5)", [
      account.tenant,
      account.id,
      action,
      target,
      payload,
    ]);
  // Tailing: nothing back, the cursor is the current end.
  const tail = await listEventsForAgent(actor, {});
  assert.deepEqual(tail.events, []);
  await emit(owner, "revision.saved", mine.revisionId, { artifactId: mine.artifactId });
  await emit(owner, "account.merged", owner.id);
  await emit(owner, "artifact.trashed", mine.artifactId);
  await emit(other, "artifact.trashed", theirs.artifactId);
  await emit(owner, "artifact.trashed", randomUUID());
  await untilEvents(actor, tail.nextCursor, 2);
  const first = await listEventsForAgent(actor, { after: tail.nextCursor, limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].action, "revision.saved");
  assert.equal(first.events[0].artifactId, mine.artifactId);
  assert.equal(first.events[0].revisionId, mine.revisionId);
  assert.equal(first.more, true);
  const second = await listEventsForAgent(actor, { after: first.nextCursor, limit: 10 });
  assert.deepEqual(
    second.events.map((event) => [event.action, event.artifactId]),
    [["artifact.trashed", mine.artifactId]],
  );
  assert.equal(second.more, false);
  // Nothing new: the cursor stays.
  const idle = await listEventsForAgent(actor, { after: second.nextCursor });
  assert.deepEqual([idle.events.length, idle.nextCursor], [0, second.nextCursor]);
  // A row of a transaction still open hides every later one until it commits,
  // so a cursor never passes a row that commits after its neighbours.
  const slow = await db.connect();
  try {
    await slow.query("BEGIN");
    await slow.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'artifact.restored',$3)",
      [owner.tenant, owner.id, mine.artifactId],
    );
    await emit(owner, "artifact.moved", mine.artifactId);
    const hidden = await listEventsForAgent(actor, { after: second.nextCursor });
    assert.deepEqual(hidden.events, []);
    await slow.query("COMMIT");
  } finally {
    slow.release();
  }
  const late = await untilEvents(actor, second.nextCursor, 2);
  assert.deepEqual(late.events.map((event) => event.action).sort(), ["artifact.moved", "artifact.restored"]);
  // Needs the read scope.
  await assert.rejects(listEventsForAgent(await connection(owner, ["context"]), {}));
  await assert.rejects(listEventsForAgent(actor, { after: "abc" } as never));
});

test("a curator marks the accepted version and the owner; agents read both and see the events", async () => {
  const actor = await connection(owner, ["context", "read"]);
  const me = { id: owner.id, tenant: owner.tenant };
  const work = await artifact(owner, "Accepted work");
  const foreign = await artifact(other, "Foreign accepted work");
  const before = await getArtifactForAgent(actor, { artifactId: work.artifactId });
  assert.equal(before.acceptedRevisionId, null);
  assert.equal(before.ownerAccountId, null);
  const tail = await listEventsForAgent(actor, {});

  assert.deepEqual(await acceptRevision(me, work.artifactId, { revisionId: work.revisionId }), {
    artifactId: work.artifactId,
    acceptedRevisionId: work.revisionId,
  });
  // Only a version of this very work; nothing in another shelf.
  await assert.rejects(acceptRevision(me, work.artifactId, { revisionId: foreign.revisionId }));
  await assert.rejects(acceptRevision(me, foreign.artifactId, { revisionId: foreign.revisionId }));
  // The owner is a member of the shelf.
  await assert.rejects(setWorkOwner(me, work.artifactId, { ownerAccountId: other.id }), { status: 422 });
  await setWorkOwner(me, work.artifactId, { ownerAccountId: owner.id });

  const read = await getArtifactForAgent(actor, { artifactId: work.artifactId });
  assert.equal(read.acceptedRevisionId, work.revisionId);
  assert.equal(read.ownerAccountId, owner.id);
  const listed = await listArtifactsForAgent(actor, { query: "Accepted work" });
  assert.equal((listed.items[0] as any).acceptedRevisionId, work.revisionId);
  const feed = await untilEvents(actor, tail.nextCursor, 2);
  assert.deepEqual(
    feed.events.map((event) => [event.action, event.artifactId, event.revisionId]),
    [
      ["revision.accepted", work.artifactId, work.revisionId],
      ["owner.changed", work.artifactId, undefined],
    ],
  );
  // An owner who is no longer a member of the shelf (left, or erased) is not shown.
  await db.query("UPDATE artifacts SET owner_account_id=$2 WHERE id=$1", [work.artifactId, other.id]);
  assert.equal((await getArtifactForAgent(actor, { artifactId: work.artifactId })).ownerAccountId, null);
  // Cleared with null; the shelf's link would stay where it is.
  await acceptRevision(me, work.artifactId, { revisionId: null });
  assert.equal((await getArtifactForAgent(actor, { artifactId: work.artifactId })).acceptedRevisionId, null);
});

test("agent reads are counted per shelf and day, nothing else", async () => {
  const actor = await connection(owner, ["context", "read"]);
  const work = await artifact(owner, "Counted work");
  const count = async () =>
    Number(
      (
        await db.query(
          "SELECT COALESCE(sum(reads),0) AS n FROM agent_read_days WHERE tenant_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date",
          [owner.tenant],
        )
      ).rows[0].n,
    );
  const before = await count();
  await listArtifactsForAgent(actor, {});
  await getArtifactForAgent(actor, { artifactId: work.artifactId });
  // The cursor bootstrap and an empty poll are not reads; a poll that returns events is.
  const start = await listEventsForAgent(actor, {});
  assert.equal((await count()) - before, 2);
  await db.query("INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'artifact.trashed',$3)", [
    owner.tenant,
    owner.id,
    work.artifactId,
  ]);
  let polled = 0;
  for (let tries = 0; tries < 60 && !polled; tries++) {
    polled = (await listEventsForAgent(actor, { after: start.nextCursor })).events.length;
    if (!polled) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(polled);
  assert.ok((await count()) - before >= 3);
  const afterPolls = await count();
  await assert.rejects(listArtifactsForAgent(actor, { cursor: "not-a-cursor" }));
  await assert.rejects(getArtifactForAgent(actor, { artifactId: randomUUID() }));
  assert.equal(await count(), afterPolls, "refused and missing reads are not counted");
  // A refused read (no read scope) is not counted.
  const noRead = await connection(owner, ["context"]);
  await assert.rejects(listArtifactsForAgent(noRead, {}));
  assert.equal(await count(), afterPolls);
  const {
    rows: [row],
  } = await db.query("SELECT * FROM agent_read_days WHERE tenant_id=$1 LIMIT 1", [owner.tenant]);
  assert.deepEqual(Object.keys(row).sort(), ["day", "principal_type", "reads", "tenant_id"]);
});

test("the shelf snapshot shows works, versions, trash and accepted marks as they were at a moment", async () => {
  const actor = await connection(owner, ["context", "read"]);
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const at = async (iso: string) => {
    const found = new Map<string, any>();
    let cursor: string | undefined;
    do {
      const page = await shelfSnapshotForAgent(actor, { at: iso, limit: 1, cursor });
      for (const item of page.items) found.set(item.id, item);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  };
  const old = async (title: string, createdDaysAgo: number) => {
    const made = await artifact(owner, title);
    await db.query("UPDATE revisions SET created_at=$2 WHERE id=$1", [made.revisionId, day(createdDaysAgo)]);
    return made;
  };
  const journal = (action: string, artifactId: string, daysAgo: number, payload: object | null = null) =>
    db.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [owner.tenant, owner.id, action, artifactId, payload, day(daysAgo)],
    );
  const w1 = await old("Снимок: две версии", 10);
  const rev2 = randomUUID();
  await db.query(
    `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,storage_kind,total_size,created_at)
     VALUES($1,$2,$3,2,$4,'note.txt','text/plain',4,$5,$6,'version','single',4,$7)`,
    [rev2, owner.tenant, w1.artifactId, owner.id, sha256("note2"), `${owner.tenant}/snapshot/${rev2}`, day(5)],
  );
  await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [w1.artifactId, rev2]);
  const w2 = await old("Снимок: позже", 3);
  // In the trash from day 6 to the end (journaled), and in the trash day 6–4 then restored.
  const w3 = await old("Снимок: в корзине до", 10);
  await journal("artifact.trashed", w3.artifactId, 6);
  await db.query("UPDATE artifacts SET trashed_at=$2 WHERE id=$1", [w3.artifactId, day(6)]);
  const w4 = await old("Снимок: в корзине после", 10);
  await journal("artifact.trashed", w4.artifactId, 1);
  await db.query("UPDATE artifacts SET trashed_at=$2 WHERE id=$1", [w4.artifactId, day(1)]);
  const w5 = await old("Снимок: корзина и возврат", 10);
  await journal("artifact.trashed", w5.artifactId, 6);
  await journal("artifact.restored", w5.artifactId, 4);
  await journal("revision.accepted", w1.artifactId, 8, { artifactId: w1.artifactId, revisionId: w1.revisionId });
  await journal("revision.accepted", w1.artifactId, 2, { artifactId: w1.artifactId, revisionId: rev2 });
  await journal("revision.accepted", w1.artifactId, 1, { artifactId: w1.artifactId, revisionId: null });

  const early = await at(day(7));
  assert.equal(early.get(w1.artifactId).revision.number, 1);
  assert.equal(early.get(w1.artifactId).acceptedRevisionId, w1.revisionId);
  assert.ok(early.has(w3.artifactId), "trashed later: it was on the shelf then");
  assert.ok(early.has(w4.artifactId));
  assert.ok(early.has(w5.artifactId));
  assert.ok(!early.has(w2.artifactId), "not saved yet");

  const trashed = await at(day(5));
  assert.ok(!trashed.has(w5.artifactId), "in the trash then, though restored since");
  assert.ok(!trashed.has(w3.artifactId));

  const middle = await at(day(3));
  assert.equal(middle.get(w1.artifactId).revision.number, 2);
  assert.equal(middle.get(w1.artifactId).acceptedRevisionId, w1.revisionId, "the later acceptance is not yet");
  assert.ok(middle.has(w5.artifactId), "restored by then");
  assert.ok(!middle.has(w3.artifactId));
  assert.ok(middle.has(w4.artifactId));

  const recent = await at(day(1.5));
  assert.equal(recent.get(w1.artifactId).acceptedRevisionId, rev2);
  // "Now" by the database's clock: rows were written with its now(), and the
  // Docker VM's clock may run ahead of this process's.
  const {
    rows: [{ t: dbNow }],
  } = await db.query<{ t: Date }>("SELECT now() AS t");
  const now = await at(dbNow.toISOString());
  assert.equal(now.get(w1.artifactId).acceptedRevisionId, null, "the mark was cleared");
  assert.ok(now.has(w2.artifactId));
  assert.ok(!now.has(w4.artifactId), "in the trash now");

  // The boundary is inclusive: a version stamped exactly at the moment is in.
  const [{ created_at: exact }] = (await db.query("SELECT created_at FROM revisions WHERE id=$1", [rev2])).rows;
  const sharp = await at(new Date(exact).toISOString());
  assert.equal(sharp.get(w1.artifactId).revision.number, 2);

  // Not the future; the «+» offset arriving as a space is understood; a bad cursor and a missing read scope are refused.
  await assert.rejects(shelfSnapshotForAgent(actor, { at: new Date(Date.now() + 3_600_000).toISOString() }), {
    status: 400,
  });
  const plus = await shelfSnapshotForAgent(actor, { at: day(0).replace("Z", "+00:00").replace("+", " "), limit: 1 });
  assert.ok(plus.items.length <= 1);
  await assert.rejects(shelfSnapshotForAgent(actor, { at: day(0), cursor: "nope" as never }));
  await assert.rejects(shelfSnapshotForAgent(await connection(owner, ["context"]), { at: day(0) }), { status: 403 });
  // Another shelf's token sees none of these works and does see its own.
  const theirs = await artifact(other, "Снимок: чужая полка");
  const stranger = await connection(other, ["context", "read"]);
  const foreign = await shelfSnapshotForAgent(stranger, { at: day(0), limit: 100 });
  const mine: string[] = [w1, w2, w3, w4, w5].map((work) => work.artifactId);
  assert.ok(!foreign.items.some((item) => mine.includes(item.id)));
  assert.ok(foreign.items.some((item) => item.id === theirs.artifactId));
  // A snapshot is a read: it is counted.
  const counted = Number(
    (await db.query("SELECT COALESCE(sum(reads),0) AS n FROM agent_read_days WHERE tenant_id=$1", [owner.tenant]))
      .rows[0].n,
  );
  assert.ok(counted > 0);
});
