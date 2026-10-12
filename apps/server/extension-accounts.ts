// Accounts and department-shelf memberships for an extension's own sign-in
// and provisioning (docs/specs/EXTENSIONS.md, context.accounts and
// context.teamShelves): an enterprise SSO (SAML) finishes its sign-in with the
// core's session, and a directory (SCIM) creates, updates and deprovisions
// people and their department shelves through these services. No protocol of
// any identity provider lives here: the extension maps its users and groups
// to the ids these functions return, in its own tables.
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
import { audit } from "./artifacts.ts";
import { passwordHash } from "./auth.ts";
import { config } from "./config.ts";
import { afterCommit, db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { emitEvent } from "./extensions.ts";
import { log } from "./log.ts";
import { revokeConnectionInTransaction } from "./oauth.ts";
import { TEAM_ROLES } from "./shelf-members.ts";
import { teamShelfNameSchema } from "./shelves.ts";
import { sessionCookie } from "./sign-in-routes.ts";
import { sha256 } from "./storage.ts";

const idSchema = z.string().uuid();
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.string().email("Неверный адрес почты."));
const nameSchema = z.string().trim().min(1).max(200);
const roleSchema = z.enum(TEAM_ROLES);

const ACCOUNT_SQL = `SELECT a.id,a.name AS login,COALESCE(a.display_name,a.name) AS name,a.email,
         a.disabled,a.deletion_requested_at IS NOT NULL AS deleting,a.company_admin,t.id AS shelf
    FROM accounts a LEFT JOIN tenants t ON t.owner_id=a.id`;

type AccountRow = {
  id: string;
  login: string;
  name: string;
  email: string | null;
  disabled: boolean;
  deleting: boolean;
  company_admin: boolean;
  shelf: string | null;
};

const toAccount = (row: AccountRow): ExtensionAccount => ({
  id: row.id,
  login: row.login,
  name: row.name,
  email: row.email,
  state: row.deleting ? "deleting" : row.disabled ? "disabled" : "active",
  companyAdmin: row.company_admin,
  personalShelfId: row.shelf,
});

