// Operator script: blank the values left in command templates of agent
// sessions sent by an older polka-sessions.mjs (`mysql -u <arg> <arg>`
// instead of `mysql -u root -pS3cret`). The runtime database role is enough
// (UPDATE on agent_session_tool_calls, deploy/runtime-grants.sql), so it uses
// the application's DATABASE_URL. Idempotent: a second run finds nothing.
// Prints counts only, never a template.
//
//   npm run admin -- sessions scrub-templates [--dry-run] [--batch 1000]
//   # on the VM, in the app container:
//   docker compose --env-file hosted.env run --rm --no-deps app \
//     node --import tsx scripts/admin.ts sessions scrub-templates [--dry-run]
import { parseArgs } from "node:util";
import { db } from "../apps/server/db.ts";
import { scrubSessionTemplates } from "../apps/server/session-template-scrub.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    batch: { type: "string" },
  },
});
const batch = values.batch ? Number(values.batch) : 1000;
if (!Number.isInteger(batch) || batch < 1 || batch > 10000) {
  console.error("--batch: a whole number from 1 to 10000");
  process.exit(2);
}
try {
  const report = await scrubSessionTemplates({ dryRun: values["dry-run"], batch });
  console.log(JSON.stringify({ event: "sessions.scrub_templates", dryRun: !!values["dry-run"], ...report }));
} finally {
  await db.end();
}
