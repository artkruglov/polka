// Operator-only: fills the editorial catalogue from the static snapshots in
// content/editorial/static-candidates.json. For each material, inside the
// explicitly named editorial account: save static/index.html as a single HTML
// revision, enable a 30-day share (the longest the share policy allows) and
// register it through the same publication path as editorial-publish.ts.
//
//   node --import tsx scripts/editorial-seed-hosted.ts --confirm-publication --login redakciya
//
// Re-running is safe: a slug already published from this tenant with the same
// source hash and still available is left alone; an expired or outdated one is
// replaced by a new share and publication. Shares cannot be extended, so a
// publication whose share expires within --renew-within-days (default 7) is
// renewed ahead of time: a fresh copy of the snapshot gets its own share and
// replaces the old publication in one transaction, without a gap. Run weekly.
// Output is slug/status only — never tokens, URLs or IDs.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  beginUpload,
  finalizeUpload,
  uploadBytes,
  type Actor,
} from "../apps/server/artifacts.ts";
import { db } from "../apps/server/db.ts";
import { getEditorial } from "../apps/server/editorial.ts";
import { classifyHtml } from "../apps/server/html.ts";
import { enableOwnerShare } from "../apps/server/shares.ts";
import { sha256 } from "../apps/server/storage.ts";
import { publishEditorialOperatorInput } from "./editorial-operator.ts";
import {
  buildStaticPublishInput,
  staticCandidatesSchema,
  type StaticCandidate,
} from "./editorial-static-lib.ts";

const SHARE_DAYS = 30;
const DAY = 86_400_000;
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const print = (value: object) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);

type Status =
  | "unchanged"
  | "published"
  | "replaced"
  | "renewed"
  | "blocked"
  | "failed";

async function resolveOwner(login: string): Promise<Actor> {
  // No service looks an account up by login; this is a read-only lookup.
  const { rows } = await db.query(
    `SELECT account.id,tenant.id AS tenant
     FROM accounts account JOIN tenants tenant ON tenant.owner_id=account.id
     WHERE account.name=$1 AND NOT account.disabled
       AND account.deletion_requested_at IS NULL`,
    [login],
  );
  if (rows.length !== 1)
    throw new Error("Editorial account not found, disabled or ambiguous");
  return { id: rows[0].id, tenant: rows[0].tenant };
}

async function activePublication(slug: string) {
  return (
    await db.query(
      `SELECT publication.id,publication.tenant_id,publication.source_sha256,
         share.expires_at
       FROM editorial_publications publication
       JOIN shares share ON share.id=publication.share_id
       WHERE publication.slug=$1 AND publication.withdrawn_at IS NULL`,
      [slug],
    )
  ).rows[0] as
    | {
        id: string;
        tenant_id: string;
        source_sha256: string;
        expires_at: Date;
      }
    | undefined;
}

const isAvailable = (slug: string) =>
  getEditorial(slug).then(
    () => true,
    () => false,
  );

/**
 * Reuses this tenant's current revision of the exact bytes, else uploads.
 * A renewal always uploads: the old artifact keeps its still-active share
 * until the publication swap revokes it.
 */
async function revisionFor(
  owner: Actor,
  candidate: StaticCandidate,
  bytes: Buffer,
  fresh: boolean,
) {
  const {
    rows: [existing],
  } = await db.query(
    `SELECT revision.id AS "revisionId",revision.artifact_id AS "artifactId",
       revision.sha256,revision.manifest_sha256 AS "manifestSha256",
       revision.html_profile AS "htmlProfile"
     FROM revisions revision
     JOIN artifacts artifact ON artifact.id=revision.artifact_id
      AND artifact.latest_revision_id=revision.id
     WHERE revision.tenant_id=$1 AND revision.sha256=$2
       AND revision.storage_kind='single' AND artifact.trashed_at IS NULL
     ORDER BY revision.created_at DESC LIMIT 1`,
    [owner.tenant, candidate.sourceSha256],
  );
  if (existing && !fresh) return existing;
  const { uploadId } = await beginUpload(owner, {
    key: randomUUID(),
    title: candidate.title,
    filename: `${candidate.slug}.html`,
    mime: "text/html",
    size: bytes.length,
    sha256: candidate.sourceSha256,
  });
  await uploadBytes(owner, uploadId, bytes);
  const receipt = await finalizeUpload(owner, uploadId);
  return {
    revisionId: receipt.revisionId,
    artifactId: receipt.artifactId,
    sha256: receipt.sha256,
    manifestSha256: receipt.manifestSha256 ?? null,
    htmlProfile: receipt.htmlProfile,
  };
}

