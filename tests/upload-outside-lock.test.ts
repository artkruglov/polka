import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import {
  beginBundleUpload,
  beginUpload,
  finalizeBundleUpload,
  finalizeUpload,
  uploadBundleFile,
  uploadBytes,
} from "../apps/server/artifacts.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";

// A slow object store must not hold the shelf (apps/server/db.ts): every S3
// call of an upload is paused here, and meanwhile another connection takes
// the shelf's row lock, as any other save or rename on that shelf would.

type Gate = { command: string; key: string; entered: () => void; release: Promise<void> };
let gate: Gate | null = null;
s3.middlewareStack.add(
  (next, context) => async (args: any) => {
    const current = gate;
    if (
      current &&
      context.commandName === current.command &&
      args.input?.Key === current.key
    ) {
      gate = null;
      current.entered();
      await current.release;
    }
    return next(args);
  },
  { step: "initialize", name: "uploadOutsideLockGate" },
);

/** Runs `work`, pausing it at `command` on `key`; `during` runs while it waits. */
async function paused<T>(
  command: string,
  key: string,
  work: () => Promise<T>,
  during: () => Promise<void>,
) {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  gate = { command, key, entered, release: new Promise((resolve) => (release = resolve)) };
  const running = work();
  try {
    await Promise.race([
      reached,
      running.then(() => assert.fail(`${command} ${key} was never called`)),
    ]);
    await during();
  } finally {
    release();
  }
  return running;
}

async function assertShelfFree(tenant: string) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout='500ms'");
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [tenant]);
  } catch (error: any) {
    assert.fail(`the shelf is locked during object storage I/O: ${error?.message}`);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

after(async () => {
  await db.end();
  s3.destroy();
});

async function account() {
  return createAccount(
    `outside-lock-${randomBytes(5).toString("hex")}`,
    randomBytes(24).toString("hex"),
  );
}

test("a single upload writes and reads back its bytes without the shelf lock", async () => {
  const owner = await account();
  const bytes = Buffer.from("<!doctype html><title>Отчёт</title><p>Текст страницы</p>");
  const started = await beginUpload(owner, {
    key: randomUUID(),
    title: "Отчёт",
    filename: "report.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  const key = `${owner.tenant}/${started.uploadId}`;
  await paused(
    "PutObjectCommand",
    key,
    () => uploadBytes(owner, started.uploadId, bytes),
    () => assertShelfFree(owner.tenant),
  );
  const receipt: any = await paused(
    "GetObjectCommand",
    key,
    () => finalizeUpload(owner, started.uploadId),
    () => assertShelfFree(owner.tenant),
  );
  assert.equal(receipt.number, 1);
  assert.equal(receipt.htmlProfile, "static");
});

test("bytes sent again after the finalize read are the ones saved", async () => {
  const owner = await account();
  const bytes = Buffer.from("Обычный текст\n");
  const started = await beginUpload(owner, {
    key: randomUUID(),
    title: "Заметка",
    filename: "note.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  await uploadBytes(owner, started.uploadId, bytes);
  const receipt: any = await paused(
    "GetObjectCommand",
    `${owner.tenant}/${started.uploadId}`,
    () => finalizeUpload(owner, started.uploadId),
    // The client retries the PUT while finalize is reading: a new version.
    () => uploadBytes(owner, started.uploadId, bytes).then(() => {}),
  );
  const {
    rows: [row],
  } = await db.query(
    "SELECT r.object_version=u.object_version AS same FROM revisions r JOIN uploads u ON u.id=$1 WHERE r.id=$2",
    [started.uploadId, receipt.revisionId],
  );
  assert.equal(row.same, true);
});

test("a bundle stores and inspects its files without the shelf lock", async () => {
  const owner = await account();
  const page = Buffer.from(
    '<!doctype html><title>Пакет</title><link rel="stylesheet" href="style.css"><p>Пакет</p>',
  );
  const style = Buffer.from("p { color: #333 }\n");
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "preserved-only-v1",
    files: [
      { path: "index.html", mime: "text/html", size: page.length, sha256: sha256(page) },
      { path: "style.css", mime: "text/css", size: style.length, sha256: sha256(style) },
    ],
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: "2026-09-27T12:00:00Z",
      attribution: "Тест Полки",
      license: "unknown",
    },
    dependencies: { status: "self-contained", unresolved: [] },
  });
  const started = await beginBundleUpload(owner, {
    key: randomUUID(),
    title: "Пакет",
    manifest,
  });
  const styleKey = `${owner.tenant}/${started.uploadId}/files/1`;
  await uploadBundleFile(owner, started.uploadId, 0, page);
  await paused(
    "PutObjectCommand",
    styleKey,
    () => uploadBundleFile(owner, started.uploadId, 1, style),
    () => assertShelfFree(owner.tenant),
  );
  const receipt: any = await paused(
    "GetObjectCommand",
    styleKey,
    () => finalizeBundleUpload(owner, started.uploadId),
    () => assertShelfFree(owner.tenant),
  );
  assert.equal(receipt.storageKind, "bundle");
  const files = await db.query(
    "SELECT count(*)::int AS n FROM revision_files WHERE revision_id=$1",
    [receipt.revisionId],
  );
  assert.equal(files.rows[0].n, 2);
});
