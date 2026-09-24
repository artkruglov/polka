// Operator moderation. Runs as the runtime database role; prints no tokens.
//   npm run moderation:reports [-- --days N]
//   npm run moderation:revoke-share -- <shareId>
//   npm run moderation:disable -- <login|email> [--reason "…"]
//   npm run moderation:enable -- <login|email>
//   npm run moderation:queue
//   npm run moderation:approve -- <shareId> [--trust]
//   npm run moderation:unpause -- <shareId>
//   npm run moderation:trust -- <login|email>
//   npm run moderation:comments -- <shareId>
//   npm run moderation:delete-comment -- <commentId>
//   npm run moderation:release-comment -- <commentId>
// Blocking (docs/specs/CONTENT_FILTER.md):
//   npm run moderation:takedown -- <link|shareId|artifactId|login> --reason "…"
//        [--authority "Роскомнадзор, требование №…"] [--category other|copyright|…]
//        [--disable] [--legal-hold]
//   npm run moderation:block -- <shareId> --reason "…" [--category …] [--legal-hold]
//   npm run moderation:unblock -- <id> [--reason "…"]
//   npm run moderation:legal-hold -- <id> on --authority "…" | off
//   npm run moderation:handed-over -- <id> [--reason "…"]
//   npm run moderation:purge-artifact -- <id> [--reason "…"]
//   npm run moderation:events [-- <id>]
//   npm run moderation:sweep
//   npm run moderation:recheck [-- --dry-run]
import { parseArgs } from "node:util";
import { db } from "../apps/server/db.ts";
import {
  ModerationError,
  approveShareAsOperator,
  disableAccount,
  enableAccount,
  formatDisabled,
  formatEnabled,
  formatReports,
  formatModerationQueue,
  formatRevokedShare,
  formatTrusted,
  formatShareComments,
  listShareComments,
  deleteCommentAsOperator,
  blockShareAsOperator,
  formatEvents,
  formatTakedown,
  handedOver,
  listEvents,
  purgeArtifactNow,
  setLegalHold,
  takedown,
  unblock,
  releaseCommentAsOperator,
  listModerationQueue,
  listReports,
  revokeShareAsOperator,
  trustAccount,
  unpauseShareAsOperator,
} from "../apps/server/moderation.ts";

const USAGE = `Usage:
  moderation.ts reports [--days N]
  moderation.ts revoke-share <shareId>
  moderation.ts disable <login|email> [--reason "…"]
  moderation.ts enable <login|email>
  moderation.ts queue
  moderation.ts approve <shareId> [--trust]
  moderation.ts unpause <shareId>
  moderation.ts trust <login|email>
  moderation.ts comments <shareId>
  moderation.ts delete-comment <commentId>
  moderation.ts release-comment <commentId>
  moderation.ts takedown <link|shareId|artifactId|login> --reason "…" [--authority "…"] [--category …] [--disable] [--legal-hold]
  moderation.ts block <shareId> --reason "…" [--category …] [--legal-hold]
  moderation.ts unblock <id> [--reason "…"]
  moderation.ts legal-hold <id> on --authority "…" | legal-hold <id> off
  moderation.ts handed-over <id> [--reason "…"]
  moderation.ts purge-artifact <id> [--reason "…"]
  moderation.ts events [<id>]
  moderation.ts sweep
  moderation.ts recheck [--dry-run]`;

const CATEGORY = new Set([
  "csam", "extremism_terror", "drugs", "weapons_explosives", "doxxing", "porn",
  "suicide", "gambling", "piracy", "blocklisted_domain", "fraud", "spam", "vpn",
  "malicious_code", "copyright", "other",
]);
const category = (value: string | undefined) => {
  if (value === undefined) return undefined;
  if (!CATEGORY.has(value)) throw new ModerationError(`Unknown category ${value}`);
  return value as Parameters<typeof takedown>[1]["category"];
};

try {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      days: { type: "string" },
      reason: { type: "string" },
      trust: { type: "boolean" },
      authority: { type: "string" },
      category: { type: "string" },
      disable: { type: "boolean" },
      "legal-hold": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  const [command, target, ...extra] = positionals;
  const one = () => {
    if (!target || extra.length) throw new ModerationError(USAGE);
    return target;
  };
  if (command === "reports" && !target)
    console.log(
      formatReports(await listReports(values.days ? Number(values.days) : 7)),
    );
  else if (command === "revoke-share")
    console.log(formatRevokedShare(await revokeShareAsOperator(one())));
  else if (command === "disable")
    console.log(formatDisabled(await disableAccount(one(), values.reason)));
  else if (command === "enable")
    console.log(formatEnabled(await enableAccount(one())));
  else if (command === "queue" && !target)
    console.log(formatModerationQueue(await listModerationQueue()));
  else if (command === "approve")
    console.log(
      (await approveShareAsOperator(one(), values.trust === true)).message,
    );
  else if (command === "unpause")
    console.log((await unpauseShareAsOperator(one())).message);
  else if (command === "trust")
    console.log(formatTrusted(await trustAccount(one())));
  else if (command === "comments")
    console.log(formatShareComments(await listShareComments(one())));
  else if (command === "delete-comment")
    console.log((await deleteCommentAsOperator(one())).message);
  else if (command === "release-comment")
    console.log((await releaseCommentAsOperator(one())).message);
  else if (command === "takedown")
    console.log(
      formatTakedown(
        await takedown(one(), {
          reason: values.reason ?? "",
          authority: values.authority ?? null,
          disable: values.disable === true,
          legalHold: values["legal-hold"] === true,
          category: category(values.category),
        }),
      ),
    );
  else if (command === "block") {
    if (!values.reason?.trim()) throw new ModerationError("--reason is required");
    console.log(
      (
        await blockShareAsOperator(one(), {
          actor: "operator-script",
          reason: values.reason,
          category: category(values.category) ?? "other",
          legalHold: values["legal-hold"] ? values.authority ?? values.reason : null,
          authority: values.authority ?? null,
        })
      ).message,
    );
  } else if (command === "unblock")
    console.log(await unblock(one(), values.reason ?? ""));
  else if (command === "legal-hold") {
    const [id, state] = [target, extra[0]];
    if (!id || !["on", "off"].includes(state ?? "") || extra.length !== 1)
      throw new ModerationError(USAGE);
    console.log(await setLegalHold(id, values.authority ?? "", state === "on"));
  } else if (command === "handed-over")
    console.log(await handedOver(one(), values.reason ?? ""));
  else if (command === "purge-artifact")
    console.log(await purgeArtifactNow(one(), values.reason ?? ""));
  else if (command === "events" && extra.length === 0)
    console.log(formatEvents(await listEvents(target)));
  else if (command === "recheck" && !target) {
    const { recheckHeldShares, formatRecheck } = await import(
      "../apps/server/shares.ts"
    );
    console.log(formatRecheck(await recheckHeldShares(values["dry-run"] === true)));
  } else if (command === "sweep" && !target) {
    const { sweepBlocks, retryUnchecked, reviewsSettled } = await import(
      "../apps/server/content-moderation.ts"
    );
    const result = await sweepBlocks();
    const retried = await retryUnchecked();
    await reviewsSettled();
    console.log(
      `Reminders sent: ${result.reminded}; blocks deleted: ${result.deleted}; unchecked revisions queued again: ${retried}.`,
    );
  }
  else throw new ModerationError(USAGE);
} catch (error) {
  const message = (error as Error).message;
  console.error(
    error instanceof ModerationError
      ? message
      : `Moderation failed: ${message}`,
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
