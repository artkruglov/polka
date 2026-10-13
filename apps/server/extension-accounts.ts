// Accounts and department-shelf memberships for an extension's own sign-in
// and provisioning (docs/specs/EXTENSIONS.md, context.accounts and
// context.teamShelves): an enterprise SSO (SAML) finishes its sign-in with the
// core's session, and a directory (SCIM) creates, updates and deprovisions
// people and their department shelves through these services. No protocol of
// any identity provider lives here: the extension maps its users and groups
// to the ids these functions return, in its own tables.
//
// Every change names the core organisation it acts for (migration 070,
// organisations.ts): an address is provisioned or changed only on one of its
// domains, and only its department shelves are created, read or changed.
// With TEAM_SHELVES_SCOPE=installation a shelf without an organisation counts
// as every organisation's: the installation is one company.
//
// An extension's deprovision is its own reason to disable an account
// (accounts.deprovisioned_at, migration 072), apart from the operator's
// (operator_disabled_at): the account stays disabled while either holds, and
// reactivate lifts only the extension's, and only for the organisation that
// made it (deprovisioned_organisation_id, migration 073).
//
// An existing account is the organisation's only while its current address
// is verified and on one of the organisation's domains: update, deprovision,
// reactivate and startSession refuse any other account (403,
// organisation_member). Domains are unique to one organisation, so one
// organisation's directory never changes, disables, brings back or signs in
// another organisation's person.
//
// Lock order is the core's: a shelf, then accounts by id, then memberships
// (shelf-members.ts, lockShelf); a personal shelf, then its account
// (lockActiveAccount, account-deletion.ts).
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type {
  ExtensionAccount,
  ExtensionDeprovision,
  ExtensionTeamMember,
  ExtensionTeamShelf,
} from "../../packages/extension-api/index.ts";
import { markActive } from "./analytics.ts";
import { audit } from "./artifacts.ts";
import { passwordHash } from "./auth.ts";
import { config } from "./config.ts";
import { afterCommit, db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { emitEvent } from "./extensions.ts";
import { log } from "./log.ts";
import { revokeConnectionInTransaction } from "./oauth.ts";
import { organisationScope } from "./organisations.ts";
import { TEAM_ROLES } from "./shelf-members.ts";
import { teamShelfNameSchema } from "./shelves.ts";
import { sessionCookie } from "./sign-in-routes.ts";
import { sha256 } from "./storage.ts";

type Query = Pick<PoolClient, "query">;

const idSchema = z.string().uuid();
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.string().email("Неверный адрес почты."));
const nameSchema = z.string().trim().min(1).max(200);
const roleSchema = z.enum(TEAM_ROLES);

const ACCOUNT_SQL = `SELECT a.id,a.name AS login,COALESCE(a.display_name,a.name) AS name,a.email,
         a.email_verified_at IS NOT NULL AS email_verified,a.disabled,
         a.deletion_requested_at IS NOT NULL AS deleting,a.company_admin,a.company_organisation_id,
         a.operator_disabled_at IS NOT NULL AS operator_disabled,a.deprovisioned_by,
         a.deprovisioned_organisation_id,t.id AS shelf
    FROM accounts a LEFT JOIN tenants t ON t.owner_id=a.id`;

type AccountRow = {
  id: string;
  login: string;
  name: string;
  email: string | null;
  email_verified: boolean;
  disabled: boolean;
  deleting: boolean;
  company_admin: boolean;
  company_organisation_id: string | null;
  operator_disabled: boolean;
  deprovisioned_by: string | null;
  deprovisioned_organisation_id: string | null;
  shelf: string | null;
};

const toAccount = (row: AccountRow): ExtensionAccount => ({
  id: row.id,
  login: row.login,
  name: row.name,
  email: row.email,
  emailVerified: row.email_verified,
  state: row.deleting ? "deleting" : row.disabled ? "disabled" : "active",
  operatorDisabled: row.operator_disabled,
  deprovisionedBy: row.deprovisioned_by,
  deprovisionedOrganisationId: row.deprovisioned_organisation_id,
  companyAdmin: row.company_admin,
  companyOrganisationId: row.company_organisation_id,
  personalShelfId: row.shelf,
});

