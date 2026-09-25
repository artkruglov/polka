// Operator script: the text of works saved before search read it
// (docs/specs/CONTENT_SEARCH.md). Runs as the runtime database role (it reads
// works and objects and writes artifact_search, granted in
// deploy/runtime-grants.sql). Idempotent: a second run finds nothing to do.
// Prints ids and sizes only, never content or titles.
//
//   npx tsx --env-file=.env scripts/search-backfill.ts --dry-run
//   npx tsx --env-file=.env scripts/search-backfill.ts [--batch 200] [--verbose]
import { parseArgs } from "node:util";
import { db } from "../apps/server/db.ts";
import { backfillSearch } from "../apps/server/search-backfill.ts";
import { s3 } from "../apps/server/storage.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    batch: { type: "string" },
    verbose: { type: "boolean" },
  },
});
const batch = values.batch ? Number(values.batch) : 200;
if (!Number.isInteger(batch) || batch < 1 || batch > 5000) {
  console.error("--batch: a whole number from 1 to 5000");
  process.exit(2);
}
try {
  const report = await backfillSearch({
    dryRun: values["dry-run"],
    batch,
    log: values.verbose ? (line) => console.log(line) : undefined,
  });
  console.log(
    JSON.stringify({ event: "backfill.search", dryRun: !!values["dry-run"], ...report }),
  );
} finally {
  await db.end();
  s3.destroy();
}
