// A shelf moved to another installation (docs/specs/SHELF_TRANSFER.md): the
// inventory and files over GET /api/v1/export, written by polka-export.mjs,
// saved onto another shelf by importShelf. Two accounts stand in for the two
// installations: every version, its number and date, the folders, the
// accepted version, the person responsible, the card and the trash arrive;
// a rerun of either side does nothing twice; damaged or oversized exports are
// refused before anything is written.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { AgentScope } from "../packages/contracts/index.ts";
import { shelfExportFileSchema } from "../packages/contracts/shelf-export.ts";
import { createApp } from "../apps/server/app.ts";
import { acceptRevision, setWorkOwner } from "../apps/server/artifact-acceptance.ts";
import { transitionOwnerArtifactLifecycle } from "../apps/server/artifact-trash.ts";
import {
  beginBundleUpload,
  beginUpload,
  finalizeBundleUpload,
  finalizeUpload,
  uploadBundleFile,
  uploadBytes,
} from "../apps/server/artifacts.ts";
import { createAccount } from "../apps/server/auth.ts";
import { db, transaction } from "../apps/server/db.ts";
import { createFolderInTransaction } from "../apps/server/folders.ts";
import { saveLink } from "../apps/server/saved-links.ts";
import { setShelfCard } from "../apps/server/shelf-card.ts";
import { ImportRefusal, importShelf } from "../apps/server/shelf-import.ts";
import { MCP_AUDIENCE, PROJECT_UPLOAD_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const password = randomBytes(24).toString("hex");
const cliPath = fileURLToPath(new URL("../scripts/polka-export.mjs", import.meta.url));
type Account = Awaited<ReturnType<typeof createAccount>>;
let source: Account;
let endpoint = "";
let scratch = "";
let exportDir = "";
const ids: Record<string, string> = {};

const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf00000301010018dd8db40000000049454e44ae426082",
  "hex",
);

async function token(owner: Account, scopes: AgentScope[] = ["read", "source:read"], audience = MCP_AUDIENCE) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'export',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), scopes, audience],
  );
  return secret;
}

async function saveFile(
  owner: Account,
  input: { title: string; filename: string; mime: string; bytes: Buffer; folderId?: string; base?: { artifactId: string; revisionId: string } },
) {
  const begun = await beginUpload(owner, {
    key: randomUUID(),
    title: input.title,
    filename: input.filename,
    mime: input.mime,
    size: input.bytes.length,
    sha256: hex(input.bytes),
    ...(input.base ? { artifactId: input.base.artifactId, baseRevisionId: input.base.revisionId } : { folderId: input.folderId ?? null }),
  });
  await uploadBytes(owner, begun.uploadId, input.bytes);
  return (await finalizeUpload(owner, begun.uploadId)) as { artifactId: string; revisionId: string; number: number };
}

async function saveProject(owner: Account, files: Array<[string, string, Buffer]>, base?: { artifactId: string; revisionId: string }) {
  const manifest = {
    version: 1,
    entrypoint: "README.md",
    runtime: "project-v1",
    files: files.map(([path, mime, bytes]) => ({ path, mime, size: bytes.length, sha256: hex(bytes) })),
    provenance: { kind: "file", sourceUrl: null, capturedAt: "2026-01-02T03:04:05.000Z", attribution: "unknown", license: "unknown" },
    dependencies: { status: "unknown", unresolved: [] },
  };
  const begun = await beginBundleUpload(owner, {
    key: randomUUID(),
    title: "Исследование",
    manifest,
    ...(base ? { artifactId: base.artifactId, baseRevisionId: base.revisionId } : {}),
  });
  for (const [index, file] of begun.manifest.files.entries())
    await uploadBundleFile(owner, begun.uploadId, index, files.find(([path]) => path === file.path)![2]);
  return (await finalizeBundleUpload(owner, begun.uploadId)) as { artifactId: string; revisionId: string; number: number };
}

const page = (text: string) => Buffer.from(`<!doctype html><title>Отчёт</title><h1>${text}</h1>`);

function runExport(dir: string, secret: string, extra: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliPath, dir, "--endpoint", endpoint, "--json", ...extra], {
      env: { ...process.env, POLKA_TOKEN: secret },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** What a shelf holds, by title, for comparing the two sides. */
async function shelfOf(tenant: string) {
  const { rows } = await db.query(
    `SELECT a.title,f.name AS folder,a.trashed_at,a.updated_at,a.owner_account_id IS NOT NULL AS owned,
            accepted.number AS accepted,
            json_agg(json_build_object('number',r.number,'createdAt',r.created_at,'sha256',r.sha256,'mime',r.mime,
              'filename',r.filename,'totalSize',r.total_size,'manifestSha256',
              CASE WHEN r.storage_kind='bundle' OR r.manifest->'provenance'->>'kind'='url' THEN r.manifest_sha256 END,
              'capturedAt',r.manifest->'provenance'->>'capturedAt') ORDER BY r.number) AS revisions
       FROM artifacts a
       JOIN revisions r ON r.artifact_id=a.id
       LEFT JOIN folders f ON f.id=a.folder_id
       LEFT JOIN revisions accepted ON accepted.id=a.accepted_revision_id
      WHERE a.tenant_id=$1 AND a.purged_at IS NULL
      GROUP BY a.id,f.name,accepted.number ORDER BY a.title`,
    [tenant],
  );
  return rows.map((row) => ({
    ...row,
    trashed_at: row.trashed_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
    revisions: row.revisions.map((r: any) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })),
  }));
}

