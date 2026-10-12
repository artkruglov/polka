// Organisations on a shared cloud (docs/specs/TEAM_SHELVES.md, «Организации в
// облаке», migration 070). With TEAM_SHELVES_SCOPE=organisation a company
// admin administers the department shelves of one organisation, and a shelf
// admin adds directly only people of the shelf's organisation; everyone else
// joins through an invitation link they accept themselves. With the default
// scope (installation) the installation is one company, as before, and
// nothing here narrows anything.
//
// A person «of the organisation»: a verified address on one of its domains,
// or an active member of one of its department shelves.
import type { PoolClient } from "pg";
import { config } from "./config.ts";
import { HOSTED_MAIL_SITE } from "./mail-templates/login-code.ts";
import { PUBLIC_MAIL_DOMAINS } from "./mail-domains.ts";

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
 * SQL: is the account (column `account`) a person of the organisation (`org`
 * parameter)? Both are SQL expressions of the caller's query.
 */
export const ofOrganisationSql = (account: string, org: string) => `(
  EXISTS (SELECT 1 FROM accounts person
          JOIN organisation_domains domain ON domain.organisation_id=${org}
           AND domain.domain=substring(person.email from '@([^@]+)$')
          WHERE person.id=${account} AND person.email_verified_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM tenant_members membership
             JOIN tenants shelf ON shelf.id=membership.tenant_id
             WHERE membership.account_id=${account} AND membership.state='active'
               AND shelf.kind='team' AND shelf.state='active' AND shelf.organisation_id=${org}))`;

/**
 * SQL: may an administrator of the organisation see this account's address?
 * In installation scope always (one company). In organisation scope only a
 * verified address on one of the organisation's domains: someone from outside
 * who joined by a link shows by name only.
 */
export const emailVisibleSql = (account: string, org: string) =>
  organisationScope()
    ? `EXISTS (SELECT 1 FROM accounts person
               JOIN organisation_domains domain ON domain.organisation_id=${org}
                AND domain.domain=substring(person.email from '@([^@]+)$')
               WHERE person.id=${account} AND person.email_verified_at IS NOT NULL)`
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
// application's role, like the other operator scripts.

const DOMAIN = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,63}$/;

/** The organisation by name (case-insensitive), created when missing. */
export async function ensureOrganisation(c: Query, rawName: string) {
  const name = rawName.trim();
  if (!name || name.length > 80) throw new Error("An organisation's name is 1–80 characters.");
  await c.query("INSERT INTO organisations(name) VALUES($1) ON CONFLICT ((lower(name))) DO NOTHING", [name]);
  const {
    rows: [row],
  } = await c.query("SELECT id,name FROM organisations WHERE lower(name)=lower($1)", [name]);
  return row as { id: string; name: string };
}

/**
 * Adds and removes an organisation's own mail domains, and attaches existing
 * department shelves to it. A public mail service is never an organisation's
 * domain: everyone with an address there would count as its employee.
 */
export async function configureOrganisation(
  c: Query,
  rawName: string,
  change: { addDomains?: string[]; removeDomains?: string[]; shelves?: string[] } = {},
) {
  const organisation = await ensureOrganisation(c, rawName);
  const clean = (value: string) => value.trim().toLowerCase().replace(/^@/, "");
  for (const raw of change.addDomains ?? []) {
    const domain = clean(raw);
    if (!DOMAIN.test(domain)) throw new Error(`Not a domain: ${raw}`);
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
  if (change.shelves?.length) {
    const { rowCount } = await c.query(
      "UPDATE tenants SET organisation_id=$2 WHERE id=ANY($1::uuid[]) AND kind='team'",
      [change.shelves, organisation.id],
    );
    if (rowCount !== new Set(change.shelves).size) throw new Error("Not every id is a department shelf.");
  }
  const { rows } = await c.query("SELECT domain FROM organisation_domains WHERE organisation_id=$1 ORDER BY domain", [
    organisation.id,
  ]);
  return { ...organisation, domains: rows.map((row) => row.domain as string) };
}

/**
 * Makes an account (login or address, exactly one active match) a company
 * admin of an organisation, or takes the role away. In organisation scope an
 * organisation is required: an admin without one administers nothing.
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
  const organisation = await ensureOrganisation(c, options.org);
  await c.query("UPDATE accounts SET company_admin=true,company_organisation_id=$2 WHERE id=$1", [
    accountId,
    organisation.id,
  ]);
  return { accountId, companyAdmin: true, organisation };
}
