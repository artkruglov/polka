// Operator script: who may create department shelves (docs/specs/
// TEAM_SHELVES.md). Finds the account by login or e-mail and sets or clears
// accounts.company_admin and the organisation it administers. Prints the
// account id and the organisation only.
//
//   npm run admin -- company admin anna@example.ru
//   npm run admin -- company admin anna@example.ru --org "ООО Пример"
//   npm run admin -- company admin anna@example.ru --revoke
//
// With TEAM_SHELVES_SCOPE=organisation (polochka.app) --org is required. The
// organisation must exist (company org creates it): a misspelt name is an
// error, never a new organisation. So is a misspelt flag: `--revok` would
// otherwise grant the role it meant to take away.
import { parseArgs } from "node:util";

const USAGE = "Use npm run admin -- company admin <login or e-mail> [--org <organisation>] [--revoke]";

let parsed: { who: string; org?: string; revoke: boolean } | null = null;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { org: { type: "string" }, revoke: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [who, ...extra] = positionals;
  if (!who) throw new Error("no account given");
  if (extra.length) throw new Error(`unexpected argument ${extra[0]}`);
  if (values.org !== undefined && (!values.org || values.org.startsWith("--")))
    throw new Error("--org needs an organisation name");
  parsed = { who, org: values.org, revoke: values.revoke === true };
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exitCode = 2;
}

if (parsed) {
  // Only now: a refused command opens no database connection.
  const { db, transaction } = await import("../apps/server/db.ts");
  const { setCompanyAdmin } = await import("../apps/server/organisations.ts");
  const { who, org, revoke } = parsed;
  try {
    const result = await transaction((c) => setCompanyAdmin(c, who, { org, revoke }));
    console.log(
      JSON.stringify({
        event: "company_admin",
        accountId: result.accountId,
        companyAdmin: result.companyAdmin,
        organisation: result.organisation,
      }),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
