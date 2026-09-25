// Operator script: record whether each saved version asks for a password, a
// card or a code (revisions.content_filter.sensitiveInput) for versions saved
// before this was computed at save time. Runs as the runtime database role
// (it reads objects and updates revisions, both granted in
// deploy/runtime-grants.sql). Idempotent: a second run finds nothing to do.
// Prints ids and signal names only, never content or titles.
//
//   npx tsx --env-file=.env scripts/backfill-sensitive-input.ts --dry-run
//   npx tsx --env-file=.env scripts/backfill-sensitive-input.ts [--batch 200] [--verbose]
import { parseArgs } from "node:util";
import { db } from "../apps/server/db.ts";
import { backfillSensitiveInput } from "../apps/server/sensitive-input-backfill.ts";
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
  const report = await backfillSensitiveInput({
    dryRun: values["dry-run"],
    batch,
    log: values.verbose ? (line) => console.log(line) : undefined,
  });
  console.log(
    JSON.stringify({
      event: "backfill.sensitive_input",
      dryRun: !!values["dry-run"],
      ...report,
    }),
  );
  if (report.failed) process.exitCode = 1;
} finally {
  await db.end();
  s3.destroy();
}