async function readAccount(c: Pick<PoolClient, "query">, id: string) {
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
 * or a new one with a personal shelf. The directory vouches for the address,
 * so it is verified and no sign-up cap applies (the company provisions its
 * own people). An existing account is returned as it is, disabled included:
 * reactivating is a separate, explicit step.
 */
export async function provisionAccount(input: { email: string; name?: string | null }) {
  const email = emailSchema.parse(input.email);
  const name = input.name == null ? null : nameSchema.parse(input.name).slice(0, 40);
  return transaction(async (c) => {
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

/** A new address or name from the directory. Another account's address: 409. */
export async function updateAccount(id: string, input: { email?: string; name?: string | null }) {
  idSchema.parse(id);
  const email = input.email === undefined ? undefined : emailSchema.parse(input.email);
  const name = input.name == null ? input.name : nameSchema.parse(input.name).slice(0, 40);
  return transaction(async (c) => {
    if (email) await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [email]);
    const { account } = await lockPersonal(c, id);
    if (email && email !== account.email) {
      const { rowCount } = await c.query("SELECT 1 FROM accounts WHERE email=$1 AND id<>$2", [email, id]);
      if (rowCount) throw new Problem(409, "conflict", "Эта почта уже у другого аккаунта Полки.");
      await c.query("UPDATE accounts SET email=$2,email_verified_at=now() WHERE id=$1", [id, email]);
    }
    // null: the account's login stands for the name again.
    if (name !== undefined) await c.query("UPDATE accounts SET display_name=$2 WHERE id=$1", [id, name]);
    return (await readAccount(c, id))!;
  });
}

/**
 * The account is deprovisioned: the directory says the person is gone. As an
 * operator's disable (moderation.ts) does, every session ends and every agent
 * connection (tokens and OAuth grants) is revoked; the person is also taken
 * off every department shelf. Nothing is deleted, and the person's links stop
 * opening while the account is disabled (the core checks the answering
 * account). Idempotent. The extension says why in `reason` (its own words,
 * for the log).
 */
export async function deprovisionAccount(
  extension: string,
  id: string,
  input: { reason?: string } = {},
): Promise<ExtensionDeprovision> {
  idSchema.parse(id);
  const result = await transaction(async (c) => {
    const { tenant, account } = await lockPersonal(c, id);
    if (account.deletion_requested_at)
      return { state: "deleting" as const, sessions: 0, connections: 0, shelves: [] as string[] };
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
       WHERE member.tenant_id=shelf.id AND shelf.kind='team'
         AND member.account_id=$1 AND member.state='active'
       RETURNING member.tenant_id,member.role`,
      [id],
    );
    for (const member of memberships)
      await c.query(
        `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role)
         VALUES($1,NULL,'member_revoked',$2,$3)`,
        [member.tenant_id, id, member.role],
      );
    if (!account.disabled) {
      await c.query("UPDATE accounts SET disabled=true WHERE id=$1", [id]);
      await audit(c, { id, tenant }, "account.deprovisioned", id, { extension });
    }
    const shelves = memberships.map((member) => member.tenant_id as string);
    afterCommit(c, () => {
      for (const shelf of shelves)
        emitEvent({ type: "member.revoked", tenantId: shelf, accountId: id, at: new Date().toISOString() });
    });
    return {
      state: account.disabled ? ("already" as const) : ("deprovisioned" as const),
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
 * Lifts a deprovision. An account the operator or moderation disabled stays
 * disabled (403): only their own enable lifts that. Department shelves are not
 * given back; the directory adds the person to them again.
 */
export async function reactivateAccount(extension: string, id: string) {
  idSchema.parse(id);
  return transaction(async (c) => {
    const { tenant, account } = await lockPersonal(c, id);
    if (account.deletion_requested_at) throw new Problem(409, "conflict", "Аккаунт удаляется.");
    if (account.disabled) {
      // The latest decision of the operator or moderation about this account.
      const {
        rows: [moderated],
      } = await c.query(
        `SELECT action FROM moderation_events
         WHERE account_id=$1 AND action IN ('account.disabled','account.enabled')
         ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      if (moderated?.action === "account.disabled")
        throw new Problem(403, "forbidden", "Аккаунт отключил оператор Полки. Включить его может только оператор.", {
          reason: "operator_disabled",
        });
      await c.query("UPDATE accounts SET disabled=false WHERE id=$1", [id]);
      await audit(c, { id, tenant }, "account.reactivated", id, { extension });
    }
    return (await readAccount(c, id))!;
  });
}

/**
 * Signs the person in with the core's own session (7 days, the
 * polka_session cookie) after the extension has verified them. An account
 * that is disabled or being deleted: 403.
 */
export async function startSessionForExtension(extension: string, reply: FastifyReply, accountId: string) {
  idSchema.parse(accountId);
  const session = randomBytes(32).toString("base64url");
  await transaction(async (c) => {
    const { account } = await lockPersonal(c, accountId);
    if (account.disabled || account.deletion_requested_at)
      throw new Problem(403, "forbidden", "Этот аккаунт отключён. Обратитесь к администратору компании.", {
        reason: "account_disabled",
      });
    await c.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')", [sha256(session), accountId]);
  });
  reply.setCookie("polka_session", session, sessionCookie());
  log.info({ event: "extension.sign_in", extension, accountId });
}

// Department shelves (docs/specs/TEAM_SHELVES.md) for a directory's groups.
// Changes are recorded in the shelf's journal with no actor (actor_id NULL):
// the directory made them.

const teamShelvesOn = () => {
  if (config.TEAM_SHELVES !== "on")
    throw new Problem(404, "not_found", "Полки отделов на этой установке выключены (TEAM_SHELVES).");
};

async function lockTeam(c: PoolClient, shelfId: string) {
  teamShelvesOn();
  if (!idSchema.safeParse(shelfId).success) throw missing();
  const {
    rows: [shelf],
  } = await c.query("SELECT id,name FROM tenants WHERE id=$1 AND kind='team' AND state='active' FOR UPDATE", [shelfId]);
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

export async function listTeamShelves(): Promise<ExtensionTeamShelf[]> {
  teamShelvesOn();
  const { rows } = await db.query(
    `SELECT id,name FROM tenants WHERE kind='team' AND state='active' ORDER BY lower(name),id LIMIT 5000`,
  );
  return rows;
}

export async function getTeamShelf(id: string): Promise<ExtensionTeamShelf | null> {
  teamShelvesOn();
  if (!idSchema.safeParse(id).success) return null;
  const {
    rows: [row],
  } = await db.query(`SELECT id,name FROM tenants WHERE id=$1 AND kind='team' AND state='active'`, [id]);
  return row ?? null;
}

/**
 * A new department shelf with no members yet. Its admin comes from the
 * directory (setMember with 'admin') or the company admin's page («Стать
 * администратором»).
 */
export async function createTeamShelf(name: string): Promise<ExtensionTeamShelf> {
  teamShelvesOn();
  const clean = teamShelfNameSchema.parse(name);
  return transaction(async (c) => {
    const id = randomUUID();
    await c.query(`INSERT INTO tenants(id,owner_id,kind,name,created_by) VALUES($1,NULL,'team',$2,NULL)`, [id, clean]);
    await memberEvent(c, id, "shelf_created", null, null, null);
    return { id, name: clean };
  });
}

export async function renameTeamShelf(id: string, name: string): Promise<ExtensionTeamShelf> {
  const clean = teamShelfNameSchema.parse(name);
  return transaction(async (c) => {
    const shelf = await lockTeam(c, id);
    if (shelf.name !== clean) {
      await c.query("UPDATE tenants SET name=$2 WHERE id=$1", [id, clean]);
      await memberEvent(c, id, "shelf_renamed", null, null, null);
    }
    return { id, name: clean };
  });
}

export async function listTeamMembers(id: string): Promise<ExtensionTeamMember[]> {
  return transaction(async (c) => {
    await lockTeam(c, id);
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

/** Adds the person with this role, or changes their role. A disabled account: 409. */
export async function setTeamMember(shelfId: string, accountId: string, rawRole: string) {
  const role = roleSchema.parse(rawRole);
  idSchema.parse(accountId);
  return transaction(async (c) => {
    await lockTeam(c, shelfId);
    const {
      rows: [account],
    } = await c.query(
      `SELECT id FROM accounts WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
      [accountId],
    );
    if (!account) throw new Problem(409, "conflict", "Аккаунт отключён или удаляется.");
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
export async function removeTeamMember(shelfId: string, accountId: string) {
  idSchema.parse(accountId);
  const removed = await transaction(async (c) => {
    await lockTeam(c, shelfId);
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
