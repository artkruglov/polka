// Operator script: who may create department shelves (docs/specs/
// TEAM_SHELVES.md). Finds the account by login or e-mail and sets or clears
// accounts.company_admin. Prints the account id only.
//
//   npm run company:admin -- anna@example.ru
//   npm run company:admin -- anna@example.ru --revoke
import { db } from "../apps/server/db.ts";

const who = process.argv[2];
const revoke = process.argv.includes("--revoke");
if (!who || who.startsWith("--")) {
  console.error("Use npm run company:admin -- <login or e-mail> [--revoke]");
  process.exitCode = 2;
} else {
  try {
    // Exactly one account, or nothing changes: a login, or the stored
    // (lowercase) e-mail matched exactly.
    const { rows } = await db.query(
      `SELECT id FROM accounts
       WHERE (name=$1 OR email=lower($1))
         AND NOT disabled AND deletion_requested_at IS NULL`,
      [who],
    );
    if (rows.length !== 1) {
      console.error(rows.length ? "More than one account matches; nothing changed." : "No active account matches.");
      process.exitCode = 1;
    } else {
      await db.query("UPDATE accounts SET company_admin=$2 WHERE id=$1", [rows[0].id, !revoke]);
      console.log(
        JSON.stringify({ event: "company_admin", accountId: rows[0].id, companyAdmin: !revoke }),
      );
    }
  } finally {
    await db.end();
  }
}
