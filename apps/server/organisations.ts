// Organisations on a shared cloud (docs/specs/TEAM_SHELVES.md, «Организации в
// облаке», migration 070). With TEAM_SHELVES_SCOPE=organisation a company
// admin administers the department shelves of one organisation, and a shelf
// admin adds directly only the organisation's employees; everyone else joins
// through an invitation link they accept themselves. With the default scope
// (installation) the installation is one company, as before, and nothing here
// narrows anything.
//
// Two circles, on purpose:
// - an employee (orgDomainSql): a verified address on one of the
//   organisation's domains. Only an employee is added directly, found by
//   address, and shown with an address;
// - a person of the organisation (ofOrganisationSql): an employee, or an
//   active member of one of its shelves (someone who accepted a link). The
//   company admin finds them by login and offboards them from its shelves.
import type { PoolClient } from "pg";
import { config } from "./config.ts";
import { HOSTED_MAIL_SITE } from "./mail-templates/login-code.ts";
import { DOMAIN_RE, PUBLIC_MAIL_DOMAINS } from "./mail-domains.ts";

type Query = Pick<PoolClient, "query">;

export const organisationScope = () => config.TEAM_SHELVES_SCOPE === "organisation";

/**
 * The company admin's organisation: `{ organisationId }`, null for anyone who
 * is not a company admin. In organisation scope an admin without an
 * organisation is not one; in installation scope organisationId is null and
 * means «every department shelf».
 */
export async function companyAdminOf(
  c: Query,
  accountId: string,
  lock = false,
): Promise<{ organisationId: string | null } | null> {
  const {
    rows: [row],
  } = await c.query(
    `SELECT company_admin,company_organisation_id FROM accounts
     WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [accountId],
  );
  if (!row?.company_admin) return null;
  if (!organisationScope()) return { organisationId: null };
  return row.company_organisation_id ? { organisationId: row.company_organisation_id as string } : null;
}

/**
 * SQL: is the account (expression `account`) an employee of the organisation
 * (expression `org`): a verified address on one of its domains?
 */
export const orgDomainSql = (account: string, org: string) =>
  `EXISTS (SELECT 1 FROM accounts person
           JOIN organisation_domains domain ON domain.organisation_id=${org}
            AND domain.domain=substring(person.email from '@([^@]+)$')
           WHERE person.id=${account} AND person.email_verified_at IS NOT NULL)`;

/**
 * SQL: is the account an employee of the organisation or an active member of
 * one of its department shelves? The company admin's circle.
 */
export const ofOrganisationSql = (account: string, org: string) => `(
  ${orgDomainSql(account, org)}
  OR EXISTS (SELECT 1 FROM tenant_members membership
             JOIN tenants shelf ON shelf.id=membership.tenant_id
             WHERE membership.account_id=${account} AND membership.state='active'
               AND shelf.kind='team' AND shelf.state='active' AND shelf.organisation_id=${org}))`;

/**
 * SQL: may an administrator of the organisation see (and look someone up by)
 * this account's address? In installation scope always (one company). In
 * organisation scope only an employee's: someone who joined by a link shows
 * by name only, and their address finds nothing.
 */
export const emailVisibleSql = (account: string, org: string) =>
  organisationScope()
    ? orgDomainSql(account, org)
    : // The parameter still appears, so PostgreSQL knows its type.
      `(${org} IS NULL OR true)`;

/** Whom a company writes to for a company admin on this installation. */
export function companyContact() {
  if (config.APP_ORIGIN === HOSTED_MAIL_SITE.origin) return HOSTED_MAIL_SITE.contact;
  return config.OPERATOR_CONTACT ?? config.OPERATOR_EMAIL ?? null;
}

/** What a shelf admin may add directly, for the members dialog. */
export async function directAddRule(c: Query, shelfId: string) {
  if (!organisationScope()) return { scope: "installation" as const };
  const { rows } = await c.query(
    `SELECT organisation.name,domain.domain FROM tenants shelf
     JOIN organisations organisation ON organisation.id=shelf.organisation_id
     LEFT JOIN organisation_domains domain ON domain.organisation_id=organisation.id
     WHERE shelf.id=$1 ORDER BY domain.domain`,
    [shelfId],
  );
  return {
    scope: "organisation" as const,
    organisation: (rows[0]?.name as string | undefined) ?? null,
    domains: rows.map((row) => row.domain as string | null).filter((domain): domain is string => Boolean(domain)),
  };
}

// Operator commands (npm run admin -- company org|admin). They run as the
// application's role, like the other operator scripts. Names are compared by
// lower(), which follows the database's ctype.

const organisationName = (raw: string) => {
  const name = raw.trim();
  if (!name || name.length > 80) throw new Error("An organisation's name is 1–80 characters.");
  return name;
};

/** An existing organisation by name (case-insensitive), or null. */
export async function findOrganisation(c: Query, rawName: string) {
  const {
    rows: [row],
  } = await c.query("SELECT id,name FROM organisations WHERE lower(name)=lower($1)", [organisationName(rawName)]);
  return (row as { id: string; name: string } | undefined) ?? null;
}

/** The organisation by name (case-insensitive), created when missing. */
export async function ensureOrganisation(c: Query, rawName: string) {
  const name = organisationName(rawName);
  await c.query("INSERT INTO organisations(name) VALUES($1) ON CONFLICT ((lower(name))) DO NOTHING", [name]);
  return (await findOrganisation(c, name))!;
}

/**
 * Creates the organisation when missing, adds and removes its own mail
 * domains, and attaches department shelves to it. A public mail service is
 * never an organisation's domain: everyone with an address there would count
 * as its employee. A shelf of another organisation moves only with `move`;
 * every attach or move is written to the shelf's journal.
 */
export async function configureOrganisation(
  c: Query,
  rawName: string,
  change: { addDomains?: string[]; removeDomains?: string[]; shelves?: string[]; move?: boolean } = {},
) {
  const organisation = await ensureOrganisation(c, rawName);
  const clean = (value: string) => value.trim().toLowerCase().replace(/^@/, "");
  for (const raw of change.addDomains ?? []) {
    const domain = clean(raw);
    if (!DOMAIN_RE.test(domain)) throw new Error(`Not a domain: ${raw}`);
    if (PUBLIC_MAIL_DOMAINS.includes(domain))
      throw new Error(`${domain} is a public mail service, not an organisation's domain.`);
    await c.query(
      "INSERT INTO organisation_domains(domain,organisation_id) VALUES($1,$2) ON CONFLICT (domain) DO NOTHING",
      [domain, organisation.id],
    );
    const {
      rows: [owner],
    } = await c.query("SELECT organisation_id FROM organisation_domains WHERE domain=$1", [domain]);
    if (owner.organisation_id !== organisation.id)
      throw new Error(`${domain} already belongs to another organisation.`);
  }
  for (const raw of change.removeDomains ?? [])
    await c.query("DELETE FROM organisation_domains WHERE domain=$1 AND organisation_id=$2", [
      clean(raw),
      organisation.id,
    ]);
  const shelves: { id: string; name: string; previous: string | null }[] = [];
  const ids = [...new Set(change.shelves ?? [])];
  if (ids.length) {
    const { rows } = await c.query(
      `SELECT shelf.id,shelf.name,shelf.organisation_id,previous.name AS previous
       FROM tenants shelf LEFT JOIN organisations previous ON previous.id=shelf.organisation_id
       WHERE shelf.id=ANY($1::uuid[]) AND shelf.kind='team'
       ORDER BY shelf.id FOR UPDATE OF shelf`,
      [ids],
    );
    if (rows.length !== ids.length) throw new Error("Not every id is a department shelf.");
    const elsewhere = rows.filter((row) => row.organisation_id && row.organisation_id !== organisation.id);
    if (elsewhere.length && !change.move)
      throw new Error(
        `Already in another organisation: ${elsewhere
          .map((row) => `${row.id} (${row.name}) in «${row.previous}»`)
          .join(", ")}. Add --move to move them.`,
      );
    for (const row of rows) {
      if (row.organisation_id === organisation.id) continue;
      await c.query("UPDATE tenants SET organisation_id=$2 WHERE id=$1", [row.id, organisation.id]);
      await c.query(
        "INSERT INTO tenant_member_events(tenant_id,actor_id,action) VALUES($1,NULL,'shelf_organisation_changed')",
        [row.id],
      );
      shelves.push({ id: row.id, name: row.name, previous: row.previous ?? null });
    }
  }
  const { rows } = await c.query("SELECT domain FROM organisation_domains WHERE organisation_id=$1 ORDER BY domain", [
    organisation.id,
  ]);
  return { ...organisation, domains: rows.map((row) => row.domain as string), shelves };
}

