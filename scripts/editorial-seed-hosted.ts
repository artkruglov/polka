// Operator-only: fills the editorial catalogue from
// content/editorial/static-candidates.json, inside the explicitly named
// editorial account, through the same publication path as
// editorial-publish.ts. Each publication gets a 30-day share (the longest the
// share policy allows).
//
//   node --import tsx scripts/editorial-seed-hosted.ts --confirm-publication --login redakciya
//
// With the interactive viewer on (HTML_LIVE_MODE local/staging/production),
// every material is published as its original content/editorial/<slug>/index.html:
// saved as a one-file bundle, built by the live builder, and shared and
// registered bound to that ready derivative. A static publication of the slug
// is replaced in the same transaction, without a gap. If the build is refused
// the slug keeps (or gets) its static snapshot and the reason goes to stderr.
// With the viewer off (or --static-only) static/index.html is published as a
// single HTML revision, replacing an interactive publication the viewer can no
// longer open.
//
// Re-running is safe: a slug already published from this tenant with the same
// version and still available is left alone. Shares cannot be extended, so a
// publication whose share expires within --renew-within-days (default 7) is
// renewed ahead of time: a fresh copy gets its own share and replaces the old
// publication in one transaction, without a gap. Run weekly.
// Output is slug/status/version only — never tokens, URLs or IDs.
//
// Taking materials out of the catalogue (remove them from candidates.json
// first, or the next weekly run publishes them again):
//
//   node --import tsx scripts/editorial-seed-hosted.ts --confirm-publication --login redakciya --withdraw slug-a,slug-b
//
// withdraws this tenant's active publication of each slug and revokes its
// share in one transaction, publishing nothing. Prints {"slug","status"}:
// "withdrawn", "absent" (nothing active) or "blocked" (another tenant's).
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  beginBundleUpload,
  beginUpload,
  finalizeBundleUpload,
  finalizeUpload,
  uploadBundleFile,
  uploadBytes,
  type Actor,
} from "../apps/server/artifacts.ts";
import {
  buildInlineRevision,
  getInlineBuildStatus,
} from "../apps/server/bundle-derivatives.ts";
import {
  BUNDLE_RUNTIME_PROFILE,
  isServedBuilderVersion,
} from "../apps/server/bundle-runtime-contract.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { getEditorial, withdrawEditorial } from "../apps/server/editorial.ts";
import { classifyHtml } from "../apps/server/html.ts";
import { enableOwnerShare } from "../apps/server/shares.ts";
import { sha256 } from "../apps/server/storage.ts";
import { publishEditorialOperatorInput } from "./editorial-operator.ts";
import {
  buildInteractivePublishInput,
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
type Version = "interactive" | "static";

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
         publication.derivative_id,share.expires_at
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
        derivative_id: string | null;
        expires_at: Date;
      }
    | undefined;
}

const isAvailable = (slug: string) =>
  getEditorial(slug).then(
    () => true,
    () => false,
  );

type SavedRevision = {
  revisionId: string;
  artifactId: string;
  sha256: string;
  manifestSha256: string | null;
  htmlProfile: string;
};

/**
 * Reuses this tenant's current revision of the exact bytes and storage kind,
 * else uploads. A renewal always uploads: the old artifact keeps its
 * still-active share until the publication swap revokes it.
 */
async function reusableRevision(
  owner: Actor,
  sourceSha256: string,
  storageKind: "single" | "bundle",
): Promise<SavedRevision | undefined> {
  return (
    await db.query(
      `SELECT revision.id AS "revisionId",revision.artifact_id AS "artifactId",
         revision.sha256,revision.manifest_sha256 AS "manifestSha256",
         revision.html_profile AS "htmlProfile"
       FROM revisions revision
       JOIN artifacts artifact ON artifact.id=revision.artifact_id
        AND artifact.latest_revision_id=revision.id
       WHERE revision.tenant_id=$1 AND revision.sha256=$2
         AND revision.storage_kind=$3 AND artifact.trashed_at IS NULL
       ORDER BY revision.created_at DESC LIMIT 1`,
      [owner.tenant, sourceSha256, storageKind],
    )
  ).rows[0];
}

