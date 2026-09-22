import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import {
  editorialPublishSchema,
  getEditorial,
  withdrawEditorial,
} from "../apps/server/editorial.ts";
import { classifyHtml } from "../apps/server/html.ts";
import {
  STATIC_SNAPSHOT_NOTE,
  buildStaticPublishInput,
  interactiveCandidatesSchema,
  staticCandidatesSchema,
  staticSourcePath,
} from "../scripts/editorial-static-lib.ts";

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const staticCatalogue = staticCandidatesSchema.parse(
  JSON.parse(await readFile("content/editorial/static-candidates.json", "utf8")),
);
const interactive = interactiveCandidatesSchema.parse(
  JSON.parse(await readFile("content/editorial/candidates.json", "utf8")),
);
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.end();
});

test("every editorial original has a committed static snapshot", async () => {
  assert.deepEqual(
    staticCatalogue.items.map((item) => item.slug),
    interactive.items.map((item) => item.slug),
  );
  for (const item of staticCatalogue.items) {
    const original = interactive.items.find((x) => x.slug === item.slug)!;
    // The interactive entries stay intact for the future live viewer.
    assert.equal(item.interactiveSourcePath, original.sourcePath);
    assert.equal(item.interactiveSourceSha256, original.sourceSha256);
    assert.equal(
      sha256(await readFile(original.sourcePath)),
      original.sourceSha256,
    );
    assert.equal(item.title, original.title);
    assert.equal(item.sourcePath, staticSourcePath(item.slug));
    const html = await readFile(item.sourcePath, "utf8");
    assert.equal(sha256(html), item.sourceSha256, item.slug);
    assert.equal(classifyHtml(html), "static", item.slug);
    assert.doesNotMatch(html, /<script\b|\son[a-z]+\s*=|javascript:/i);
    assert.ok(html.includes(STATIC_SNAPSHOT_NOTE), item.slug);
  }
});

const binding = {
  tenantId: randomUUID(),
  artifactId: randomUUID(),
  revisionId: randomUUID(),
  shareId: randomUUID(),
  sourceSha256: staticCatalogue.items[0]!.sourceSha256,
  manifestSha256: "b".repeat(64),
};

test("static manifests pass the server publish schema without a derivative", () => {
  for (const candidate of staticCatalogue.items) {
    const input = buildStaticPublishInput({
      candidate,
      binding: { ...binding, sourceSha256: candidate.sourceSha256 },
      publicationId: randomUUID(),
      expectedPublicationId: null,
      checkedAt: new Date().toISOString(),
    });
    const parsed = editorialPublishSchema.parse(input);
    assert.equal(parsed.manifest.public.author, "Редакция Полки");
    assert.equal(parsed.manifest.public.license, "Apache-2.0");
    assert.equal(parsed.manifest.source.path, candidate.sourcePath);
    assert.match(parsed.manifest.source.path, /\/index\.html$/);
    assert.equal(parsed.manifest.runtimeProof.derivative, null);
    assert.equal(parsed.manifest.binding.derivativeId, null);
    assert.equal(parsed.manifest.binding.manifestSha256, binding.manifestSha256);
    assert.equal(JSON.stringify(parsed).includes("recipientUrl"), false);
  }
  assert.throws(() =>
    buildStaticPublishInput({
      candidate: staticCatalogue.items[0]!,
      binding: { ...binding, sourceSha256: "c".repeat(64) },
      publicationId: randomUUID(),
      expectedPublicationId: null,
      checkedAt: new Date().toISOString(),
    }),
  );
});

function seed(...args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/editorial-seed-hosted.ts", ...args],
        { env: process.env },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    },
  );
}

test("seed publishes a static snapshot once, idempotently, printing no links, renewing before expiry", async () => {
  const suffix = randomBytes(5).toString("hex");
  const login = `redakciya-${suffix}`;
  const owner = await createAccount(login, randomBytes(24).toString("hex"));
  cleanup.push(() =>
    db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]),
  );
  // A unique slug keeps the shared test database free of real catalogue slugs.
  const slug = `static-seed-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "polka-static-seed-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const candidates = join(directory, "candidates.json");
  await writeFile(
    candidates,
    JSON.stringify({
      ...staticCatalogue,
      items: [{ ...staticCatalogue.items[0]!, slug }],
    }),
  );

  const refused = await seed("--login", login, "--candidates", candidates);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(
    (
      await db.query("SELECT 1 FROM editorial_publications WHERE slug=$1", [
        slug,
      ])
    ).rowCount,
    0,
  );

  const args = ["--confirm-publication", "--login", login, "--candidates", candidates];
  const first = await seed(...args);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { slug, status: "published" });
  assert.doesNotMatch(first.stdout + first.stderr, /https?:|\/s#|[0-9a-f]{8}-[0-9a-f]{4}-/);

  const {
    rows: [publication],
  } = await db.query(
    `SELECT publication.id,publication.tenant_id,publication.derivative_id,
       publication.source_sha256,revision.html_profile,revision.storage_kind,
       share.expires_at
     FROM editorial_publications publication
     JOIN revisions revision ON revision.id=publication.revision_id
     JOIN shares share ON share.id=publication.share_id
     WHERE publication.slug=$1 AND publication.withdrawn_at IS NULL`,
    [slug],
  );
  cleanup.push(() =>
    withdrawEditorial(
      { id: owner.id, tenant: owner.tenant },
      { publicationId: publication.id },
    ),
  );
  assert.equal(publication.tenant_id, owner.tenant);
  assert.equal(publication.derivative_id, null);
  assert.equal(publication.source_sha256, staticCatalogue.items[0]!.sourceSha256);
  assert.equal(publication.html_profile, "static");
  assert.equal(publication.storage_kind, "single");
  assert.ok(
    new Date(publication.expires_at).getTime() > Date.now() + 29 * 86_400_000,
  );
  const item = await getEditorial(slug);
  assert.equal(item.title, staticCatalogue.items[0]!.title);
  assert.equal(item.author, "Редакция Полки");

  const again = await seed(...args);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), { slug, status: "unchanged" });
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM editorial_publications WHERE slug=$1",
        [slug],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT count(*)::int AS n FROM artifacts WHERE tenant_id=$1", [
        owner.tenant,
      ])
    ).rows[0].n,
    1,
  );

  // A share close to expiry is renewed without a gap: fresh copy, new share,
  // old publication withdrawn and its share revoked in the same swap.
  await db.query(
    "UPDATE shares SET expires_at=now()+interval '2 days' WHERE id=(SELECT share_id FROM editorial_publications WHERE id=$1)",
    [publication.id],
  );
  const renewed = await seed(...args);
  assert.equal(renewed.code, 0, renewed.stderr);
  assert.deepEqual(JSON.parse(renewed.stdout), { slug, status: "renewed" });
  const { rows } = await db.query(
    `SELECT publication.id,publication.withdrawn_at IS NULL AS active,share.revoked
     FROM editorial_publications publication
     JOIN shares share ON share.id=publication.share_id
     WHERE publication.slug=$1`,
    [slug],
  );
  assert.equal(rows.length, 2);
  const old = rows.find((row) => row.id === publication.id)!;
  const current = rows.find((row) => row.id !== publication.id)!;
  assert.deepEqual([old.active, old.revoked], [false, true]);
  assert.deepEqual([current.active, current.revoked], [true, false]);
  cleanup.push(() =>
    withdrawEditorial(
      { id: owner.id, tenant: owner.tenant },
      { publicationId: current.id },
    ),
  );
  assert.equal((await getEditorial(slug)).slug, slug);
});
