// What an extension may read (docs/specs/EXTENSIONS.md, context.content and
// context.auditFeed): a version with its work and files, each file as a
// stream checked against the record, nothing of a version moderation holds,
// nothing of a deleted work; the journal in commit order, with no row skipped
// behind a transaction that commits late.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionContext, PolkaExtension } from "../packages/extension-api/index.ts";
import { useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import {
  beginBundleUpload,
  beginUpload,
  finalizeBundleUpload,
  finalizeUpload,
  uploadBundleFile,
  uploadBytes,
} from "../apps/server/artifacts.ts";
import { transitionOwnerArtifactLifecycle } from "../apps/server/artifact-trash.ts";
import { verifyingStream } from "../apps/server/extension-content.ts";
import { parsePdfAnswer } from "../apps/server/renderer-pdf.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

let context!: ExtensionContext;
const probe: PolkaExtension = {
  name: "probe",
  register(_app, given) {
    context = given;
  },
};
useExtensions([probe]);
const { createApp } = await import("../apps/server/app.ts");
const app = await createApp();
let owner: Awaited<ReturnType<typeof createAccount>>;

const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function saveText(title: string, text: string) {
  const bytes = Buffer.from(text);
  const begun = await beginUpload(owner, {
    key: randomUUID(),
    title,
    filename: "note.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: hex(bytes),
    folderId: null,
  });
  await uploadBytes(owner, begun.uploadId, bytes);
  return (await finalizeUpload(owner, begun.uploadId)) as { artifactId: string; revisionId: string };
}

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  await pipeline(stream, async function* (source) {
    for await (const chunk of source) chunks.push(chunk as Buffer);
  });
  return Buffer.concat(chunks);
}

