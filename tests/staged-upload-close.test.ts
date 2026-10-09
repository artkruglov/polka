// A version stored by an S3 PUT that lands after its upload was closed, or
// after its shelf's erasure was requested, is deleted at once: the cleanup
// that reconciles such uploads and the purge of an erased shelf list a prefix
// once, and would never look at an object that arrives later.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { beginUpload, discardStagedIfClosed, stageUploadBytes } from "../apps/server/artifacts.ts";
import { db } from "../apps/server/db.ts";
import { Problem } from "../apps/server/errors.ts";
import { putImmutable, readBlob, s3, sha256 } from "../apps/server/storage.ts";

after(async () => {
  await db.end();
  s3.destroy();
});

const bytes = Buffer.from("Текст работы\n");

async function pending() {
  const owner = await createAccount(`stage-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  const begun = await beginUpload(owner, {
    key: randomUUID(),
    title: "Заметка",
    filename: "note.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  return { owner, id: begun.uploadId as string, key: `${owner.tenant}/${begun.uploadId}` };
}

const gone = (key: string, version: string) => assert.rejects(readBlob(key, version), "the version is deleted");

test("an open upload keeps the version it stored", async () => {
  const { owner, id, key } = await pending();
  const version = await stageUploadBytes(owner, id, bytes);
  assert.ok(version);
  assert.deepEqual(await readBlob(key, version!), bytes);
});

test("a version stored after the upload was closed or reconciled is deleted", async () => {
  for (const close of [
    "UPDATE uploads SET aborted=true WHERE id=$1",
    "UPDATE uploads SET aborted=true,reconciled_at=now() WHERE id=$1",
    "UPDATE uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
  ]) {
    const { owner, id, key } = await pending();
    const version = await putImmutable(key, bytes);
    await db.query(close, [id]);
    await assert.rejects(discardStagedIfClosed(owner, id, key, version), (error) => {
      assert.ok(error instanceof Problem);
      assert.equal(error.status, 410);
      return true;
    });
    await gone(key, version);
  }
});

test("a version stored after the shelf's erasure was requested is deleted", async () => {
  const { owner, id, key } = await pending();
  const version = await putImmutable(key, bytes);
  await db.query("UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1", [owner.id]);
  await assert.rejects(discardStagedIfClosed(owner, id, key, version), Problem);
  await gone(key, version);
});

test("nothing staged, nothing to discard", async () => {
  const { owner, id, key } = await pending();
  assert.equal(await discardStagedIfClosed(owner, id, key, null), null);
});