before(async () => {
  source = await createAccount(`export-${randomBytes(5).toString("hex")}`, password);
  scratch = await mkdtemp(join(tmpdir(), "polka-transfer-"));
  exportDir = join(scratch, "export");
  await app.listen({ port: 0, host: "127.0.0.1" });
  endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const folder = await transaction((c) => createFolderInTransaction(c, source, "Отчёты"));
  // A page in three versions; the second is accepted.
  const v1 = await saveFile(source, { title: "Квартальный отчёт", filename: "report.html", mime: "text/html", bytes: page("Выручка 1"), folderId: folder.id });
  const v2 = await saveFile(source, { title: "Квартальный отчёт", filename: "report.html", mime: "text/html", bytes: page("Выручка 2"), base: v1 });
  await saveFile(source, { title: "Квартальный отчёт", filename: "report.html", mime: "text/html", bytes: page("Выручка неповторимая 3"), base: v2 });
  await acceptRevision(source, v1.artifactId, { revisionId: v2.revisionId });
  await setWorkOwner(source, v1.artifactId, { ownerAccountId: source.id });
  ids.report = v1.artifactId;
  // A project in two versions sharing a file.
  const readme = Buffer.from("# Исследование\n\nСм. заметки.\n");
  const p1 = await saveProject(source, [["README.md", "text/markdown", readme], ["notes.md", "text/markdown", Buffer.from("# Первые\n")]]);
  await saveProject(source, [["README.md", "text/markdown", readme], ["notes.md", "text/markdown", Buffer.from("# Вторые\n")], ["shot.png", "image/png", PNG]], p1);
  // A picture, a text, a link.
  await saveFile(source, { title: "Схема", filename: "scheme.png", mime: "image/png", bytes: PNG });
  await saveFile(source, { title: "Заметка", filename: "note.txt", mime: "text/plain", bytes: Buffer.from("Текст заметки") });
  await saveLink(source, { key: randomUUID(), url: "https://example.com/article", title: "Статья", note: "прочитать" });
  // A work in the trash.
  const old = await saveFile(source, { title: "Старьё", filename: "old.txt", mime: "text/plain", bytes: Buffer.from("в корзине") });
  ids.trashed = old.artifactId;
  ids.trashedRevision = old.revisionId;
  await transitionOwnerArtifactLifecycle(source, old.artifactId, { expectedLifecycleVersion: 0, expectedRevisionId: old.revisionId }, "trashed");
  // A work moderation isolated: listed, its bytes never given out.
  const blocked = await saveFile(source, { title: "Заблокировано", filename: "bad.txt", mime: "text/plain", bytes: Buffer.from("плохое") });
  ids.blockedRevision = blocked.revisionId;
  await db.query(
    `INSERT INTO moderation_blocks(id,tenant_id,artifact_id,revision_id,sha256,category,isolated)
     VALUES($1,$2,$3,$4,$5,'other',true)`,
    [randomUUID(), source.tenant, blocked.artifactId, blocked.revisionId, sha256(Buffer.from("плохое"))],
  );
  await setShelfCard(source, { cardMd: "# Полка\n\nОтчёты отдела." });
  // Older dates, so a copy made now would show.
  await db.query(
    "UPDATE revisions SET created_at=timestamptz '2026-01-01T00:00:00Z'+number*interval '1 day' WHERE tenant_id=$1",
    [source.tenant],
  );
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await app.close();
  await db.end();
  s3.destroy();
});

test("runs as the runtime role when the grants suite asks", async () => {
  const expected = process.env.RUNTIME_GRANTS_EXPECT_ROLE;
  if (!expected) return;
  const {
    rows: [identity],
  } = await db.query("SELECT current_user");
  assert.equal(identity.current_user, expected);
});

