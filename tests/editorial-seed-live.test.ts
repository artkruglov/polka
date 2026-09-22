import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { SERVED_BUILDER_VERSIONS } from "../apps/server/bundle-runtime-contract.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { getEditorial, withdrawEditorial } from "../apps/server/editorial.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import {
  INTERACTIVE_NOTICES,
  staticCandidatesSchema,
} from "../scripts/editorial-static-lib.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run editorial-seed-live.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const catalogue = staticCandidatesSchema.parse(
  JSON.parse(await readFile("content/editorial/static-candidates.json", "utf8")),
);
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const step of cleanup.reverse()) await step();
  await app.close();
  await viewer.close();
  await db.end();
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

const active = async (slug: string) =>
  (
    await db.query(
      `SELECT publication.id,publication.derivative_id,publication.builder_version,
         publication.source_sha256,publication.share_id,publication.metadata,
         revision.storage_kind,share.expires_at
       FROM editorial_publications publication
       JOIN revisions revision ON revision.id=publication.revision_id
       JOIN shares share ON share.id=publication.share_id
       WHERE publication.slug=$1 AND publication.withdrawn_at IS NULL`,
      [slug],
    )
  ).rows[0];

test("live seed replaces the static snapshot with the ready interactive original, renews it and falls back per slug", async () => {
  const suffix = randomBytes(5).toString("hex");
  const login = `redakciya-live-${suffix}`;
  const owner = await createAccount(login, randomBytes(24).toString("hex"));
  const actor = { id: owner.id, tenant: owner.tenant };
  cleanup.push(async () => {
    const current = await active(slug);
    if (current)
      await withdrawEditorial(actor, { publicationId: current.id });
    await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  });
  const slug = `live-seed-${suffix}`;
  const candidate = catalogue.items.find((item) => item.slug === "fractions")!;
  const directory = await mkdtemp(join(tmpdir(), "polka-live-seed-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const candidates = join(directory, "candidates.json");
  await writeFile(
    candidates,
    JSON.stringify({ ...catalogue, items: [{ ...candidate, slug }] }),
  );
  const args = ["--confirm-publication", "--login", login, "--candidates", candidates];
  const run = async (expected: object, ...extra: string[]) => {
    const result = await seed(...args, ...extra);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { slug, ...expected });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /https?:|\/s#|[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
    return result;
  };

  // Hosted today: the static snapshot is what the catalogue shows.
  await run({ status: "published", version: "static" }, "--static-only");
  const snapshot = await active(slug);
  assert.equal(snapshot.derivative_id, null);

  // With the viewer on, the original replaces it in one swap.
  await run({ status: "replaced", version: "interactive" });
  const live = await active(slug);
  assert.equal(live.storage_kind, "bundle");
  assert.equal(live.source_sha256, candidate.interactiveSourceSha256);
  assert.ok(live.derivative_id);
  assert.ok(
    (SERVED_BUILDER_VERSIONS as readonly string[]).includes(live.builder_version),
  );
  assert.equal(live.metadata.notices, INTERACTIVE_NOTICES);
  assert.ok(
    new Date(live.expires_at).getTime() > Date.now() + 29 * 86_400_000,
  );
  const old = (
    await db.query(
      `SELECT publication.withdrawn_at IS NOT NULL AS withdrawn,share.revoked
       FROM editorial_publications publication
       JOIN shares share ON share.id=publication.share_id
       WHERE publication.id=$1`,
      [snapshot.id],
    )
  ).rows[0];
  assert.deepEqual([old.withdrawn, old.revoked], [true, true]);

  // A recipient of the catalogue link gets the interactive version.
  const item = await getEditorial(slug);
  const token = item.recipientUrl.split("#")[1];
  const resolved = await app.inject({
    method: "POST",
    url: "/api/resolve",
    headers: { origin: config.APP_ORIGIN },
    payload: { token },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().revision.storageKind, "bundle");
  assert.equal(resolved.json().revision.inlineBuild.state, "ready");
  const launched = await app.inject({
    method: "POST",
    url: "/api/view/live-view",
    headers: {
      origin: config.APP_ORIGIN,
      authorization: `Bearer ${resolved.json().grant}`,
    },
    payload: {},
  });
  assert.equal(launched.statusCode, 200, launched.body);
  const document = await viewer.inject({
    method: "GET",
    url: new URL(launched.json().url).pathname,
    headers: {
      host: config.VIEWER_UPSTREAM_HOST,
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
    },
  });
  assert.equal(document.statusCode, 200);
  assert.match(document.body, /<script/);

  await run({ status: "unchanged", version: "interactive" });

  await db.query(
    "UPDATE shares SET expires_at=now()+interval '2 days' WHERE id=$1",
    [live.share_id],
  );
  await run({ status: "renewed", version: "interactive" });
  const renewed = await active(slug);
  assert.notEqual(renewed.id, live.id);
  assert.ok(renewed.derivative_id);
  assert.notEqual(renewed.derivative_id, live.derivative_id);

  // A refused build (here: no derivative quota for the fresh copy) keeps the
  // slug in the catalogue through its static snapshot.
  await db.query(
    "UPDATE shares SET expires_at=now()+interval '2 days' WHERE id=$1",
    [renewed.share_id],
  );
  await db.query(
    "UPDATE tenants SET derivative_quota_bytes=0 WHERE id=$1",
    [owner.tenant],
  );
  const fallback = await run({ status: "replaced", version: "static" });
  assert.match(fallback.stderr, /"fallback":"static"/);
  const restored = await active(slug);
  assert.equal(restored.derivative_id, null);
  assert.equal(restored.source_sha256, candidate.sourceSha256);
  assert.equal((await getEditorial(slug)).slug, slug);
});