async function readAccount(c: Query, id: string) {
  const {
    rows: [row],
  } = await c.query(`${ACCOUNT_SQL} WHERE a.id=$1`, [id]);
  return row ? toAccount(row as AccountRow) : null;
}

/** The personal shelf, then the account, both locked (the order of sign-in). */
async function lockPersonal(c: PoolClient, accountId: string) {
  const tenant = (await c.query("SELECT id FROM tenants WHERE owner_id=$1 FOR UPDATE", [accountId])).rows[0];
  const account = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  if (!tenant || !account) throw missing();
  return { tenant: tenant.id as string, account };
}

const noOrganisation = () => new Problem(404, "not_found", "Нет такой организации.");

/** The organisation's own mail domains (organisation_domains). */
async function domainsOf(c: Query, organisationId: string) {
  if (!idSchema.safeParse(organisationId).success) throw noOrganisation();
  const { rows } = await c.query(
    `SELECT o.id,d.domain FROM organisations o
     LEFT JOIN organisation_domains d ON d.organisation_id=o.id WHERE o.id=$1`,
    [organisationId],
  );
  if (!rows.length) throw noOrganisation();
  return rows.map((row) => row.domain as string | null).filter((domain): domain is string => Boolean(domain));
}

const offDomain = () =>
  new Problem(403, "forbidden", "Эта почта не на домене организации.", { reason: "organisation_domain" });

/** An address the extension vouches for must be on one of the organisation's domains. */
async function assertOnDomain(c: Query, organisationId: string, email: string) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!(await domainsOf(c, organisationId)).includes(domain)) throw offDomain();
}

const notMember = () =>
  new Problem(403, "forbidden", "Этот аккаунт не из организации.", { reason: "organisation_member" });

/**
 * The (locked) account is the organisation's person: its current address is
 * verified and on one of the organisation's domains. An unknown organisation:
 * 404; any other account: 403.
 */
async function assertMember(
  c: Query,
  organisationId: string,
  account: { email: string | null; email_verified_at: Date | null },
) {
  const domains = await domainsOf(c, organisationId);
  const email = account.email_verified_at ? account.email : null;
  if (!email || !domains.includes(email.slice(email.lastIndexOf("@") + 1))) throw notMember();
}

/** The organisation a call acts for; a call without one is refused (400). */
const organisationInput = z.object({ organisationId: z.string() });

export async function getAccount(id: string) {
  if (!idSchema.safeParse(id).success) return null;
  return readAccount(db, id);
}

export async function findAccountByEmail(email: string) {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return null;
  const {
    rows: [row],
  } = await db.query(`${ACCOUNT_SQL} WHERE a.email=$1`, [parsed.data]);
  return row ? toAccount(row as AccountRow) : null;
}

/**
 * The person the extension's directory names: their account by the address,
 * or a new one with a personal shelf. Only an address on one of the
 * organisation's domains (403 otherwise): the organisation vouches for its
 * own people, so the address is verified and no sign-up cap applies. An
 * existing account is returned as it is, disabled included: reactivating is a
 * separate step, and whether to link an existing account is the extension's
 * decision (it sees companyAdmin and the rest).
 */
export async function provisionAccount(input: { email: string; name?: string | null; organisationId: string }) {
  const email = emailSchema.parse(input.email);
  const name = input.name == null ? null : nameSchema.parse(input.name).slice(0, 40);
  return transaction(async (c) => {
    await assertOnDomain(c, input.organisationId, email);
    // Serialises with email and provider sign-in of the same address.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [email]);
    const {
      rows: [existing],
    } = await c.query("SELECT id FROM accounts WHERE email=$1", [email]);
    if (existing) return { account: (await readAccount(c, existing.id))!, created: false };
    const id = randomUUID();
    // An unused random password keeps password login apart, as for email.
    const password = await passwordHash(randomBytes(32).toString("hex"));
    await c.query(
      `INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at,trusted_at)
       VALUES($1,$2,$3,$4,$5,now(),now())`,
      [id, `sso-${id}`, password, email, name ?? email.split("@")[0]!.slice(0, 40)],
    );
    await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [randomUUID(), id]);
    return { account: (await readAccount(c, id))!, created: true };
  });
}