test("polka-export.mjs writes the whole shelf, each file once", async () => {
  const secret = await token(source);
  const run = await runExport(exportDir, secret);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.works, 7);
  assert.equal(result.versions, 10);
  assert.deepEqual(result.unavailable.map((u: any) => u.reason), ["blocked"]);
  // The project's README is shared by its two versions: downloaded once.
  const blobs = await readdir(join(exportDir, "blobs"));
  assert.equal(blobs.length, result.files);
  assert.ok(blobs.every((name) => /^[a-f0-9]{64}$/.test(name)));
  assert.ok(result.files < 11);
  const exported = shelfExportFileSchema.parse(JSON.parse(await readFile(join(exportDir, "polka-export.json"), "utf8")));
  assert.equal(exported.shelf.cardMd, "# Полка\n\nОтчёты отдела.");
  assert.ok(exported.items.find((item) => item.id === ids.trashed)?.trashedAt);
  const report = exported.items.find((item) => item.id === ids.report)!;
  assert.ok(report.acceptedAt && report.ownerIsSelf);
  assert.equal(report.revisions[0].createdAt, "2026-01-02T00:00:00.000Z");

  // A rerun downloads nothing and keeps the run's id.
  const again = JSON.parse((await runExport(exportDir, secret)).stdout);
  assert.equal(again.fetched, 0);
  assert.equal(again.kept, result.files);
  assert.equal(again.exportId, result.exportId);
});

