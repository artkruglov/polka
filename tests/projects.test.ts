// Projects, stage 1 (docs/specs/PROJECTS.md): a folder of linked pages saved
// as one work over the HTTP API and by scripts/polka-publish-project.mjs. A
// project may hold more files and bytes than a bundle and start at its
// README; every page and document is screened and searchable; a bundle keeps
// its old limits.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { AgentScope } from "../packages/contracts/index.ts";
import { bundleManifestSchema } from "../packages/contracts/bundle.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const password = randomBytes(24).toString("hex");
const cliPath = fileURLToPath(new URL("../scripts/polka-publish-project.mjs", import.meta.url));
let owner: Awaited<ReturnType<typeof createAccount>>;
let scratch = "";

async function token(scopes: AgentScope[] = ["context", "capture", "revise"]) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'projects',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}

type File = { path: string; mime: string; bytes: Buffer };
const file = (path: string, mime: string, text: string | Buffer): File => ({
  path,
  mime,
  bytes: Buffer.isBuffer(text) ? text : Buffer.from(text),
});
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf00000301010018dd8db40000000049454e44ae426082",
  "hex",
);
const GIF = Buffer.from("47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b", "hex");

const manifestOf = (files: File[], entrypoint: string, runtime = "project-v1") => ({
  version: 1,
  entrypoint,
  runtime,
  files: files.map((f) => ({
    path: f.path,
    mime: f.mime,
    size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  })),
  provenance: {
    kind: "file",
    sourceUrl: null,
    capturedAt: new Date().toISOString(),
    attribution: "unknown",
    license: "unknown",
  },
  dependencies: { status: "unknown", unresolved: [] },
});

async function upload(secret: string, files: File[], entrypoint: string, extra: Record<string, unknown> = {}) {
  const auth = { authorization: `Bearer ${secret}` };
  const begun = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...auth, "content-type": "application/json" },
    payload: JSON.stringify({
      key: randomUUID(),
      title: "Исследование",
      manifest: manifestOf(files, entrypoint),
      ...extra,
    }),
  });
  if (begun.statusCode !== 200) return { begun };
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const { index, path } of begun.json().files) {
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${begun.json().uploadId}/files/${index}`,
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: byPath.get(path)!.bytes,
    });
    assert.equal(put.statusCode, 200, put.body);
  }
  const finalized = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${begun.json().uploadId}/finalize`,
    headers: { ...auth, "content-type": "application/json" },
    payload: "{}",
  });
  return { begun, finalized };
}

const research = () => [
  file("README.md", "text/markdown", "# Исследование рынка\n\nСм. `02-users/stories.md` и [экраны](screens/index.html).\n"),
  file("02-users/stories.md", "text/markdown", "# Истории\n\nМенеджер готовит коммерческое предложение для клиента.\n"),
  file("screens/index.html", "text/html", '<!doctype html><title>Экраны</title><link rel="stylesheet" href="shared/ui.css"><h1>Сквозная цепочка экранов</h1><img src="shot.png">'),
  file("screens/shared/ui.css", "text/css", "h1{font-family:system-ui}"),
  file("screens/shot.png", "image/png", PNG),
  file("screens/walk.gif", "image/gif", GIF),
];