/**
 * Makes an account (login or address, exactly one active match) a company
 * admin of an existing organisation, or takes the role away. In organisation
 * scope an organisation is required: an admin without one administers
 * nothing. A misspelt name never creates one: `company org` does that.
 */
export async function setCompanyAdmin(c: Query, who: string, options: { org?: string; revoke?: boolean }) {
  const { rows } = await c.query(
    `SELECT id FROM accounts
     WHERE (name=$1 OR email=lower($1))
       AND NOT disabled AND deletion_requested_at IS NULL
     FOR UPDATE`,
    [who],
  );
  if (rows.length !== 1)
    throw new Error(rows.length ? "More than one account matches; nothing changed." : "No active account matches.");
  const accountId = rows[0].id as string;
  if (options.revoke) {
    await c.query("UPDATE accounts SET company_admin=false,company_organisation_id=NULL WHERE id=$1", [accountId]);
    return { accountId, companyAdmin: false, organisation: null };
  }
  if (!options.org) {
    if (organisationScope())
      throw new Error("TEAM_SHELVES_SCOPE=organisation: name the organisation with --org <name>.");
    await c.query("UPDATE accounts SET company_admin=true WHERE id=$1", [accountId]);
    return { accountId, companyAdmin: true, organisation: null };
  }
  const organisation = await findOrganisation(c, options.org);
  if (!organisation)
    throw new Error(
      `No organisation «${options.org.trim()}». Create it first: npm run admin -- company org "<name>" --domain <domain>.`,
    );
  await c.query("UPDATE accounts SET company_admin=true,company_organisation_id=$2 WHERE id=$1", [
    accountId,
    organisation.id,
  ]);
  return { accountId, companyAdmin: true, organisation };
}
