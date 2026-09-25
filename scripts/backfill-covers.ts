// Operator script: decide the shelf cover of every work saved before covers
// existed (docs/specs/SHELF_COVERS.md). Runs as the runtime database role (it
// reads revisions and objects and writes revision_covers, both granted in
// deploy/runtime-grants.sql). Idempotent: a second run finds nothing to do.
// Prints ids, kinds and counts only, never content or titles.
//
//   npx tsx --env-file=.env scripts/backfill-covers.ts --dry-run
//   npx tsx --env-file=.env scripts/backfill-covers.ts [--batch 200] [--snapshots] [--verbose]
//
// --snapshots also draws the pictures of visual works now, one at a time,
// through the renderer (COVER_SNAPSHOTS_ENABLED, RENDERER_URL, RENDERER_SECRET).
// Without it the pictures are drawn when a card first asks for them.
import { parseArgs } from "node:util";
import { db } from "../apps/server/db.ts";
import { backfillCovers } from "../apps/server/covers-backfill.ts";
import { snapshotsEnabled } from "../apps/server/covers.ts";
import { s3 } from "../apps/server/storage.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    batch: { type: "string" },
    snapshots: { type: "boolean" },
    verbose: { type: "boolean" },
  },
});
const batch = values.batch ? Number(values.batch) : 200;
if (!Number.isInteger(batch) || batch < 1 || batch > 5000) {
  console.error("--batch: a whole number from 1 to 5000");
  process.exit(2);
}
if (values.snapshots && !snapshotsEnabled()) {
  console.error("--snapshots needs COVER_SNAPSHOTS_ENABLED=true, RENDERER_URL and RENDERER_SECRET");
  process.exit(2);
}
try {
  const report = await backfillCovers({
    dryRun: values["dry-run"],
    batch,
    snapshots: values.snapshots,
    log: values.verbose ? (line) => console.log(line) : undefined,
  });
  console.log(
    JSON.stringify({
      event: "backfill.covers",
      dryRun: !!values["dry-run"],
      ...report,
    }),
  );
  if (report.failed) process.exitCode = 1;
} finally {
  await db.end();
  s3.destroy();
}
