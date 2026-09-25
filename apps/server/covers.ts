import { createHash } from "node:crypto";
import { LINK_MIME } from "../../packages/contracts/constants.ts";
import type { RevisionCover } from "../../packages/contracts/cover.ts";
import type { SnapshotResult } from "../../packages/renderer-contract.ts";
import { config } from "./config.ts";
import {
  COVER_READ_BYTES,
  COVER_VERSION,
  coverFactsFromHtml,
  coverFactsFromText,
  type CoverFacts,
} from "./cover-facts.ts";
import { snapshotClient, type SnapshotCall } from "./cover-snapshot-client.ts";
import { db } from "./db.ts";
import { missing } from "./errors.ts";
import { readBlob } from "./storage.ts";
import {
  SERVED_BUILDER_VERSIONS_SQL,
  SERVED_RUNTIME_PROFILES_SQL,
  derivativePreferenceSql,
} from "./bundle-runtime-contract.ts";
import { isStaticSingleFileBundle } from "./revision-manifest.ts";

/*
 * Shelf covers (docs/specs/SHELF_COVERS.md). A card asks once per version
 * (GET /api/revisions/:id/cover); the version is read, the decision and the
 * cover text are stored in revision_covers and come with the shelf list from
 * then on. A visual work also gets a picture of its first screen, drawn by
 * the isolated renderer one page at a time (COVER_SNAPSHOTS_ENABLED).
 * Nothing here runs on the save path: saving stays as fast as before.
 */

export const snapshotsEnabled = () =>
  config.COVER_SNAPSHOTS_ENABLED && !!config.RENDERER_URL && !!config.RENDERER_SECRET;

/** A version moderation isolated or whose content it deleted shows no cover, to its owner too. */
const hiddenSql = (r: string) =>
  `(${r}.content_purged_at IS NOT NULL OR EXISTS(
     SELECT 1 FROM moderation_blocks block
     WHERE block.revision_id=${r}.id AND block.isolated AND block.released_at IS NULL))`;

/** The stored cover of revision alias `r`, for the shelf list (never the picture itself). */
export const coverSelectSql = (r: string) => `(
  SELECT jsonb_build_object('version',c.version,'kind',c.kind,'genre',c.genre,'facts',c.facts,
    'imageState',c.image_state,'imageSha',c.image_sha256)
  FROM revision_covers c WHERE c.revision_id=${r}.id AND NOT ${hiddenSql(r)}
) AS cover`;

const isImageMime = (mime: string) => mime.startsWith("image/");

/** The card's view of a stored cover; null asks the card to request it (none yet, or an older reader's). */
export function coverDTO(r: {
  mime: string;
  sha256: string;
  cover?: any;
}): RevisionCover | null {
  const c = r.cover;
  if (!c || Number(c.version) < COVER_VERSION) return null;
  const image = isImageMime(r.mime);
  const ready = c.imageState === "ready";
  return {
    kind: c.kind,
    genre: c.genre,
    heading: c.facts?.heading ?? null,
    lead: c.facts?.lead ?? null,
    accent: c.facts?.accent ?? null,
    // An image is its own picture until the renderer draws a smaller one.
    image:
      ready || image
        ? "ready"
        : (c.imageState === "wanted" || c.imageState === "pending") && snapshotsEnabled()
          ? "pending"
          : "none",
    imageKey: ready ? String(c.imageSha).slice(0, 16) : image ? `o${r.sha256.slice(0, 15)}` : null,
  };
}

/** The HTML a version shows first: its own file, or the entrypoint of its package. */
async function readEntry(r: any, limit = COVER_READ_BYTES): Promise<string | null> {
  if (r.storage_kind !== "bundle")
    return (await readBlob(r.object_key, r.object_version)).subarray(0, limit).toString("utf8");
  const entry = r.manifest?.entrypoint;
  const {
    rows: [file],
  } = await db.query(
    "SELECT object_key,object_version FROM revision_files WHERE revision_id=$1 AND path=$2",
    [r.id, entry],
  );
  if (!file) return null;
  return (await readBlob(file.object_key, file.object_version)).subarray(0, limit).toString("utf8");
}

