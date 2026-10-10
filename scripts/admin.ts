/**
 * The operator's commands in one place:
 *
 *   npm run admin -- <group> <command> [arguments]           # locally, with .env
 *   node --import tsx scripts/admin.ts <group> <command> …   # in the app container
 *
 * Each command runs the script it names with the arguments that follow, as
 * if that script had been started itself; `npm run admin` alone lists them.
 * The scripts stay runnable on their own (deploy/hosted/README.md uses them).
 */
import { fileURLToPath, pathToFileURL } from "node:url";

type Command = { script: string; args?: string[]; about: string };

const moderation = (command: string, about: string): Command => ({
  script: "moderation.ts",
  args: [command],
  about,
});

export const COMMANDS: Record<string, Record<string, Command>> = {
  moderation: {
    reports: moderation("reports", "reports on links: [--days N]"),
    queue: moderation("queue", "links held for review"),
    approve: moderation("approve", "approve a link waiting for review: <shareId> [--trust]"),
    unpause: moderation("unpause", "open a paused link again: <shareId>"),
    trust: moderation("trust", "trust an account: <login|email>"),
    "revoke-share": moderation("revoke-share", "close a link: <shareId>"),
    disable: moderation("disable", "close an author's links and sign-in: <login|email> [--reason …]"),
    enable: moderation("enable", "undo disable: <login|email>"),
    takedown: moderation(
      "takedown",
      "block on a demand: <link|shareId|artifactId|login> --reason … [--authority …] [--category …] [--disable] [--legal-hold]",
    ),
    block: moderation("block", "block a link's version: <shareId> --reason … [--category …] [--legal-hold]"),
    unblock: moderation("unblock", "lift a block: <id> [--reason …]"),
    "legal-hold": moderation("legal-hold", "keep blocked content as evidence: <id> on --authority … | <id> off"),
    "handed-over": moderation("handed-over", "evidence handed over, delete now: <id> [--reason …]"),
    "purge-artifact": moderation("purge-artifact", "delete blocked content now: <id> [--reason …]"),
    comments: moderation("comments", "comments on a link: <shareId>"),
    "delete-comment": moderation("delete-comment", "delete a comment: <commentId>"),
    "release-comment": moderation("release-comment", "release a held comment: <commentId>"),
    events: moderation("events", "the moderation journal: [<id>]"),
    sweep: moderation("sweep", "reminders, deletion by deadline and model rechecks now"),
    recheck: moderation("recheck", "check saved versions with the rules again: [--fraud] [--dry-run]"),
  },
  account: {
    create: { script: "account.ts", about: "create an account: <login> --generate, or the password on stdin" },
    email: { script: "account-email.ts", about: "attach an email to an account: <login> <email>" },
    merge: { script: "account-merge.ts", about: "merge two shelves: --from … --into … --proof … [--dry-run]" },
    erase: { script: "account-erase.ts", about: "erase an account on request: --account … [--dry-run]" },
  },
  backfill: {
    covers: { script: "backfill-covers.ts", about: "shelf covers for works saved before covers" },
    search: { script: "search-backfill.ts", about: "search text for works saved before search" },
    "sensitive-input": {
      script: "backfill-sensitive-input.ts",
      about: "record password, card or code fields in old versions",
    },
  },
  company: {
    admin: { script: "company-admin.ts", about: "who may create department shelves: <login|email> [--revoke]" },
  },
  feed: {
    proposals: {
      script: "feed-proposals.ts",
      about: "proposals to «Лента»: list [--all] | export <id> <slug> | decide …",
    },
  },
  shelf: {
    import: { script: "shelf-import.ts", about: "save an exported shelf: --dir … --account … [--dry-run]" },
  },
  metrics: {
    summary: { script: "metrics.ts", about: "product metrics: [--weeks N] [--json] | forget <account>" },
    "agent-access": { script: "agent-access-metrics.ts", about: "agent access report (AGENT_ACCESS_AND_MEMORY)" },
  },
  editorial: {
    "content-scan": { script: "editorial-content-scan.ts", about: "check the editorial catalogue with the rules" },
  },
};

export function usage() {
  const lines = ["Usage: npm run admin -- <group> <command> [arguments]", ""];
  for (const [group, commands] of Object.entries(COMMANDS)) {
    lines.push(group);
    for (const [name, command] of Object.entries(commands)) lines.push(`  ${name.padEnd(17)} ${command.about}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [group, name, ...rest] = process.argv.slice(2);
  const command = group && name ? COMMANDS[group]?.[name] : undefined;
  if (!command) {
    console.error(group ? `Unknown command: ${[group, name].filter(Boolean).join(" ")}\n\n${usage()}` : usage());
    process.exit(group ? 2 : 0);
  }
  const script = fileURLToPath(new URL(command.script, import.meta.url));
  // The script reads its own arguments from process.argv and may check that
  // it is the entry point; both see it as started directly.
  process.argv = [process.argv[0]!, script, ...(command.args ?? []), ...rest];
  await import(pathToFileURL(script).href);
}