async function staticRevision(
  owner: Actor,
  candidate: StaticCandidate,
  bytes: Buffer,
  fresh: boolean,
): Promise<SavedRevision> {
  const existing = await reusableRevision(owner, candidate.sourceSha256, "single");
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

/** The original index.html saved as a one-file bundle the builder accepts. */
async function interactiveRevision(
  owner: Actor,
  candidate: StaticCandidate,
  bytes: Buffer,
  fresh: boolean,
): Promise<SavedRevision> {
  const existing = await reusableRevision(
    owner,
    candidate.interactiveSourceSha256,
    "bundle",
  );
  if (existing && !fresh) return existing;
  const { uploadId } = await beginBundleUpload(owner, {
    key: randomUUID(),
    title: candidate.title,
    manifest: {
      version: 1,
      entrypoint: "index.html",
      runtime: "inline-live-experimental-v1",
      files: [
        {
          path: "index.html",
          mime: "text/html",
          size: bytes.length,
          sha256: candidate.interactiveSourceSha256,
        },
      ],
      provenance: {
        kind: "file",
        sourceUrl: null,
        capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        attribution: candidate.author,
        license: candidate.license,
      },
      dependencies: { status: "self-contained", unresolved: [] },
    },
  });
  await uploadBundleFile(owner, uploadId, 0, bytes);
  const receipt = await finalizeBundleUpload(owner, uploadId);
  return {
    revisionId: receipt.revisionId,
    artifactId: receipt.artifactId,
    sha256: receipt.sha256,
    manifestSha256: receipt.manifestSha256,
    htmlProfile: receipt.htmlProfile,
  };
}

/** Builds (or reuses) the ready derivative; a refusal names its reason. */
async function readyDerivative(owner: Actor, revisionId: string) {
  let { status } = await buildInlineRevision(owner, revisionId);
  // Another process may hold the build; it finishes within the build deadline.
  for (let attempt = 0; status.state === "pending" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = (await getInlineBuildStatus(owner, revisionId)) ?? status;
  }
  if (status.state !== "ready")
    throw new Error(
      `Interactive build ${status.state}: ${status.reason ?? "no reason"}${status.path ? ` (${status.path})` : ""}`,
    );
}

async function shareDerivative(shareId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT derivative.id,derivative.sha256,
       derivative.builder_version AS "builderVersion",
       derivative.runtime_profile AS "runtimeProfile"
     FROM shares share
     JOIN revision_derivatives derivative
       ON derivative.id=share.derivative_id
      AND derivative.revision_id=share.revision_id
     WHERE share.id=$1 AND derivative.state='ready'`,
    [shareId],
  );
  if (
    !row ||
    !isServedBuilderVersion(row.builderVersion) ||
    row.runtimeProfile !== BUNDLE_RUNTIME_PROFILE
  )
    throw new Error("Catalogue share is not bound to a ready derivative");
  return row as {
    id: string;
    sha256: string;
    builderVersion: string;
    runtimeProfile: string;
  };
}

async function seed(
  owner: Actor,
  candidate: StaticCandidate,
  renewWithinDays: number,
  version: Version,
): Promise<Status> {
  const interactive = version === "interactive";
  const sourcePath = interactive
    ? candidate.interactiveSourcePath
    : candidate.sourcePath;
  const sourceSha256 = interactive
    ? candidate.interactiveSourceSha256
    : candidate.sourceSha256;
  const bytes = await readFile(resolve(sourcePath));
  if (sha256(bytes) !== sourceSha256) throw new Error("Source hash mismatch");
  if (!interactive && classifyHtml(bytes.toString("utf8")) !== "static")
    throw new Error("Snapshot is not static HTML");

  const active = await activePublication(candidate.slug);
  if (active && active.tenant_id !== owner.tenant) return "blocked";
  const renew =
    active?.source_sha256 === sourceSha256 &&
    (active.derivative_id !== null) === interactive &&
    (await isAvailable(candidate.slug));
  if (
    renew &&
    new Date(active.expires_at).getTime() > Date.now() + renewWithinDays * DAY
  )
    return "unchanged";

  const revision = interactive
    ? await interactiveRevision(owner, candidate, bytes, renew)
    : await staticRevision(owner, candidate, bytes, renew);
  if (revision.sha256 !== sourceSha256)
    throw new Error("Saved revision is not the editorial source");
  if (!interactive && revision.htmlProfile !== "static")
    throw new Error("Saved revision is not the static snapshot");
  if (interactive) await readyDerivative(owner, revision.revisionId);
  const artifact = await enableOwnerShare(owner, revision.artifactId, {
    expectedRevisionId: revision.revisionId,
    expiresInDays: SHARE_DAYS,
  });
  const share = artifact.share;
  if (!share || share.status !== "active" || share.revisionId !== revision.revisionId)
    throw new Error("Catalogue share is not active on the saved revision");
  const binding = {
    tenantId: owner.tenant,
    artifactId: revision.artifactId,
    revisionId: revision.revisionId,
    shareId: share.id,
    sourceSha256: revision.sha256,
    manifestSha256: revision.manifestSha256,
  };
  const common = {
    candidate,
    publicationId: randomUUID(),
    expectedPublicationId: active?.id ?? null,
    checkedAt: new Date().toISOString(),
  };
  const input = interactive
    ? buildInteractivePublishInput({
        ...common,
        binding: {
          ...binding,
          manifestSha256: revision.manifestSha256!,
          derivative: await shareDerivative(share.id),
        },
      })
    : buildStaticPublishInput({ ...common, binding });
  const result = await publishEditorialOperatorInput(owner, input);
  if (result.state !== "available")
    throw new Error("Publication is not available after registration");
  return renew ? "renewed" : active ? "replaced" : "published";
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : "rejected";

/** Withdraws this tenant's active publication of each slug; returns failures. */
async function withdrawSlugs(owner: Actor, slugs: string[]) {
  let failures = 0;
  for (const slug of slugs) {
    const active = await activePublication(slug);
    let status: "withdrawn" | "absent" | "blocked" | "failed";
    if (!active) status = "absent";
    else if (active.tenant_id !== owner.tenant) status = "blocked";
    else {
      try {
        const result = await withdrawEditorial(owner, { publicationId: active.id });
        status = result.state === "withdrawn" ? "withdrawn" : "failed";
      } catch (error) {
        status = "failed";
        process.stderr.write(`${JSON.stringify({ slug, reason: reason(error) })}\n`);
      }
    }
    if (status === "blocked" || status === "failed") failures++;
    print({ slug, status });
  }
  return failures;
}

if (!args.includes("--confirm-publication")) {
  process.stderr.write(
    "Refusing to publish: pass --confirm-publication and --login <editorial account>.\n",
  );
  process.exitCode = 1;
} else {
  let failures = 0;
  let fallbacks = 0;
  try {
    const login = option("--login");
    if (!login) throw new Error("--login is required");
    const withdraw = option("--withdraw");
    if (withdraw !== undefined) {
      const slugs = withdraw.split(",");
      if (!slugs.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)))
        throw new Error("--withdraw takes comma-separated slugs");
      failures += await withdrawSlugs(await resolveOwner(login), slugs);
    } else {
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
      const preferred: Version =
        config.HTML_LIVE_ENABLED && !args.includes("--static-only")
          ? "interactive"
          : "static";
      // The catalogue lists newest first; publish in reverse so it reads in
      // the candidates' order.
      for (const candidate of [...catalogue.items].reverse()) {
        if (only && !only.includes(candidate.slug)) continue;
        let status: Status;
        let version = preferred;
        try {
          try {
            status = await seed(owner, candidate, renewWithinDays, version);
          } catch (error) {
            if (version !== "interactive") throw error;
            // The static snapshot stays (or becomes) the published version.
            process.stderr.write(
              `${JSON.stringify({ slug: candidate.slug, fallback: "static", reason: reason(error) })}\n`,
            );
            version = "static";
            status = await seed(owner, candidate, renewWithinDays, version);
          }
        } catch (error) {
          status = "failed";
          process.stderr.write(
            `${JSON.stringify({ slug: candidate.slug, reason: reason(error) })}\n`,
          );
        }
        if (status === "failed" || status === "blocked") failures++;
        else if (version !== preferred) fallbacks++;
        print({ slug: candidate.slug, status, version });
      }
      if (fallbacks)
        process.stderr.write(
          `${JSON.stringify({ event: "editorial.seed.static-fallback", count: fallbacks })}\n`,
        );
    }
  } catch (error) {
    failures++;
    process.stderr.write(
      `${JSON.stringify({ event: "editorial.seed.failed", reason: reason(error) })}\n`,
    );
  } finally {
    await db.end();
  }
  if (failures) process.exitCode = 1;
}