before(async () => {
  owner = await createAccount(`projects-${randomBytes(5).toString("hex")}`, password);
  scratch = await mkdtemp(join(tmpdir(), "polka-project-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await app.close();
  await db.end();
  s3.destroy();
});

test("a project of documents, pages and pictures is saved as one work", async () => {
  const { finalized } = await upload(await token(), research(), "README.md");
  assert.equal(finalized!.statusCode, 200, finalized!.body);
  const receipt = finalized!.json();
  assert.match(receipt.shelfUrl, /\/works\/[0-9a-f-]{36}$/);
  const { rows: [revision] } = await db.query(
    "SELECT mime,html_profile,storage_kind,total_size,manifest->>'runtime' AS runtime FROM revisions WHERE id=$1",
    [receipt.revisionId],
  );
  assert.deepEqual(
    { ...revision, total_size: Number(revision.total_size) },
    {
      mime: "text/markdown",
      html_profile: null,
      storage_kind: "bundle",
      total_size: research().reduce((sum, f) => sum + f.bytes.length, 0),
      runtime: "project-v1",
    },
  );
  const files = await db.query("SELECT count(*)::int AS n FROM revision_files WHERE revision_id=$1", [receipt.revisionId]);
  assert.equal(files.rows[0].n, 6);
  // Every document and page is searchable, not only the entry.
  const { rows: [search] } = await db.query("SELECT body FROM artifact_search WHERE artifact_id=$1", [receipt.artifactId]);
  assert.match(search.body, /коммерческое предложение/);
  assert.match(search.body, /Сквозная цепочка экранов/);
});

test("a project may hold more than a bundle; a bundle keeps its limits", async () => {
  const many = Array.from({ length: 70 }, (_, i) =>
    file(`notes/n${String(i).padStart(2, "0")}.md`, "text/markdown", `# Заметка ${i}\n`),
  );
  const { finalized } = await upload(await token(), [file("README.md", "text/markdown", "# Много заметок\n"), ...many], "README.md");
  assert.equal(finalized!.statusCode, 200, finalized!.body);
  // The same shapes as a plain bundle are refused.
  assert.throws(() => bundleManifestSchema.parse(manifestOf([file("README.md", "text/markdown", "# x"), ...many], "README.md", "preserved-only-v1")));
  assert.throws(() => bundleManifestSchema.parse(manifestOf([file("index.html", "text/html", "<p>x"), file("a.md", "text/markdown", "x")], "index.html", "preserved-only-v1")));
  // A project's entry is a document or a page, not a stylesheet.
  const { begun } = await upload(await token(), [file("a.css", "text/css", "p{}"), file("b.md", "text/markdown", "x")], "a.css");
  assert.equal(begun.statusCode, 400, begun.body);
});

test("a project is refused over the token's scope and the shelf's space", async () => {
  const readOnly = await token(["context", "read"]);
  const { begun } = await upload(readOnly, research(), "README.md");
  assert.equal(begun.statusCode, 403, begun.body);
  await db.query("UPDATE tenants SET quota_bytes=100 WHERE id=$1", [owner.tenant]);
  try {
    const { begun: full } = await upload(await token(), research(), "README.md");
    assert.equal(full.statusCode, 413, full.body);
  } finally {
    await db.query("UPDATE tenants SET quota_bytes=DEFAULT WHERE id=$1", [owner.tenant]);
  }
});

test("a new version of a project needs its base", async () => {
  const secret = await token();
  const first = (await upload(secret, research(), "README.md")).finalized!.json();
  const next = [...research(), file("03-new/plan.md", "text/markdown", "# План внедрения\n")];
  const { finalized } = await upload(secret, next, "README.md", {
    artifactId: first.artifactId,
    baseRevisionId: first.revisionId,
  });
  assert.equal(finalized!.statusCode, 200, finalized!.body);
  assert.equal(finalized!.json().number, 2);
  const stale = await upload(secret, next, "README.md", {
    artifactId: first.artifactId,
    baseRevisionId: first.revisionId,
  });
  assert.equal((stale.finalized ?? stale.begun).statusCode, 409);
});

test("the CLI publishes a folder, skipping what a reader never opens", async () => {
  const root = join(scratch, "research");
  for (const f of research()) {
    await mkdir(join(root, f.path, ".."), { recursive: true });
    await writeFile(join(root, f.path), f.bytes);
  }
  await mkdir(join(root, "__pycache__"), { recursive: true });
  await writeFile(join(root, "__pycache__", "x.pyc"), "x");
  await writeFile(join(root, ".DS_Store"), "x");
  await writeFile(join(root, "build.py"), "print(1)");
  await writeFile(join(root, "Отчёт.md"), "# кириллица в имени");
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const secret = await token();
    const run = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [cliPath, root, "--json"], {
        env: { ...process.env, POLKA_TOKEN: secret, POLKA_ENDPOINT: endpoint },
      });
      let out = "", err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    });
    assert.equal(run.code, 0, run.err);
    const result = JSON.parse(run.out);
    assert.equal(result.title, "Исследование рынка");
    assert.equal(result.entry, "README.md");
    assert.equal(result.files, 6);
    assert.deepEqual(
      result.skipped.map((item: any) => item.path).sort(),
      ["build.py", "Отчёт.md"],
    );
    assert.match(result.shelfUrl, new RegExp(`^${config.APP_ORIGIN}/works/`));
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});
