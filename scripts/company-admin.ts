// Operator script: who may create department shelves (docs/specs/
// TEAM_SHELVES.md). Finds the account by login or e-mail and sets or clears
// accounts.company_admin and the organisation it administers. Prints the
// account id and the organisation only.
//
//   npm run admin -- company admin anna@example.ru
//   npm run admin -- company admin anna@example.ru --org "ООО Пример"
//   npm run admin -- company admin anna@example.ru --revoke
//
// With TEAM_SHELVES_SCOPE=organisation (polochka.app) --org is required: the
// organisation is created when missing (company org adds its domains).
import { db, transaction } from "../apps/server/db.ts";
import { setCompanyAdmin } from "../apps/server/organisations.ts";

const args = process.argv.slice(2);
const who = args[0];
const revoke = args.includes("--revoke");
const orgAt = args.indexOf("--org");
const org = orgAt >= 0 ? args[orgAt + 1] : undefined;
if (!who || who.startsWith("--") || (orgAt >= 0 && (!org || org.startsWith("--")))) {
  console.error("Use npm run admin -- company admin <login or e-mail> [--org <organisation>] [--revoke]");
  process.exitCode = 2;
} else {
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
