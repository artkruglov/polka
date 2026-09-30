// Delete a work for good (docs/specs/WORK_DELETION.md): the owner empties it
// from the trash. Its objects leave the store, it leaves every list and every
// read, its bytes go back to the shelf's space, what is evidence or published
// is refused, and a run that stopped halfway is finished by the sweep.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { finishArtifactPurge, finishPendingArtifactPurges } from "../apps/server/artifact-purge.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { bucket, s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

const call = (method: any, url: string, body?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie }, payload: body as any });

async function save(title = "Удаляемая работа") {
  const bytes = Buffer.from(`<!doctype html><title>${title}</title><p>${randomUUID()}</p>`);
  const begun = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title,
    filename: "index.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  await app.inject({ method: "PUT", url: `/api/uploads/${uploadId}/bytes`, headers: { origin, cookie, "content-type": "application/octet-stream" }, payload: bytes });
  const done = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(done.statusCode, 200, done.body);
  return { ...done.json(), uploadId, size: bytes.length } as { artifactId: string; revisionId: string; uploadId: string; size: number };
}
const lifecycle = async (artifactId: string) => {
  const {
    rows: [row],
  } = await db.query("SELECT latest_revision_id,lifecycle_version FROM artifacts WHERE id=$1", [artifactId]);
  return { expectedRevisionId: row.latest_revision_id, expectedLifecycleVersion: Number(row.lifecycle_version) };
};
const trash = async (artifactId: string) => {
  const r = await call("POST", `/api/artifacts/${artifactId}/trash`, await lifecycle(artifactId));
  assert.equal(r.statusCode, 200, r.body);
};
const versionsOf = async (prefix: string) =>
  (await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }))).Versions?.length ?? 0;
const used = async () =>
  Number((await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [owner.tenant])).rows[0].used_bytes);

before(async () => {
  owner = await createAccount(`purge-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: owner.name, password } });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});
after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("a work in the trash is deleted for good: objects, lists, reads and space", async () => {
  const before = await used();
  const work = await save();
  assert.equal(await used(), before + work.size);
  assert.equal(await versionsOf(`${owner.tenant}/${work.uploadId}`), 1);
  // Only from the trash.
  const early = await call("POST", `/api/artifacts/${work.artifactId}/purge`, await lifecycle(work.artifactId));
  assert.equal(early.statusCode, 409, early.body);
  assert.match(early.json().message, /корзин/);
  await trash(work.artifactId);
  // A stale view of the work is refused.
  const stale = await call("POST", `/api/artifacts/${work.artifactId}/purge`, { ...(await lifecycle(work.artifactId)), expectedLifecycleVersion: 0 });
  assert.equal(stale.statusCode, 409);
  const gone = await call("POST", `/api/artifacts/${work.artifactId}/purge`, await lifecycle(work.artifactId));
  assert.equal(gone.statusCode, 200, gone.body);
  assert.deepEqual(gone.json(), { id: work.artifactId, purged: true });
  // The store holds nothing of it, and the shelf has its space back.
  assert.equal(await versionsOf(`${owner.tenant}/${work.uploadId}`), 0);
  assert.equal(await used(), before);
  // Not in the trash, not readable, not restorable, not deletable twice.
  const listed = (await call("GET", "/api/trash")).json().items as Array<{ id: string }>;
  assert.ok(!listed.some((item) => item.id === work.artifactId));
  assert.equal((await call("GET", `/api/artifacts/${work.artifactId}`)).statusCode, 404);
  assert.equal((await call("GET", `/api/artifacts/${work.artifactId}/revisions`)).statusCode, 404);
  assert.equal((await call("POST", `/api/artifacts/${work.artifactId}/restore`, { expectedRevisionId: work.revisionId, expectedLifecycleVersion: 2 })).statusCode, 404);
  assert.equal((await call("POST", `/api/artifacts/${work.artifactId}/purge`, await lifecycle(work.artifactId))).statusCode, 404);
  const {
    rows: [row],
  } = await db.query(
    `SELECT a.title,a.purged_at IS NOT NULL AS purged,r.content_purged_at IS NOT NULL AS bytes_gone
     FROM artifacts a JOIN revisions r ON r.artifact_id=a.id WHERE a.id=$1`,
    [work.artifactId],
  );
  assert.deepEqual(row, { title: "Удалено", purged: true, bytes_gone: true });
  // A second run finds nothing left to do.
  assert.deepEqual(await finishArtifactPurge(work.artifactId), { versions: 0 });
});

test("a work with a moderation record is refused, and another work is not touched", async () => {
  const kept = await save("Останется");
  const evidence = await save("Под решением модерации");
  await db.query(
    `INSERT INTO moderation_blocks(id,tenant_id,artifact_id,revision_id,sha256,category,isolated)
     VALUES($1,$2,$3,$4,$5,'other',false)`,
    [randomUUID(), owner.tenant, evidence.artifactId, evidence.revisionId, "a".repeat(64)],
  );
  await trash(evidence.artifactId);
  const refused = await call("POST", `/api/artifacts/${evidence.artifactId}/purge`, await lifecycle(evidence.artifactId));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().reason, "evidence");
  assert.equal(await versionsOf(`${owner.tenant}/${evidence.uploadId}`), 1);
  assert.equal(await versionsOf(`${owner.tenant}/${kept.uploadId}`), 1);
  assert.equal((await call("GET", `/api/artifacts/${kept.artifactId}`)).statusCode, 200);
});

test("links to the work are closed and a run that stopped halfway is finished by the sweep", async () => {
  const work = await save("Со ссылкой");
  const shared = await call("POST", `/api/artifacts/${work.artifactId}/share`, { expectedRevisionId: work.revisionId, expiresInDays: 7 });
  assert.equal(shared.statusCode, 200, shared.body);
  await trash(work.artifactId);
  const before = await used();
  // The first step done, the objects still there, as after a crash.
  await db.query("UPDATE shares SET revoked=true WHERE artifact_id=$1", [work.artifactId]);
  await db.query("UPDATE artifacts SET purged_at=now() WHERE id=$1", [work.artifactId]);
  assert.equal(await versionsOf(`${owner.tenant}/${work.uploadId}`), 1);
  assert.ok((await finishPendingArtifactPurges()) >= 1);
  assert.equal(await versionsOf(`${owner.tenant}/${work.uploadId}`), 0);
  assert.equal(await used(), before - work.size);
  const { rows } = await db.query("SELECT revoked FROM shares WHERE artifact_id=$1", [work.artifactId]);
  assert.ok(rows.length > 0 && rows.every((row) => row.revoked));
});