before(async () => {
  owner = await createAccount(`ext-content-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("a version with its work, shelf and files; each file streams as recorded", async () => {
  const saved = await saveText("Заметка", "Текст заметки");
  const version = await context.content.revision(owner.tenant, saved.revisionId);
  assert.ok(version);
  assert.equal(version.artifact.title, "Заметка");
  assert.equal(version.shelf.kind, "personal");
  assert.equal(version.revision.number, 1);
  assert.equal(version.unavailable, null);
  assert.deepEqual(version.files, [
    {
      index: 0,
      path: "note.txt",
      mime: "text/plain",
      size: Buffer.byteLength("Текст заметки"),
      sha256: hex(Buffer.from("Текст заметки")),
    },
  ]);
  assert.equal(
    (await readAll(await context.content.openFile(owner.tenant, saved.revisionId, 0))).toString(),
    "Текст заметки",
  );
  // Another shelf's id finds nothing.
  assert.equal(await context.content.revision(randomUUID(), saved.revisionId), null);
});

test("a project's files, in the manifest's order", async () => {
  const files: Array<[string, string, Buffer]> = [
    ["README.md", "text/markdown", Buffer.from("# Проект\n")],
    ["notes/a.md", "text/markdown", Buffer.from("# A\n")],
  ];
  const begun = await beginBundleUpload(owner, {
    key: randomUUID(),
    title: "Проект",
    manifest: {
      version: 1,
      entrypoint: "README.md",
      runtime: "project-v1",
      files: files.map(([path, mime, bytes]) => ({ path, mime, size: bytes.length, sha256: hex(bytes) })),
      provenance: {
        kind: "file",
        sourceUrl: null,
        capturedAt: new Date().toISOString(),
        attribution: "unknown",
        license: "unknown",
      },
      dependencies: { status: "unknown", unresolved: [] },
    },
  });
  for (const [index, file] of begun.manifest.files.entries())
    await uploadBundleFile(owner, begun.uploadId, index, files.find(([path]) => path === file.path)![2]);
  const saved = (await finalizeBundleUpload(owner, begun.uploadId)) as { revisionId: string };
  const version = await context.content.revision(owner.tenant, saved.revisionId);
  assert.deepEqual(
    version!.files.map((file) => file.path),
    ["README.md", "notes/a.md"],
  );
  assert.equal(version!.revision.entrypoint, "README.md");
  assert.equal(version!.revision.runtime, "project-v1");
  assert.ok(version!.revision.manifestSha256);
  assert.equal((await readAll(await context.content.openFile(owner.tenant, saved.revisionId, 1))).toString(), "# A\n");
});

test("moderation, the trash and deletion: reported, never read", async () => {
  // A text of its own: a blocked hash is refused to every later save of the run.
  const blocked = `заблокированное ${randomBytes(6).toString("hex")}`;
  const held = await saveText("Заблокировано", blocked);
  await db.query(
    `INSERT INTO moderation_blocks(id,tenant_id,artifact_id,revision_id,sha256,category,isolated)
     VALUES($1,$2,$3,$4,$5,'other',true)`,
    [randomUUID(), owner.tenant, held.artifactId, held.revisionId, sha256(Buffer.from(blocked))],
  );
  assert.equal((await context.content.revision(owner.tenant, held.revisionId))!.unavailable, "blocked");
  await assert.rejects(context.content.openFile(owner.tenant, held.revisionId, 0), /заблокирована/);

  const old = await saveText("В корзине", "старое");
  await transitionOwnerArtifactLifecycle(
    owner,
    old.artifactId,
    { expectedLifecycleVersion: 0, expectedRevisionId: old.revisionId },
    "trashed",
  );
  assert.equal((await context.content.revision(owner.tenant, old.revisionId))!.artifact.trashed, true);

  const gone = await saveText("Удалено", "удалённое");
  await db.query("UPDATE artifacts SET trashed_at=now(),purged_at=now() WHERE id=$1", [gone.artifactId]);
  assert.equal(await context.content.revision(owner.tenant, gone.revisionId), null);
  await assert.rejects(context.content.openFile(owner.tenant, gone.revisionId, 0), /Нет такой версии/);
});

test("a stream that is not the recorded file fails at its end", async () => {
  const good = Buffer.from("правильные байты");
  assert.equal(
    (await readAll(Readable.from([good]).pipe(verifyingStream({ size: good.length, sha256: hex(good) })))).toString(),
    "правильные байты",
  );
  await assert.rejects(
    readAll(Readable.from([good.subarray(0, 5)]).pipe(verifyingStream({ size: good.length, sha256: hex(good) }))),
    /checksum/,
  );
  await assert.rejects(
    readAll(Readable.from([good]).pipe(verifyingStream({ size: good.length, sha256: "0".repeat(64) }))),
    /checksum/,
  );
  // The last chunk waits for the check: a wrong file never arrives whole.
  const seen: Buffer[] = [];
  const checked = verifyingStream({ size: good.length * 2, sha256: "0".repeat(64) });
  checked.on("data", (chunk: Buffer) => seen.push(chunk));
  await assert.rejects(pipeline(Readable.from([good, good]), checked));
  assert.ok(Buffer.concat(seen).length < good.length * 2);
  await assert.rejects(
    readAll(Readable.from([good, good]).pipe(verifyingStream({ size: good.length, sha256: hex(good) }))),
    /larger/,
  );
});

test("the journal: commit order, a cursor to keep, nothing skipped behind a late commit", async () => {
  const start = await context.auditFeed.head();
  const action = `probe.${randomBytes(3).toString("hex")}`;
  const insert = (c: { query: typeof db.query }, n: number) =>
    c.query("INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,payload) VALUES($1,$2,$3,$4,$5)", [
      owner.tenant,
      owner.id,
      action,
      randomUUID(),
      { n },
    ]);
  // A transaction that started first and commits last.
  const late = await db.connect();
  let early!: Awaited<ReturnType<typeof context.auditFeed.read>>;
  try {
    await late.query("BEGIN");
    await insert(late, 1);
    await insert(db, 2);
    early = await context.auditFeed.read(start, { actions: [action], limit: 10 });
    assert.deepEqual(early.items, [], "the committed row waits behind the open transaction");
    await late.query("COMMIT");
  } finally {
    late.release();
  }
  // Rows show once no open transaction can precede them; other test files
  // running beside this one hold transactions open for a moment.
  const settled = async (cursor: typeof start | null) => {
    for (let tries = 0; ; tries++) {
      const result = await context.auditFeed.read(cursor, { actions: [action], limit: 10 });
      if (result.items.length === 2 || tries === 100) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  // The cursor kept from the early read did not move past either row.
  const resumed = await settled(early.next);
  assert.deepEqual(
    resumed.items.map((item) => item.payload?.n),
    [1, 2],
  );
  const page = await settled(start);
  assert.deepEqual(
    page.items.map((item) => item.payload?.n),
    [1, 2],
  );
  assert.equal(page.items[0]!.tenantId, owner.tenant);
  // Read from the returned cursor: nothing again; a full page stops at its last row.
  assert.deepEqual((await context.auditFeed.read(page.next, { actions: [action], limit: 10 })).items, []);
  const first = await context.auditFeed.read(start, { actions: [action], limit: 1 });
  assert.deepEqual(
    first.items.map((item) => item.payload?.n),
    [1],
  );
  assert.deepEqual(
    (await context.auditFeed.read(first.next, { actions: [action], limit: 1 })).items.map((item) => item.payload?.n),
    [2],
  );
});

test("no renderer, no PDF; the renderer's answer is a small PDF or a known outcome", () => {
  assert.equal(context.content.pdf, null);
  const pdf = Buffer.from("%PDF-1.7\n%…").toString("base64");
  assert.deepEqual(parsePdfAnswer(200, JSON.stringify({ pdf })), { pdf });
  assert.deepEqual(parsePdfAnswer(503, JSON.stringify({ error: "busy" })), { error: "busy" });
  assert.deepEqual(parsePdfAnswer(404, JSON.stringify({ error: "bad_request" })), { error: "outdated" });
  assert.throws(() => parsePdfAnswer(200, JSON.stringify({ pdf: Buffer.from("<html>").toString("base64") })));
  assert.throws(() => parsePdfAnswer(200, JSON.stringify({ error: "weird" })));
  assert.throws(() => parsePdfAnswer(200, "not json"));
});