/**
 * Of the organisation's person only (403 otherwise): a new address (only on
 * the organisation's domains; another account's: 409) or display name
 * (null: none). A changed address ends every session
 * and every code sent to either address, and is written to the journal.
 */
export async function updateAccount(
  extension: string,
  id: string,
  input: { email?: string; name?: string | null; organisationId: string },
) {
  idSchema.parse(id);
  organisationInput.parse(input);
  const email = input.email === undefined ? undefined : emailSchema.parse(input.email);
  const name = input.name == null ? input.name : nameSchema.parse(input.name).slice(0, 40);
  return transaction(async (c) => {
    if (email) {
      await assertOnDomain(c, input.organisationId, email);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [email]);
    }
    const { tenant, account } = await lockPersonal(c, id);
    await assertMember(c, input.organisationId, account);
    if (email && email !== account.email) {
      const { rowCount } = await c.query("SELECT 1 FROM accounts WHERE email=$1 AND id<>$2", [email, id]);
      if (rowCount) throw new Problem(409, "conflict", "Эта почта уже у другого аккаунта Полки.");
      await c.query("UPDATE accounts SET email=$2,email_verified_at=now() WHERE id=$1", [id, email]);
      await c.query("DELETE FROM sessions WHERE account_id=$1", [id]);
      await c.query(
        "UPDATE login_challenges SET consumed_at=now() WHERE email=ANY($1::text[]) AND consumed_at IS NULL",
        [[email, account.email].filter(Boolean)],
      );
      await audit(c, { id, tenant }, "account.email_changed", id, { extension });
    }
    // null: the account's login stands for the name again.
    if (name !== undefined) await c.query("UPDATE accounts SET display_name=$2 WHERE id=$1", [id, name]);
    return (await readAccount(c, id))!;
  });
}

/** SQL: a shelf (alias) of the organisation ($param); in installation scope also one with none. */
const ofOrganisation = (shelf: string, param: string) =>
  `(${shelf}.organisation_id=${param}::uuid OR (NOT ${organisationScope()} AND ${shelf}.organisation_id IS NULL))`;

/**
 * The person is gone for the organisation's directory: the extension's own
 * reason to disable the account. Every session ends, every agent connection
 * (tokens and OAuth grants) is revoked and the person leaves the
 * organisation's department shelves. Nothing is deleted, and the person's
 * links stop opening while the account is disabled. Idempotent. Only the
 * organisation's person (403 otherwise); the organisation is recorded, and
 * only it can reactivate.
 */