test("the export routes: scopes, the browser, the upload token, the trash", async () => {
  const get = (url: string, secret: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${secret}`, ...headers } });
  assert.equal((await get("/api/v1/export", await token(source, ["read"]))).statusCode, 403);
  assert.equal((await get("/api/v1/export", await token(source, ["source:read"]))).statusCode, 403);
  assert.equal((await get("/api/v1/export", await token(source, ["read", "source:read"], PROJECT_UPLOAD_AUDIENCE))).statusCode, 401);
  const secret = await token(source);
  assert.equal((await get("/api/v1/export", secret, { origin: "https://evil.example" })).statusCode, 403);
  // A work in the trash: its file comes through the export only.
  const trashed = await get(`/api/v1/export/revisions/${ids.trashedRevision}/files/0`, secret);
  assert.equal(trashed.statusCode, 200);
  assert.equal(trashed.body, "в корзине");
  assert.equal(
    (await get(`/api/v1/works/${ids.trashed}/revisions/${ids.trashedRevision}/files/0`, secret)).statusCode,
    404,
  );
  assert.equal((await get(`/api/v1/export/revisions/${ids.blockedRevision}/files/0`, secret)).statusCode, 410);
  // Another shelf's version is not found.
  const other = await createAccount(`export-other-${randomBytes(4).toString("hex")}`, password);
  assert.equal(
    (await get(`/api/v1/export/revisions/${ids.trashedRevision}/files/0`, await token(other))).statusCode,
    404,
  );
  // Small pages: the cursor walks the whole shelf.
  const first = (await get("/api/v1/export?limit=4", secret)).json();
  assert.equal(first.items.length, 4);
  const second = (await get(`/api/v1/export?limit=4&cursor=${first.nextCursor}`, secret)).json();
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  // The CLI is served pointed at this installation.
  const cli = await app.inject({ method: "GET", url: "/api/v1/cli/polka-export.mjs" });
  assert.equal(cli.statusCode, 200);
  assert.match(cli.body, /^const DEFAULT_ENDPOINT = "http/m);
});

test("importShelf saves every version, date, folder, acceptance, card and the trash", async () => {
  const target = await createAccount(`import-${randomBytes(5).toString("hex")}`, password);
  const dry = await importShelf({ dir: exportDir, account: target.name, dryRun: true });
  assert.equal(dry.works, 6);
  assert.deepEqual(dry.skipped.map((s) => s.title), ["Заблокировано"]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM artifacts WHERE tenant_id=$1", [target.tenant])).rows[0].n, 0);

  const report = await importShelf({ dir: exportDir, account: target.name });
  assert.equal(report.imported.length, 6);
  assert.deepEqual(report.foldersCreated, ["Отчёты"]);
  const expected = (await shelfOf(source.tenant)).filter((work) => work.title !== "Заблокировано");
  const actual = await shelfOf(target.tenant);
  assert.deepEqual(actual, expected);
  assert.equal(actual.find((work) => work.title === "Квартальный отчёт")!.accepted, 2);
  const { rows: [shelf] } = await db.query("SELECT card_md FROM tenants WHERE id=$1", [target.tenant]);
  assert.equal(shelf.card_md, "# Полка\n\nОтчёты отдела.");
  // Every object lives under the new shelf; search finds the text.
  const { rows: keys } = await db.query(
    `SELECT object_key FROM revisions WHERE tenant_id=$1
     UNION ALL SELECT f.object_key FROM revision_files f JOIN revisions r ON r.id=f.revision_id WHERE r.tenant_id=$1`,
    [target.tenant],
  );
  assert.ok(keys.every((row) => row.object_key.startsWith(`${target.tenant}/`)));
  const { rows: found } = await db.query(
    "SELECT 1 FROM artifact_search s JOIN artifacts a ON a.id=s.artifact_id WHERE a.tenant_id=$1 AND s.body LIKE '%неповторимая%'",
    [target.tenant],
  );
  assert.equal(found.length, 1);
  // The acceptance is journaled at its original time (the shelf snapshot reads it).
  const { rows: [event] } = await db.query(
    "SELECT created_at FROM audit_outbox WHERE tenant_id=$1 AND action='revision.accepted'",
    [target.tenant],
  );
  const exported = shelfExportFileSchema.parse(JSON.parse(await readFile(join(exportDir, "polka-export.json"), "utf8")));
  assert.equal(event.created_at.toISOString(), exported.items.find((item) => item.id === ids.report)!.acceptedAt);

  // A rerun saves nothing.
  const uploads = async () => (await db.query("SELECT count(*)::int AS n FROM uploads WHERE tenant_id=$1", [target.tenant])).rows[0].n;
  const before = await uploads();
  const rerun = await importShelf({ dir: exportDir, account: target.name });
  assert.ok(rerun.imported.every((work) => work.saved === 0));
  assert.equal(rerun.bytesNeeded, 0);
  assert.equal(await uploads(), before);
  assert.deepEqual(await shelfOf(target.tenant), expected);
});

test("an interrupted import continues where it stopped", async () => {
  const target = await createAccount(`import-cut-${randomBytes(5).toString("hex")}`, password);
  const cut = await importShelf({ dir: exportDir, account: target.name, maxRevisions: 2 });
  assert.ok(cut.incomplete);
  const done = await importShelf({ dir: exportDir, account: target.name });
  assert.ok(!done.incomplete);
  const expected = (await shelfOf(source.tenant)).filter((work) => work.title !== "Заблокировано");
  assert.deepEqual(await shelfOf(target.tenant), expected);
});

test("a damaged file or too little space is refused before anything is saved", async () => {
  const target = await createAccount(`import-bad-${randomBytes(5).toString("hex")}`, password);
  const damaged = join(scratch, "damaged");
  await cp(exportDir, damaged, { recursive: true });
  const [blob] = await readdir(join(damaged, "blobs"));
  await writeFile(join(damaged, "blobs", blob), "подмена");
  await assert.rejects(importShelf({ dir: damaged, account: target.name }), ImportRefusal);
  await db.query("UPDATE tenants SET quota_bytes=10 WHERE id=$1", [target.tenant]);
  await assert.rejects(importShelf({ dir: exportDir, account: target.name }), /--raise-quota/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM artifacts WHERE tenant_id=$1", [target.tenant])).rows[0].n, 0);
  const raised = await importShelf({ dir: exportDir, account: target.name, raiseQuota: true });
  assert.equal(raised.imported.length, 6);
  assert.ok(raised.quota.raisedTo);
});

test("a rerun leaves finished works as the owner changed them", async () => {
  const target = await createAccount(`import-again-${randomBytes(5).toString("hex")}`, password);
  await importShelf({ dir: exportDir, account: target.name });
  const {
    rows: [old],
  } = await db.query(
    "SELECT id,lifecycle_version,latest_revision_id FROM artifacts WHERE tenant_id=$1 AND title='Старьё'",
    [target.tenant],
  );
  await transitionOwnerArtifactLifecycle(
    target,
    old.id,
    { expectedLifecycleVersion: old.lifecycle_version, expectedRevisionId: old.latest_revision_id },
    "active",
  );
  await db.query("UPDATE artifacts SET title='Нужное' WHERE id=$1", [old.id]);
  await importShelf({ dir: exportDir, account: target.name });
  const {
    rows: [now],
  } = await db.query("SELECT title,trashed_at FROM artifacts WHERE id=$1", [old.id]);
  assert.deepEqual(now, { title: "Нужное", trashed_at: null });
});

test("a version this installation does not accept skips its work, in the dry run too", async () => {
  const target = await createAccount(`import-odd-${randomBytes(5).toString("hex")}`, password);
  const odd = join(scratch, "odd");
  await cp(exportDir, odd, { recursive: true });
  const exported = JSON.parse(await readFile(join(odd, "polka-export.json"), "utf8"));
  const note = exported.items.find((item: any) => item.title === "Заметка");
  note.revisions[0].mime = "application/x-unknown";
  await writeFile(join(odd, "polka-export.json"), JSON.stringify(exported));
  const dry = await importShelf({ dir: odd, account: target.name, dryRun: true });
  assert.match(dry.skipped.find((work) => work.title === "Заметка")!.reason, /не принимает версию \(mime\)/);
  const report = await importShelf({ dir: odd, account: target.name });
  assert.equal(report.imported.length, 5);
});