async function seed(
  owner: Actor,
  candidate: StaticCandidate,
  renewWithinDays: number,
): Promise<Status> {
  const bytes = await readFile(resolve(candidate.sourcePath));
  if (sha256(bytes) !== candidate.sourceSha256)
    throw new Error("Snapshot hash mismatch");
  if (classifyHtml(bytes.toString("utf8")) !== "static")
    throw new Error("Snapshot is not static HTML");

  const active = await activePublication(candidate.slug);
  if (active && active.tenant_id !== owner.tenant) return "blocked";
  const renew =
    active?.source_sha256 === candidate.sourceSha256 &&
    (await isAvailable(candidate.slug));
  if (
    renew &&
    new Date(active.expires_at).getTime() > Date.now() + renewWithinDays * DAY
  )
    return "unchanged";

  const revision = await revisionFor(owner, candidate, bytes, renew);
  if (revision.sha256 !== candidate.sourceSha256 || revision.htmlProfile !== "static")
    throw new Error("Saved revision is not the static snapshot");
  const artifact = await enableOwnerShare(owner, revision.artifactId, {
    expectedRevisionId: revision.revisionId,
    expiresInDays: SHARE_DAYS,
  });
  const share = artifact.share;
  if (!share || share.status !== "active" || share.revisionId !== revision.revisionId)
    throw new Error("Catalogue share is not active on the snapshot revision");
  const input = buildStaticPublishInput({
    candidate,
    binding: {
      tenantId: owner.tenant,
      artifactId: revision.artifactId,
      revisionId: revision.revisionId,
      shareId: share.id,
      sourceSha256: revision.sha256,
      manifestSha256: revision.manifestSha256,
    },
    publicationId: randomUUID(),
    expectedPublicationId: active?.id ?? null,
    checkedAt: new Date().toISOString(),
  });
  const result = await publishEditorialOperatorInput(owner, input);
  if (result.state !== "available")
    throw new Error("Publication is not available after registration");
  return renew ? "renewed" : active ? "replaced" : "published";
}

if (!args.includes("--confirm-publication")) {
  process.stderr.write(
    "Refusing to publish: pass --confirm-publication and --login <editorial account>.\n",
  );
  process.exitCode = 1;
} else {
  let failures = 0;
  try {
    const login = option("--login");
    if (!login) throw new Error("--login is required");
    const only = option("--only")?.split(",");
    const renewWithinDays = Number(option("--renew-within-days") ?? 7);
    if (
      !Number.isInteger(renewWithinDays) ||
      renewWithinDays < 0 ||
      renewWithinDays >= SHARE_DAYS
    )
      throw new Error("--renew-within-days must be an integer from 0 to 29");
    const catalogue = staticCandidatesSchema.parse(
      JSON.parse(
        await readFile(
          resolve(option("--candidates") ?? "content/editorial/static-candidates.json"),
          "utf8",
        ),
      ),
    );
    const owner = await resolveOwner(login);
    // The catalogue lists newest first; publish in reverse so it reads in
    // the candidates' order.
    for (const candidate of [...catalogue.items].reverse()) {
      if (only && !only.includes(candidate.slug)) continue;
      let status: Status;
      try {
        status = await seed(owner, candidate, renewWithinDays);
      } catch (error) {
        status = "failed";
        process.stderr.write(
          `${JSON.stringify({ slug: candidate.slug, reason: error instanceof Error ? error.message : "rejected" })}\n`,
        );
      }
      if (status === "failed" || status === "blocked") failures++;
      print({ slug: candidate.slug, status });
    }
  } catch (error) {
    failures++;
    process.stderr.write(
      `${JSON.stringify({ event: "editorial.seed.failed", reason: error instanceof Error ? error.message : "rejected" })}\n`,
    );
  } finally {
    await db.end();
  }
  if (failures) process.exitCode = 1;
}