export async function deprovisionAccount(
  extension: string,
  id: string,
  input: { organisationId: string; reason?: string },
): Promise<ExtensionDeprovision> {
  idSchema.parse(id);
  organisationInput.parse(input);
  const result = await transaction(async (c) => {
    await domainsOf(c, input.organisationId);
    const { tenant, account } = await lockPersonal(c, id);
    // Nothing changes for an account being deleted (its address may be gone).
    if (account.deletion_requested_at)
      return { state: "deleting" as const, sessions: 0, connections: 0, shelves: [] as string[] };
    await assertMember(c, input.organisationId, account);
    const { rows: connections } = await c.query(
      `SELECT id,tenant_id,account_id FROM agent_connections
       WHERE account_id=$1 AND revoked_at IS NULL ORDER BY id FOR UPDATE`,
      [id],
    );
    for (const connection of connections) await revokeConnectionInTransaction(c, connection);
    const sessions = await c.query("DELETE FROM sessions WHERE account_id=$1", [id]);
    const { rows: memberships } = await c.query(
      `UPDATE tenant_members member SET state='revoked',revoked_at=clock_timestamp()
       FROM tenants shelf
       WHERE member.tenant_id=shelf.id AND shelf.kind='team' AND ${ofOrganisation("shelf", "$2")}
         AND member.account_id=$1 AND member.state='active'
       RETURNING member.tenant_id,member.role`,
      [id, input.organisationId],
    );
    for (const member of memberships)
      await c.query(
        `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role)
         VALUES($1,NULL,'member_revoked',$2,$3)`,
        [member.tenant_id, id, member.role],
      );
    const already = !!account.deprovisioned_at;
    if (!already) {
      await c.query(
        `UPDATE accounts SET disabled=true,deprovisioned_at=clock_timestamp(),deprovisioned_by=$2,
           deprovisioned_organisation_id=$3
         WHERE id=$1`,
        [id, extension, input.organisationId],
      );
      await audit(c, { id, tenant }, "account.deprovisioned", id, {
        extension,
        organisation: input.organisationId,
      });
    }
    const shelves = memberships.map((member) => member.tenant_id as string);
    afterCommit(c, () => {
      for (const shelf of shelves)
        emitEvent({ type: "member.revoked", tenantId: shelf, accountId: id, at: new Date().toISOString() });
    });
    return {
      state: already ? ("already" as const) : ("deprovisioned" as const),
      sessions: sessions.rowCount ?? 0,
      connections: connections.length,
      shelves,
    };
  });
  log.info({
    event: "extension.account_deprovisioned",
    extension,
    accountId: id,
    state: result.state,
    reason: input.reason?.slice(0, 200) ?? null,
  });
  return result;
}

/**
 * Lifts the extension's deprovision, and only it: an account the operator or
 * moderation disabled stays disabled (state "disabled", operatorDisabled).
 * Only the organisation's person (403 otherwise), and only the organisation
 * that deprovisioned it (another one's, or another extension's: 409); a
 * deprovision recorded before migration 073 names no organisation.
 * Department shelves are not given back; the directory adds the person again.
 */
export async function reactivateAccount(extension: string, id: string, input: { organisationId: string }) {
  idSchema.parse(id);
  const { organisationId } = organisationInput.parse(input);
  return transaction(async (c) => {
    await domainsOf(c, organisationId);
    const { tenant, account } = await lockPersonal(c, id);
    if (account.deletion_requested_at) throw new Problem(409, "conflict", "Аккаунт удаляется.");
    await assertMember(c, organisationId, account);
    if (account.deprovisioned_at) {
      if (account.deprovisioned_by !== extension)
        throw new Problem(409, "conflict", "Аккаунт отключило другое расширение.");
      if (account.deprovisioned_organisation_id && account.deprovisioned_organisation_id !== organisationId)
        throw new Problem(409, "conflict", "Аккаунт отключила другая организация.");
      await c.query(
        `UPDATE accounts SET deprovisioned_at=NULL,deprovisioned_by=NULL,deprovisioned_organisation_id=NULL,
           disabled=(operator_disabled_at IS NOT NULL)
         WHERE id=$1`,
        [id],
      );
      await audit(c, { id, tenant }, "account.reactivated", id, { extension, organisation: organisationId });
    }
    return (await readAccount(c, id))!;
  });
}

/**
 * Signs the person in with the core's own session (7 days, the
 * polka_session cookie) after the extension has verified them, as every
 * sign-in does: the browser's earlier session ends, the day counts as active,
 * and the journal records which extension signed the person in. Only the
 * organisation's person (403, organisation_member; no organisation named:
 * 400). A disabled account or one being deleted: 403.
 */
