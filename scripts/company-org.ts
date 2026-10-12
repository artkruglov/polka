// Operator script: an organisation on a shared cloud (docs/specs/
// TEAM_SHELVES.md, «Организации в облаке»). Creates it when missing, adds or
// removes its own mail domains (a verified address there counts as its
// employee; public mail services are refused) and attaches existing
// department shelves. A shelf of another organisation moves only with --move;
// each attach is written to the shelf's journal. Prints the organisation, its
// domains and the shelves attached now with their previous organisation.
//
//   npm run admin -- company org "ООО Пример" --domain example.ru
//   npm run admin -- company org "ООО Пример" --remove-domain old.example.ru
//   npm run admin -- company org "ООО Пример" --shelf <department shelf uuid> [--move]
import { db, transaction } from "../apps/server/db.ts";
import { configureOrganisation } from "../apps/server/organisations.ts";

const args = process.argv.slice(2);
const name = args[0];
const values = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));
const addDomains = values("--domain"),
  removeDomains = values("--remove-domain"),
  shelves = values("--shelf");
const move = args.includes("--move");
const known = new Set(["--domain", "--remove-domain", "--shelf"]);
const malformed =
  [...addDomains, ...removeDomains, ...shelves].some((value) => !value || value.startsWith("--")) ||
  args
    .slice(1)
    .some((arg, index) => arg.startsWith("--") && arg !== "--move" && !known.has(arg) && !known.has(args[index]));
if (!name || name.startsWith("--") || malformed) {
  console.error(
    'Use npm run admin -- company org "<name>" [--domain <domain>]… [--remove-domain <domain>]… [--shelf <uuid>]… [--move]',
  );
  process.exitCode = 2;
} else {
  try {
    // shelves: the ones attached now, each with the organisation it was in before.
    const organisation = await transaction((c) =>
      configureOrganisation(c, name, { addDomains, removeDomains, shelves, move }),
    );
    console.log(JSON.stringify({ event: "organisation", ...organisation }));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