const EMPTY_SIGNALS = {
  text: 0,
  headings: 0,
  paragraphs: 0,
  tables: 0,
  canvas: 0,
  svg: 0,
  images: 0,
  video: 0,
  controls: 0,
  charts: false,
  scripted: false,
  shell: false,
};

/**
 * coverFactsFromHtml off the request thread for a large page, with a
 * deadline (parse5 is quadratic on deep nesting, html.ts). A page that cannot
 * be read in time gets a picture instead of text.
 */
export async function coverFactsBounded(source: string, deadlineMs = 3_000): Promise<CoverFacts> {
  const unread: CoverFacts = {
    kind: "visual",
    genre: "page",
    heading: null,
    lead: null,
    accent: null,
    signals: EMPTY_SIGNALS,
  };
  if (source.length <= 16 * 1024) {
    try {
      return coverFactsFromHtml(source);
    } catch {
      return unread;
    }
  }
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL("./cover-facts-worker.mjs", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  try {
    return await new Promise<CoverFacts>((resolve) => {
      const timer = setTimeout(() => resolve(unread), deadlineMs);
      worker.once("message", (facts: CoverFacts | null) => {
        clearTimeout(timer);
        resolve(facts ?? unread);
      });
      worker.once("error", () => {
        clearTimeout(timer);
        resolve(unread);
      });
      worker.postMessage({ source });
    });
  } finally {
    await worker.terminate();
  }
}

/** Reads a version and decides its cover. */
export async function computeCoverFacts(r: any): Promise<CoverFacts> {
  if (isImageMime(r.mime))
    return { kind: "visual", genre: "image", heading: null, lead: null, accent: null, signals: EMPTY_SIGNALS };
  if (r.mime === "text/plain") {
    const text = (await readBlob(r.object_key, r.object_version)).subarray(0, 64 * 1024).toString("utf8");
    return coverFactsFromText(text, r.filename);
  }
  if (r.mime === "text/html") {
    const html = await readEntry(r);
    if (html !== null) return coverFactsBounded(html);
  }
  return { kind: "text", genre: "document", heading: null, lead: null, accent: null, signals: EMPTY_SIGNALS };
}

async function readyDerivative(r: any) {
  if (r.mime !== "text/html" || !r.manifest_sha256) return null;
  const {
    rows: [d],
  } = await db.query(
    `SELECT d.object_key,d.object_version FROM revision_derivatives d
     WHERE d.revision_id=$1 AND d.source_manifest_sha256=$2 AND d.state='ready'
       AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
       AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL}
     ORDER BY ${derivativePreferenceSql("d")} LIMIT 1`,
    [r.id, r.manifest_sha256],
  );
  return d ?? null;
}

/**
 * Makes sure revision `r` (a revisions row with `cover` and `hidden` from
 * coverSelectSql/hiddenSql) has a cover of this reader's version; returns the
 * stored row as coverSelectSql shapes it.
 */
export async function refreshCover(r: any, { schedule = true } = {}): Promise<any> {
  let cover = r.cover;
  if (!cover || Number(cover.version) < COVER_VERSION) {
    const facts = await computeCoverFacts(r);
    const wanted =
      facts.kind === "visual" && (isImageMime(r.mime) || r.mime === "text/html");
    const { signals, kind, genre, ...shown } = facts;
    const {
      rows: [row],
    } = await db.query(
      `INSERT INTO revision_covers(revision_id,version,kind,genre,facts,image_state)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (revision_id) DO UPDATE SET version=EXCLUDED.version,kind=EXCLUDED.kind,
         genre=EXCLUDED.genre,facts=EXCLUDED.facts,image_state=EXCLUDED.image_state,image=NULL,
         image_sha256=NULL,image_source=NULL,attempts=0,attempt_expires_at=NULL,reason=NULL,
         updated_at=now()
       WHERE revision_covers.version<EXCLUDED.version
       RETURNING version,kind,genre,facts,image_state AS "imageState",image_sha256 AS "imageSha"`,
      [r.id, COVER_VERSION, kind, genre, { ...shown, signals }, wanted ? "wanted" : "none"],
    );
    cover = row ?? (await storedCover(r.id));
  } else if (cover.imageState === "failed" && r.mime === "text/html") {
    // A page that drew nothing without its built version gets another try once that is ready.
    const {
      rows: [row],
    } = await db.query("SELECT image_source FROM revision_covers WHERE revision_id=$1", [r.id]);
    if (row?.image_source !== "derivative" && (await readyDerivative(r))) {
      await db.query(
        `UPDATE revision_covers SET image_state='wanted',attempts=0,reason=NULL,updated_at=now()
         WHERE revision_id=$1 AND image_state='failed'`,
        [r.id],
      );
      cover = { ...cover, imageState: "wanted" };
    }
  }
  if (schedule && cover && (cover.imageState === "wanted" || cover.imageState === "pending"))
    scheduleSnapshot(r.id);
  return cover;
}

async function storedCover(revisionId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT version,kind,genre,facts,image_state AS "imageState",image_sha256 AS "imageSha"
     FROM revision_covers WHERE revision_id=$1`,
    [revisionId],
  );
  return row ?? null;
}

/** GET /api/revisions/:id/cover: the owner's card asks once per version. */
export async function coverFor(
  actor: { tenant: string },
  revisionId: string,
): Promise<RevisionCover | null> {
  const {
    rows: [r],
  } = await db.query(
    `SELECT r.*,${coverSelectSql("r")},${hiddenSql("r")} AS hidden
     FROM revisions r WHERE r.id=$1 AND r.tenant_id=$2`,
    [revisionId, actor.tenant],
  );
  if (!r || r.hidden) throw missing();
  if (r.mime === LINK_MIME) return null;
  const cover = await refreshCover(r);
  return coverDTO({ ...r, cover });
}

/** GET /api/revisions/:id/cover.jpg: the drawn picture, or an image work's own bytes. */
export async function coverImage(actor: { tenant: string }, revisionId: string) {
  const {
    rows: [r],
  } = await db.query(
    `SELECT r.mime,r.object_key,r.object_version,c.image,c.image_state,${hiddenSql("r")} AS hidden
     FROM revisions r LEFT JOIN revision_covers c ON c.revision_id=r.id
     WHERE r.id=$1 AND r.tenant_id=$2`,
    [revisionId, actor.tenant],
  );
  if (!r || r.hidden) throw missing();
  if (r.image_state === "ready" && r.image) return { type: "image/jpeg", bytes: r.image as Buffer };
  if (isImageMime(r.mime))
    return { type: r.mime as string, bytes: await readBlob(r.object_key, r.object_version) };
  throw missing();
}

// The renderer draws one page at a time; the app keeps one request in flight.
const waiting = new Set<string>();
let running = false;
const MAX_WAITING = 500;

export function scheduleSnapshot(revisionId: string) {
  if (!snapshotsEnabled() || waiting.size >= MAX_WAITING) return;
  waiting.add(revisionId);
  void pump();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (waiting.size) {
      const [next] = waiting;
      waiting.delete(next!);
      try {
        await drawCover(next!);
      } catch {
        console.error(JSON.stringify({ event: "cover.snapshot_failed" }));
      }
    }
  } finally {
    running = false;
  }
}

const MAX_ATTEMPTS = 3;
const IMAGE_PAGE_MAX = 6 * 1024 * 1024;

/** The page the renderer draws for this version, or why there is none. */
async function snapshotPage(r: any): Promise<
  { html: string; script: boolean; source: "source" | "derivative" } | { reason: string }
> {
  if (isImageMime(r.mime)) {
    const bytes = await readBlob(r.object_key, r.object_version);
    if (bytes.length > IMAGE_PAGE_MAX) return { reason: "too_large" };
    return {
      html: `<!doctype html><html><body style="margin:0;background:#f5f5f7"><img alt="" src="data:${r.mime};base64,${bytes.toString("base64")}" style="display:block;width:100vw;height:100vh;object-fit:cover"></body></html>`,
      script: false,
      source: "source",
    };
  }
  if (r.mime !== "text/html") return { reason: "not_visual" };
  // What a recipient would run: the built version when there is one.
  const derivative = await readyDerivative(r);
  if (derivative)
    return {
      html: (await readBlob(derivative.object_key, derivative.object_version)).toString("utf8"),
      script: true,
      source: "derivative",
    };
  if (r.storage_kind === "single" || isStaticSingleFileBundle(r)) {
    const html = await readEntry(r, 8 * 1024 * 1024);
    if (html !== null)
      return { html, script: r.html_profile !== "static", source: "source" };
  }
  return { reason: "no_source" };
}

/**
 * One renderer attempt for one version. Idempotent across app instances: the
 * row is claimed (pending, with an expiry) before the page leaves the app.
 * Returns what happened, for the backfill's report.
 */
export async function drawCover(
  revisionId: string,
  call: SnapshotCall = snapshotClient(),
): Promise<"ready" | "blank" | "failed" | "retry" | "skipped"> {
  const {
    rows: [claimed],
  } = await db.query(
    `UPDATE revision_covers SET image_state='pending',attempt_expires_at=now()+interval '2 minutes',
       attempts=attempts+1,updated_at=now()
     WHERE revision_id=$1 AND attempts<$2
       AND (image_state='wanted' OR (image_state='pending' AND attempt_expires_at<now()))
     RETURNING attempts`,
    [revisionId, MAX_ATTEMPTS],
  );
  if (!claimed) return "skipped";
  const settle = async (
    state: "ready" | "wanted" | "failed",
    fields: { image?: Buffer; source?: string | null; reason?: string | null } = {},
  ) => {
    await db.query(
      `UPDATE revision_covers SET image_state=$2,image=$3,image_sha256=$4,image_source=$5,reason=$6,
         attempt_expires_at=NULL,updated_at=now()
       WHERE revision_id=$1 AND image_state='pending'`,
      [
        revisionId,
        state,
        fields.image ?? null,
        fields.image ? createHash("sha256").update(fields.image).digest("hex") : null,
        fields.source ?? null,
        fields.reason ? fields.reason.slice(0, 100) : null,
      ],
    );
  };
  const {
    rows: [r],
  } = await db.query(`SELECT r.*,${hiddenSql("r")} AS hidden FROM revisions r WHERE r.id=$1`, [revisionId]);
  if (!r || r.hidden) {
    await settle("failed", { reason: "hidden" });
    return "failed";
  }
  let page: Awaited<ReturnType<typeof snapshotPage>>;
  try {
    page = await snapshotPage(r);
  } catch {
    await settle("failed", { reason: "unreadable" });
    return "failed";
  }
  if ("reason" in page) {
    await settle("failed", { reason: page.reason });
    return "failed";
  }
  let result: SnapshotResult;
  try {
    result = await call({ html: page.html, script: page.script });
  } catch {
    result = { error: "navigation_failed" };
  }
  if ("error" in result) {
    const retry = Number(claimed.attempts) < MAX_ATTEMPTS && result.error !== "too_large";
    await settle(retry ? "wanted" : "failed", { source: page.source, reason: result.error });
    return retry ? "retry" : "failed";
  }
  if (result.blank) {
    await settle("failed", { source: page.source, reason: "blank" });
    return "blank";
  }
  await settle("ready", { image: Buffer.from(result.image, "base64"), source: page.source });
  return "ready";
}
