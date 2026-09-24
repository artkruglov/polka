// Operator: merge one person's two shelves into one
// (docs/specs/SIGN_IN_PROVIDERS.md § 9, apps/server/account-merge.ts).
// Runs as the runtime database role, like the moderation scripts; prints no
// tokens and no content.
//
//   npm run account:merge -- --from <login|email|id> --into <login|email|id> [--dry-run] [--reason "…"]
//
// Start with --dry-run: it prints what would move and changes nothing.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  formatMergeReport,
  mergeAccounts,
  MergeRefusal,
} from "../apps/server/account-merge.ts";
import { flushAnalytics } from "../apps/server/analytics.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";

const USAGE =
  'Usage: account-merge.ts --from <login|email|id> --into <login|email|id> [--dry-run] [--reason "…"] [--json]';

export async function runAccountMerge(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      into: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      reason: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.from || !values.into) {
    console.error(USAGE);
    return 2;
  }
  try {
    const report = await mergeAccounts({
      from: values.from,
      into: values.into,
      dryRun: values["dry-run"],
      actor: "operator-script",
      reason: values.reason,
    });
    console.log(
      values.json ? JSON.stringify(report, null, 2) : formatMergeReport(report),
    );
    await flushAnalytics();
    return report.leftovers.length ? 1 : 0;
  } catch (error) {
    if (error instanceof MergeRefusal) {
      console.error(`Отказ: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAccountMerge(process.argv.slice(2));
  } finally {
    await db.end();
    s3.destroy();
  }
}
