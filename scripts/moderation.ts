// Operator moderation. Runs as the runtime database role; prints no tokens.
//   npm run moderation:reports [-- --days N]
//   npm run moderation:revoke-share -- <shareId>
//   npm run moderation:disable -- <login|email> [--reason "…"]
//   npm run moderation:enable -- <login|email>
//   npm run moderation:queue
//   npm run moderation:approve -- <shareId> [--trust]
//   npm run moderation:unpause -- <shareId>
//   npm run moderation:trust -- <login|email>
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
  moderation.ts trust <login|email>`;

try {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      days: { type: "string" },
      reason: { type: "string" },
      trust: { type: "boolean" },
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
