// Shelves and their members (docs/specs/TEAM_SHELVES.md). A personal shelf
// has its owner as the one member ('owner'); a department shelf ('team') has
// no owner and several members with roles. Every check of «may this account
// do this on this shelf» goes through here.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.ts";
import { afterCommit, db } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { companyAdminOf } from "./organisations.ts";

export const SHELF_ROLES = ["reader", "author", "curator", "admin", "owner"] as const;
export type ShelfRole = (typeof SHELF_ROLES)[number];
const RANK: Record<ShelfRole, number> = {
  reader: 1,
  author: 2,
  curator: 3,
  admin: 4,
  owner: 5,
};

/** The owner of a personal shelf passes every check; otherwise by rank. */
export const atLeast = (role: ShelfRole, min: ShelfRole) => role === "owner" || RANK[role] >= RANK[min];

/**
 * An author changes the works it saved; a curator and above change any. On a
 * personal shelf the owner changes everything.
 */
export const mayChange = (role: ShelfRole, createdBy: string, actorId: string) =>
  atLeast(role, "curator") || (atLeast(role, "author") && createdBy === actorId);

export function assertMayChange(role: ShelfRole, createdBy: string, actorId: string) {
  if (!mayChange(role, createdBy, actorId))
    throw new Problem(
      403,
      "forbidden",
      "Автор меняет только свои работы. Чужие работы меняют куратор и администратор полки.",
    );
}

export const teamShelfNameSchema = z.string().trim().min(1, "Назовите полку.").max(80, "Название — до 80 символов.");

export type Shelf = {
  id: string;
  kind: "personal" | "team";
  name: string | null;
  role: ShelfRole;
};

/**
 * The shelf a request asks for: the account's active membership of an active
 * shelf, or null. Department shelves count only while TEAM_SHELVES is on.
 */
export async function memberShelf(
  c: Pick<PoolClient, "query">,
  accountId: string,
  tenantId: string,
): Promise<Shelf | null> {
  const {
    rows: [row],
  } = await c.query(
    `SELECT t.id,t.kind,t.name,m.role FROM tenant_members m
     JOIN tenants t ON t.id=m.tenant_id
     WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.state='active'
       AND t.state='active' AND ($3::boolean OR t.kind='personal')`,
    [tenantId, accountId, config.TEAM_SHELVES === "on"],
  );
  return (row as Shelf | undefined) ?? null;
}

/** Every shelf the account may open: its own first, then departments by name. */
export async function shelvesOf(accountId: string): Promise<Shelf[]> {
  const { rows } = await db.query(
    `SELECT t.id,t.kind,t.name,m.role FROM tenant_members m
     JOIN tenants t ON t.id=m.tenant_id
     WHERE m.account_id=$1 AND m.state='active' AND t.state='active'
       AND ($2::boolean OR t.kind='personal')
     ORDER BY t.kind='team',lower(t.name),t.id`,
    [accountId, config.TEAM_SHELVES === "on"],
  );
  return rows as Shelf[];
}

/**
 * The shelf locks a client's current transaction holds: its id
 * (pg_current_xact_id) and the strongest lock of each shelf and account
 * pair. The entry goes at commit; after a rollback it stays, and the id,
 * read again with the recheck, no longer matches. (The code takes no
 * savepoints, whose rollback would release the locks.)
 */
const heldShelfLocks = new WeakMap<PoolClient, { tx: string; locks: Map<string, "UPDATE" | "SHARE"> }>();

/**
 * Lock the shelf, the account, then its membership (the order account
 * deletion takes too), and check the account's role on it: the
 * membership twin of lockActiveOwnerTenant. A personal shelf's owner passes
 * any role, so an owner's paths behave exactly as before. A shelf the account
 * may not open is «not found», like someone else's work; a role too low is
 * «forbidden».
 *
 * An agent's call locks the shelf in service-auth and again in the service
 * it calls, in one transaction. The second time the rows are already this
 * transaction's: one plain read rechecks them (the same conditions, the
 * current values) instead of three locking statements.
 */