export async function startSessionForExtension(
  extension: string,
  reply: FastifyReply,
  accountId: string,
  input: { organisationId: string; previous?: string },
) {
  idSchema.parse(accountId);
  const { organisationId, previous } = organisationInput.extend({ previous: z.string().optional() }).parse(input);
  const session = randomBytes(32).toString("base64url");
  await transaction(async (c) => {
    await domainsOf(c, organisationId);
    const { tenant, account } = await lockPersonal(c, accountId);
    if (account.disabled || account.deletion_requested_at)
      throw new Problem(403, "forbidden", "Этот аккаунт отключён. Обратитесь к администратору компании.", {
        reason: "account_disabled",
      });
    await assertMember(c, organisationId, account);
    if (previous) await c.query("DELETE FROM sessions WHERE hash=$1", [sha256(previous)]);
    await c.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')", [sha256(session), accountId]);
    await audit(c, { id: accountId, tenant }, "account.signed_in", accountId, {
      extension,
      organisation: organisationId,
    });
  });
  markActive(accountId);
  reply.setCookie("polka_session", session, sessionCookie());
  log.info({ event: "extension.sign_in", extension, accountId, organisationId });
}

// Department shelves (docs/specs/TEAM_SHELVES.md) for a directory's groups,
// within one organisation. Changes are recorded in the shelf's journal with
// no actor (actor_id NULL): the directory made them.

const teamShelvesOn = () => {
  if (config.TEAM_SHELVES !== "on")
    throw new Problem(404, "not_found", "Полки отделов на этой установке выключены (TEAM_SHELVES).");
};

/** The organisation's active shelf, locked; another organisation's is «not found». */
async function lockTeam(c: PoolClient, organisationId: string, shelfId: string) {
  teamShelvesOn();
  await domainsOf(c, organisationId);
  if (!idSchema.safeParse(shelfId).success) throw missing();
  const {
    rows: [shelf],
  } = await c.query(
    `SELECT id,name FROM tenants shelf
     WHERE id=$1 AND kind='team' AND state='active' AND ${ofOrganisation("shelf", "$2")} FOR UPDATE`,
    [shelfId, organisationId],
  );
  if (!shelf) throw missing();
  return shelf as { id: string; name: string };
}

const memberEvent = (
  c: PoolClient,
  shelfId: string,
  action: string,
  target: string | null,
  oldRole: string | null,
  newRole: string | null,
) =>
  c.query(
    `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role,new_role)
     VALUES($1,NULL,$2,$3,$4,$5)`,
    [shelfId, action, target, oldRole, newRole],
  );

export async function listTeamShelves(organisationId: string): Promise<ExtensionTeamShelf[]> {
  teamShelvesOn();
  await domainsOf(db, organisationId);
  const { rows } = await db.query(
    `SELECT id,name FROM tenants shelf WHERE kind='team' AND state='active' AND ${ofOrganisation("shelf", "$1")}
     ORDER BY lower(name),id LIMIT 5000`,
    [organisationId],
  );
  return rows;
}

export async function getTeamShelf(organisationId: string, id: string): Promise<ExtensionTeamShelf | null> {
  teamShelvesOn();
  await domainsOf(db, organisationId);
  if (!idSchema.safeParse(id).success) return null;
  const {
    rows: [row],
  } = await db.query(
    `SELECT id,name FROM tenants shelf
     WHERE id=$1 AND kind='team' AND state='active' AND ${ofOrganisation("shelf", "$2")}`,
    [id, organisationId],
  );
  return row ?? null;
}

/**
 * A new department shelf of the organisation, with no members yet. Its admin
 * comes from the directory (setMember with 'admin') or the company admin's
 * page («Стать администратором»).
 */
export async function createTeamShelf(organisationId: string, name: string): Promise<ExtensionTeamShelf> {
  teamShelvesOn();
  const clean = teamShelfNameSchema.parse(name);
  return transaction(async (c) => {
    await domainsOf(c, organisationId);
    const id = randomUUID();
    await c.query(
      `INSERT INTO tenants(id,owner_id,kind,name,created_by,organisation_id) VALUES($1,NULL,'team',$2,NULL,$3)`,
      [id, clean, organisationId],
    );
    await memberEvent(c, id, "shelf_created", null, null, null);
    return { id, name: clean };
  });
}

export async function renameTeamShelf(organisationId: string, id: string, name: string): Promise<ExtensionTeamShelf> {
  const clean = teamShelfNameSchema.parse(name);
  return transaction(async (c) => {
    const shelf = await lockTeam(c, organisationId, id);
    if (shelf.name !== clean) {
      await c.query("UPDATE tenants SET name=$2 WHERE id=$1", [id, clean]);
      await memberEvent(c, id, "shelf_renamed", null, null, null);
    }
    return { id, name: clean };
  });
}

