// Fill revisions.content_filter.sensitiveInput for versions saved before it
// was recorded at save time (docs/specs/CONTENT_FILTER.md, «Поля для
// секретов»). The same detector over the same stored objects: a page and
// every page and script of a bundle. Run by scripts/backfill-sensitive-input.ts
// as the runtime role (it reads revisions and objects and updates revisions).
//
// Idempotent: only rows without the flag are read, and the update repeats
// that condition, so a concurrent save or a second run changes nothing. A
// version that cannot be read (deleted after a block, isolated, missing, or
// a page too deep to read in time) is left unknown: its recipients keep the
// full warning.
import { db } from "./db.ts";
import { inspectHtmlBounded } from "./html.ts";
import { readBlob } from "./storage.ts";
import {
  SensitiveInputDetector,
  mergeSensitive,
  sensitiveFields,
  type SensitiveInput,
} from "./content-filter/sensitive-input.ts";

const MAX_BUNDLE_FILES = 500;

type Row = {
  id: string;
  mime: string;
  storage_kind: "single" | "bundle";
  object_key: string;
  object_version: string;
};

/** The verdict for one stored revision; null when it cannot be read. */
export async function sensitiveInputOfRevision(
  revision: Row,
): Promise<SensitiveInput | null> {
  if (revision.mime !== "text/html") return { sensitive: false, signals: [] };
  const page = async (key: string, version: string) =>
    (await inspectHtmlBounded((await readBlob(key, version)).toString("utf8")))
      .sensitive ?? null;
  try {
    if (revision.storage_kind !== "bundle")
      return await page(revision.object_key, revision.object_version);
    const files = (
      await db.query(
        `SELECT mime,object_key,object_version FROM revision_files
         WHERE revision_id=$1 AND mime IN ('text/html','text/javascript')
         ORDER BY file_index LIMIT $2`,
        [revision.id, MAX_BUNDLE_FILES],
      )
    ).rows;
    const scripts = new SensitiveInputDetector();
    const pages: Array<SensitiveInput | null> = [];
    // The entrypoint is one of the files; read it even if it were not.
    if (!files.some((file) => file.object_key === revision.object_key))
      pages.push(await page(revision.object_key, revision.object_version));
    for (const file of files)
      if (file.mime === "text/html")
        pages.push(await page(file.object_key, file.object_version));
      else
        scripts.script(
          (await readBlob(file.object_key, file.object_version)).toString(
            "utf8",
          ),
        );
    return mergeSensitive(scripts.result(), ...pages);
  } catch {
    return null;
  }
}

export type BackfillReport = {
  scanned: number;
  sensitive: number;
  plain: number;
  unreadable: number;
  updated: number;
  failed: number;
};

export async function backfillSensitiveInput(
  options: {
    dryRun?: boolean;
    batch?: number;
    log?: (line: string) => void;
    /** Only these revisions (an operator's spot check, the tests). */
    revisionIds?: string[];
  } = {},
): Promise<BackfillReport> {
  const batch = options.batch ?? 200;
  const report: BackfillReport = {
    scanned: 0,
    sensitive: 0,
    plain: 0,
    unreadable: 0,
    updated: 0,
    failed: 0,
  };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows: Row[] = (
      await db.query(
        `SELECT id,mime,storage_kind,object_key,object_version FROM revisions
         WHERE id>$1 AND NOT content_filter ? 'sensitiveInput'
           AND content_purged_at IS NULL
           AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[]))
         ORDER BY id LIMIT $2`,
        [after, batch, options.revisionIds ?? null],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      report.scanned++;
      const verdict = await sensitiveInputOfRevision(row);
      if (!verdict) {
        report.unreadable++;
        continue;
      }
      if (verdict.sensitive) report.sensitive++;
      else report.plain++;
      options.log?.(
        `${row.id} ${verdict.sensitive ? `sensitive ${verdict.signals.join(",")}` : "plain"}`,
      );
      if (options.dryRun) continue;
      try {
        const { rowCount } = await db.query(
          `UPDATE revisions SET content_filter=content_filter||$2::jsonb
           WHERE id=$1 AND NOT content_filter ? 'sensitiveInput'`,
          [row.id, JSON.stringify(sensitiveFields(verdict))],
        );
        report.updated += rowCount ?? 0;
      } catch {
        // The 16 KB limit on content_filter, or the row went away.
        report.failed++;
      }
    }
  }
  return report;
}
