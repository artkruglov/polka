// Operator: attach an email address to an existing account, so signing in by
// emailed code opens that account's shelf instead of creating a new one.
//   npm run account:email -- <login> <email>
// The address counts as verified only after the first sign-in by code.
import { z } from "zod";
import { db } from "../apps/server/db.ts";

const [name, rawEmail] = process.argv.slice(2);
const email = z.string().trim().email().max(254).safeParse(rawEmail);
if (!name || !email.success) {
  console.error("Usage: npm run account:email -- <login> <email>");
  process.exitCode = 1;
} else {
  const address = email.data.toLowerCase();
  try {
    const {
      rows: [owner],
    } = await db.query("SELECT name FROM accounts WHERE email=$1", [address]);
    if (owner && owner.name !== name)
      throw new Error(`${address} already belongs to another account`);
    const updated = await db.query(
      `UPDATE accounts SET email=$2,
         email_verified_at=CASE WHEN email=$2 THEN email_verified_at END
       WHERE name=$1 AND NOT disabled AND deletion_requested_at IS NULL`,
      [name, address],
    );
    if (!updated.rowCount) throw new Error(`No active account named ${name}`);
    console.log(`${name} now signs in by code sent to ${address}.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