export async function listTeamMembers(organisationId: string, id: string): Promise<ExtensionTeamMember[]> {
  return transaction(async (c) => {
    await lockTeam(c, organisationId, id);
    const { rows } = await c.query(
      `SELECT member.account_id AS "accountId",member.role FROM tenant_members member
       JOIN accounts account ON account.id=member.account_id
       WHERE member.tenant_id=$1 AND member.state='active'
         AND NOT account.disabled AND account.deletion_requested_at IS NULL
       ORDER BY member.account_id`,
      [id],
    );
    return rows;
  });
}

const organisationOnly = () =>
  new Problem(403, "forbidden", "Добавить можно только сотрудника с подтверждённой почтой на домене организации.", {
    reason: "organisation_domain",
  });

/**
 * Adds the person with this role, or changes their role. As a shelf admin's
 * direct add on a shared cloud (TEAM_SHELVES.md): only a person with a
 * verified address on one of the organisation's domains (403 otherwise); a
 * disabled account: 409.
 */
export async function setTeamMember(organisationId: string, shelfId: string, accountId: string, rawRole: string) {
  const role = roleSchema.parse(rawRole);
  idSchema.parse(accountId);
  return transaction(async (c) => {
    await lockTeam(c, organisationId, shelfId);
    const {
      rows: [account],
    } = await c.query(
      `SELECT id,email,email_verified_at IS NOT NULL AS verified FROM accounts
       WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
      [accountId],
    );
    if (!account) throw new Problem(409, "conflict", "Аккаунт отключён или удаляется.");
    if (!account.verified || !account.email) throw organisationOnly();
    await assertOnDomain(c, organisationId, account.email).catch(() => {
      throw organisationOnly();
    });
    const {
      rows: [member],
    } = await c.query("SELECT role,state FROM tenant_members WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE", [
      shelfId,
      accountId,
    ]);
    if (member?.state === "active") {
      if (member.role !== role) {
        await c.query("UPDATE tenant_members SET role=$3 WHERE tenant_id=$1 AND account_id=$2", [
          shelfId,
          accountId,
          role,
        ]);
        await memberEvent(c, shelfId, "member_role_changed", accountId, member.role, role);
      }
      return { accountId, role, added: false };
    }
    await c.query(
      `INSERT INTO tenant_members(tenant_id,account_id,role,invited_by)
       VALUES($1,$2,$3,NULL)
       ON CONFLICT (tenant_id,account_id) DO UPDATE
         SET role=EXCLUDED.role,state='active',revoked_at=NULL,joined_at=now(),invited_by=NULL`,
      [shelfId, accountId, role],
    );
    await memberEvent(c, shelfId, "member_added", accountId, null, role);
    return { accountId, role, added: true };
  });
}

/**
 * Takes the person off the shelf; the works stay. The directory is the
 * source of truth here, so even the last admin is taken off: the company
 * admin's page shows a shelf left without one («Стать администратором»).
 */
export async function removeTeamMember(organisationId: string, shelfId: string, accountId: string) {
  idSchema.parse(accountId);
  const removed = await transaction(async (c) => {
    await lockTeam(c, organisationId, shelfId);
    await c.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
    const {
      rows: [member],
    } = await c.query("SELECT role,state FROM tenant_members WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE", [
      shelfId,
      accountId,
    ]);
    if (!member || member.state !== "active") return false;
    await c.query(
      `UPDATE tenant_members SET state='revoked',revoked_at=clock_timestamp()
       WHERE tenant_id=$1 AND account_id=$2`,
      [shelfId, accountId],
    );
    await memberEvent(c, shelfId, "member_revoked", accountId, member.role, null);
    return true;
  });
  if (removed) emitEvent({ type: "member.revoked", tenantId: shelfId, accountId, at: new Date().toISOString() });
  return { removed };
}
