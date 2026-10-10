// Operator script: proposals to «Лента» from department shelves
// (docs/specs/DISCOVER_V2.md, «Предложение с полки отдела»). Nothing here
// publishes: an accepted work is copied into content/editorial and goes
// through the usual editorial path (EDITORIAL_CHECKLIST, candidates.json,
// admin editorial content-scan, editorial-seed-hosted.ts --only <slug>).
//
//   npm run admin -- feed proposals list [--all]
//   npm run admin -- feed proposals export <id> <slug>
//   npm run admin -- feed proposals decide <id> published
//   npm run admin -- feed proposals decide <id> rejected "<причина для кураторов>"
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../apps/server/db.ts";
import { decideFeedProposal, feedProposalSource, listFeedProposalsForOperator } from "../apps/server/feed-proposals.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usage = `Use:
  npm run admin -- feed proposals list [--all]
  npm run admin -- feed proposals export <id> <slug>
  npm run admin -- feed proposals decide <id> published|rejected ["reason"]`;

export async function runFeedProposals(argv: string[], root = process.cwd()) {
  const [command, id, third, ...rest] = argv;
  if (command === "list") {
    const items = await listFeedProposalsForOperator(argv.includes("--all"));
    for (const item of items) console.log(JSON.stringify(item));
    if (!items.length) console.log("No proposals waiting.");
    return 0;
  }
  if (command === "export" && id && UUID.test(id) && third && SLUG.test(third) && third.length <= 80) {
    const directory = resolve(root, "content/editorial", third);
    const target = resolve(directory, "index.html");
    if (
      await access(target).then(
        () => true,
        () => false,
      )
    ) {
      console.error(`${target} exists; pick another slug.`);
      return 1;
    }
    const { bytes, sha256: expected } = await feedProposalSource(id);
    if (sha256(bytes) !== expected) throw new Error("Stored bytes do not match the revision hash");
    await mkdir(directory, { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    console.log(
      JSON.stringify({
        event: "feed_proposal.exported",
        id,
        sourcePath: `content/editorial/${third}/index.html`,
        sha256: expected,
        next: "Check it by EDITORIAL_CHECKLIST, add it to candidates.json, run admin editorial content-scan, publish with editorial-seed-hosted.ts --only, then decide <id> published.",
      }),
    );
    return 0;
  }
  if (command === "decide" && id && UUID.test(id) && (third === "published" || third === "rejected")) {
    const result = await decideFeedProposal(id, third, rest.join(" ") || null);
    console.log(JSON.stringify({ event: "feed_proposal.decided", ...result }));
    return 0;
  }
  console.error(usage);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runFeedProposals(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.end();
    s3.destroy();
  }
}
