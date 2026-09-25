// Fill artifact_search for works saved before search read their text
// (docs/specs/CONTENT_SEARCH.md). The same extraction as a save, over the
// stored objects of each work's latest version. Run by
// scripts/search-backfill.ts as the runtime role (it reads artifacts,
// revisions and objects and writes artifact_search).
//
// Idempotent: only works whose row is missing or belongs to an older version
// are read, and a row is written only while that version is still the
// latest, so a save during the run wins. A version that cannot be read
// (purged, isolated, missing, a page too deep to read in time) is skipped.
import { LINK_MIME } from "../../packages/contracts/index.ts";
import { db, transaction } from "./db.ts";
import { inspectHtmlBounded } from "./html.ts";
import { linkText } from "./saved-link-format.ts";
import {
  SEARCH_TEXT_CHARS,
  SearchText,
  addScriptText,
  indexRevisionText,
} from "./search-text.ts";
import { readBlob } from "./storage.ts";

const MAX_BUNDLE_FILES = 500;

type Row = {
  artifact_id: string;
  revision_id: string;
  title: string;
  mime: string;
  storage_kind: "single" | "bundle";
  object_key: string;
  object_version: string;
};

/** The text of one stored version for search; null when it cannot be read. */
export async function searchTextOfRevision(revision: Row): Promise<string | null> {
  const page = async (key: string, version: string) =>
    (
      await inspectHtmlBounded(
        (await readBlob(key, version)).toString("utf8"),
        undefined,
        { text: true },
      )
    ).text ?? null;
  try {
    if (revision.mime === "text/plain") {
      const bytes = await readBlob(revision.object_key, revision.object_version);
      return bytes.toString("utf8", 0, Math.min(bytes.length, SEARCH_TEXT_CHARS * 4));
    }
    if (revision.mime === LINK_MIME)
      return linkText(
        revision.title,
        await readBlob(revision.object_key, revision.object_version),
      );
    if (revision.storage_kind !== "bundle")
      return await page(revision.object_key, revision.object_version);
    // A bundle: the entry page's visible text, then the scripts' phrases.
    const text = new SearchText();
    const entry = await page(revision.object_key, revision.object_version);
    if (entry) text.add(entry);
    const scripts = (
      await db.query(
        `SELECT object_key,object_version FROM revision_files
         WHERE revision_id=$1 AND mime='text/javascript'
         ORDER BY file_index LIMIT $2`,
        [revision.revision_id, MAX_BUNDLE_FILES],
      )
    ).rows;
    for (const script of scripts) {
      if (text.full) break;
      addScriptText(
        (await readBlob(script.object_key, script.object_version)).toString("utf8"),
        text,
      );
    }
    return text.value();
  } catch {
    return null;
  }
}

export type SearchBackfillReport = {
  scanned: number;
  indexed: number;
  empty: number;
  unreadable: number;
  skipped: number;
};

export async function backfillSearch(
  options: {
    dryRun?: boolean;
    batch?: number;
    log?: (line: string) => void;
    /** Only these works (an operator's spot check, the tests). */
    artifactIds?: string[];
  } = {},
): Promise<SearchBackfillReport> {
  const batch = options.batch ?? 200;
  const report: SearchBackfillReport = {
    scanned: 0,
    indexed: 0,
    empty: 0,
    unreadable: 0,
    skipped: 0,
  };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows: Row[] = (
      await db.query(
        `SELECT a.id AS artifact_id,r.id AS revision_id,a.title,r.mime,
                r.storage_kind,r.object_key,r.object_version
         FROM artifacts a
         JOIN revisions r ON r.id=a.latest_revision_id
         LEFT JOIN artifact_search s ON s.artifact_id=a.id
         WHERE a.id>$1 AND r.content_purged_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM moderation_blocks b
                           WHERE b.revision_id=r.id AND b.released_at IS NULL)
           AND r.mime IN ('text/html','text/plain',$3)
           AND (s.artifact_id IS NULL OR s.revision_id<>r.id)
           AND ($4::uuid[] IS NULL OR a.id=ANY($4::uuid[]))
         ORDER BY a.id LIMIT $2`,
        [after, batch, LINK_MIME, options.artifactIds ?? null],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      after = row.artifact_id;
      report.scanned++;
      const text = await searchTextOfRevision(row);
      if (text === null) {
        report.unreadable++;
        options.log?.(`${row.artifact_id} unreadable`);
        continue;
      }
      if (!text.trim()) report.empty++;
      options.log?.(`${row.artifact_id} ${text.trim() ? `${text.length} chars` : "empty"}`);
      if (options.dryRun || !text.trim()) continue;
      const written = await transaction(async (c) => {
        // Still the latest version, not purged and not blocked since it was
        // read: text moderation erased must not come back (purgeBlock).
        const {
          rows: [current],
        } = await c.query(
          `SELECT a.latest_revision_id,r.content_purged_at,
             EXISTS (SELECT 1 FROM moderation_blocks b
                     WHERE b.revision_id=r.id AND b.released_at IS NULL) AS blocked
           FROM artifacts a JOIN revisions r ON r.id=$2
           WHERE a.id=$1 FOR UPDATE OF a, r`,
          [row.artifact_id, row.revision_id],
        );
        if (
          current?.latest_revision_id !== row.revision_id ||
          current.content_purged_at ||
          current.blocked
        )
          return false;
        await indexRevisionText(c, row.artifact_id, row.revision_id, text);
        return true;
      });
      if (written) report.indexed++;
      else report.skipped++;
    }
  }
  return report;
}
