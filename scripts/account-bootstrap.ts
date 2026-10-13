// Operator: the first administrator of a new installation, without mail.
// Finds or creates the account with this address (counted as verified),
// makes it the company admin and prints a one-time sign-in link valid for an
// hour (apps/server/operator-sign-in-links.ts). Running it again prints a
// new link and spends the old one; --no-admin only lets a person back in.
//
//   npm run admin -- account bootstrap anna@company.ru
//   docker compose --env-file hosted.env run --rm -T --no-deps app \
//     node --import tsx scripts/admin.ts account bootstrap anna@company.ru
//   … account bootstrap anna@company.ru --org "ООО Пример"   # TEAM_SHELVES_SCOPE=organisation
//   … account bootstrap anna@company.ru --no-admin            # a link only
//
// The link is a key to the account: hand it over in person or by a channel
// you trust, not in a shared chat. Nothing else secret is printed.
import { parseArgs } from "node:util";

const USAGE = 'Use npm run admin -- account bootstrap <email> [--org "<organisation>"] [--no-admin]';

let parsed: { email: string; org?: string; admin: boolean } | null = null;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { org: { type: "string" }, "no-admin": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [email, ...extra] = positionals;
  if (!email) throw new Error("no email given");
  if (extra.length) throw new Error(`unexpected argument ${extra[0]}`);
  if (values.org !== undefined && (!values.org || values.org.startsWith("--")))
    throw new Error("--org needs an organisation name");
  if (values.org !== undefined && values["no-admin"]) throw new Error("--org and --no-admin exclude each other");
  parsed = { email, org: values.org, admin: !values["no-admin"] };
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exitCode = 2;
}

if (parsed) {
  const { bootstrapEmail, bootstrapAccount } = await import("../apps/server/operator-sign-in-links.ts");
  const email = bootstrapEmail.safeParse(parsed.email);
  if (!email.success) {
    console.error(`${parsed.email} is not an email address\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const { db, transaction } = await import("../apps/server/db.ts");
    const { config } = await import("../apps/server/config.ts");
    try {
      const result = await transaction((c) =>
        bootstrapAccount(c, email.data, { admin: parsed.admin, org: parsed.org }),
      );
      console.log(
        [
          result.created ? `Created the account of ${email.data}.` : `The account of ${email.data} already exists.`,
          result.companyAdmin
            ? `It is the company admin${result.organisation ? ` of «${result.organisation.name}»` : ""}` +
              (config.TEAM_SHELVES === "on"
                ? "."
                : " (department shelves are off: TEAM_SHELVES=on in hosted.env shows the company page).")
            : "Its roles are unchanged.",
          "",
          "One-time sign-in link (one use, until " + result.expiresAt + "):",
          "",
          `  ${result.url}`,
          "",
          "Open it in a browser and press the button. Later sign-ins: an emailed code, or the company's",
          "SSO / Яндекс ID reporting this address as verified, open the same account (or link one in",
          "«Настройки» → «Способы входа»). Running this again prints a new link and spends this one.",
        ].join("\n"),
      );
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    } finally {
      await db.end();
    }
  }
}
