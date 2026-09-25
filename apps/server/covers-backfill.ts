// Shelf covers for works saved before covers existed (docs/specs/SHELF_COVERS.md).
// Cards also fill them lazily on first view; this backfill does it ahead, so
// that a shelf opens with every cover decided. Run by scripts/backfill-covers.ts
// as the runtime role (it reads revisions and objects and writes
// revision_covers, granted in deploy/runtime-grants.sql).
//
// Idempotent: only latest versions of works that are not in the trash and have
// no cover of this reader's version are read; the insert repeats that
// condition, so a concurrent card or a second run changes nothing.
import { COVER_VERSION } from "./cover-facts.ts";
import { computeCoverFacts, drawCover, refreshCover, snapshotsEnabled } from "./covers.ts";
import type { SnapshotCall } from "./cover-snapshot-client.ts";
import { db } from "./db.ts";
import { LINK_MIME } from "../../packages/contracts/constants.ts";

export type CoverBackfillReport = {
  scanned: number;
  covered: number;
  text: number;
  visual: number;
  failed: number;
  snapshots: { ready: number; blank: number; failed: number; retry: number };
};

export async function backfillCovers({
  dryRun = false,
  batch = 200,
  snapshots = false,
  call,
  log,
}: {
  dryRun?: boolean;
  batch?: number;
  /** Also draw the pictures now (needs COVER_SNAPSHOTS_ENABLED and the renderer). */
  snapshots?: boolean;
  call?: SnapshotCall;
  log?: (line: string) => void;
} = {}): Promise<CoverBackfillReport> {
  const report: CoverBackfillReport = {
    scanned: 0,
    covered: 0,
    text: 0,
    visual: 0,
    failed: 0,
    snapshots: { ready: 0, blank: 0, failed: 0, retry: 0 },
  };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await db.query(
      `SELECT r.* FROM revisions r
       JOIN artifacts a ON a.latest_revision_id=r.id AND a.trashed_at IS NULL
       LEFT JOIN revision_covers c ON c.revision_id=r.id
       WHERE r.id>$1 AND r.mime<>$2 AND r.content_purged_at IS NULL
         AND (c.revision_id IS NULL OR c.version<$3)
       ORDER BY r.id LIMIT $4`,
      [after, LINK_MIME, COVER_VERSION, batch],
    );
    if (!rows.length) break;
    after = rows.at(-1)!.id;
    for (const r of rows) {
      report.scanned++;
      try {
        const facts = dryRun ? await computeCoverFacts(r) : await refreshCover({ ...r, cover: null }, { schedule: false });
        if (facts?.kind === "text") report.text++;
        else if (facts?.kind === "visual") report.visual++;
        if (!dryRun) report.covered++;
        log?.(`${r.id} ${facts?.kind ?? "?"} ${facts?.genre ?? "?"}`);
      } catch {
        report.failed++;
        log?.(`${r.id} unreadable`);
      }
    }
  }
  if (snapshots && !dryRun && snapshotsEnabled()) {
    // Every picture still wanted, one at a time; a retry comes back until its attempts run out.
    for (let round = 0; round < 3; round++) {
      const { rows } = await db.query(
        `SELECT c.revision_id FROM revision_covers c
         JOIN artifacts a ON a.latest_revision_id=c.revision_id AND a.trashed_at IS NULL
         WHERE c.image_state='wanted' OR (c.image_state='pending' AND c.attempt_expires_at<now())
         ORDER BY c.updated_at`,
      );
      if (!rows.length) break;
      for (const { revision_id } of rows) {
        const outcome = await drawCover(revision_id, call);
        if (outcome !== "skipped") report.snapshots[outcome]++;
        log?.(`${revision_id} snapshot ${outcome}`);
      }
    }
  }
  return report;
}