export async function lockShelf(
  c: PoolClient,
  actor: { id: string; tenant: string },
  min: ShelfRole,
  lock: "UPDATE" | "SHARE" = "UPDATE",
  denied: () => Error = missing,
) {
  const key = `${actor.tenant}:${actor.id}`;
  const held = heldShelfLocks.get(c);
  const heldLock = held?.locks.get(key);
  if (held && heldLock && (heldLock === "UPDATE" || lock === "SHARE")) {
    const {
      rows: [row],
    } = await c.query(
      `SELECT pg_current_xact_id()::text AS held_tx,member.role AS held_role,tenant.*
       FROM (SELECT 1) here
       LEFT JOIN tenants tenant ON tenant.id=$1 AND tenant.state='active'
         AND ($3::boolean OR tenant.kind='personal')
       LEFT JOIN accounts account ON account.id=$2
         AND NOT account.disabled AND account.deletion_requested_at IS NULL
       LEFT JOIN tenant_members member ON member.tenant_id=tenant.id
         AND member.account_id=account.id AND member.state='active'`,
      [actor.tenant, actor.id, config.TEAM_SHELVES === "on"],
    );
    if (row.held_tx === held.tx) {
      const { held_tx: _tx, held_role: role, ...tenant } = row;
      if (!role) throw denied();
      if (!atLeast(role, min)) throw new Problem(403, "forbidden", "Для этого нужна другая роль на полке.");
      return { tenant, role: role as ShelfRole };
    }
  }
  const locked = (
    await c.query(
      `SELECT *,pg_current_xact_id()::text AS held_tx FROM tenants WHERE id=$1 AND state='active'
         AND ($2::boolean OR kind='personal') FOR ${lock}`,
      [actor.tenant, config.TEAM_SHELVES === "on"],
    )
  ).rows[0];
  if (!locked) throw denied();
  const { held_tx: tx, ...tenant } = locked;
  const account = (
    await c.query(
      `SELECT id FROM accounts
       WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL
       FOR ${lock}`,
      [actor.id],
    )
  ).rows[0];
  if (!account) throw denied();
  const member = (
    await c.query(
      `SELECT role FROM tenant_members
       WHERE tenant_id=$1 AND account_id=$2 AND state='active' FOR ${lock}`,
      [actor.tenant, actor.id],
    )
  ).rows[0];
  if (!member) throw denied();
  const current = heldShelfLocks.get(c);
  if (current && current.tx === tx) {
    if (lock === "UPDATE" || !current.locks.has(key)) current.locks.set(key, lock);
  } else {
    heldShelfLocks.set(c, { tx, locks: new Map([[key, lock]]) });
    afterCommit(c, () => {
      if (heldShelfLocks.get(c)?.tx === tx) heldShelfLocks.delete(c);
    });
  }
  if (!atLeast(member.role, min)) throw new Problem(403, "forbidden", "Для этого нужна другая роль на полке.");
  return { tenant, role: member.role as ShelfRole };
}

/** A company admin opens a department shelf and becomes its first admin. */
export async function createTeamShelfInTransaction(
  c: PoolClient,
  actor: { id: string },
  rawName: string,
): Promise<Shelf> {
  if (config.TEAM_SHELVES !== "on") throw missing();
  const name = teamShelfNameSchema.parse(rawName);
  // In organisation scope the shelf belongs to the admin's organisation, and
  // an admin without one is not a company admin (organisations.ts). In
  // installation scope it belongs to none (organisationId is null).
  const admin = await companyAdminOf(c, actor.id, true);
  if (!admin) throw new Problem(403, "forbidden", "Полки отделов создаёт администратор компании.");
  const id = randomUUID();
  await c.query(
    `INSERT INTO tenants(id,owner_id,kind,name,created_by,organisation_id) VALUES($1,NULL,'team',$2,$3,$4)`,
    [id, name, actor.id, admin.organisationId],
  );
  await c.query(
    `INSERT INTO tenant_members(tenant_id,account_id,role,invited_by)
     VALUES($1,$2,'admin',$2)`,
    [id, actor.id],
  );
  await c.query(
    `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,new_role)
     VALUES($1,$2,'shelf_created',$2,'admin')`,
    [id, actor.id],
  );
  return { id, kind: "team", name, role: "admin" };
}
