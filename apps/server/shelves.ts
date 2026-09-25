// Shelves and their members (docs/specs/TEAM_SHELVES.md). A personal shelf
// has its owner as the one member ('owner'); a department shelf ('team') has
// no owner and several members with roles. Every check of «may this account
// do this on this shelf» goes through here.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { Problem, missing } from "./errors.ts";

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
export const atLeast = (role: ShelfRole, min: ShelfRole) =>
  role === "owner" || RANK[role] >= RANK[min];

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

export const teamShelfNameSchema = z
  .string()
  .trim()
  .min(1, "Назовите полку.")
  .max(80, "Название — до 80 символов.");

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
 * Lock the shelf, the account, then its membership (the order account
 * deletion takes too), and check the account's role on it: the
 * membership twin of lockActiveOwnerTenant. A personal shelf's owner passes
 * any role, so an owner's paths behave exactly as before. A shelf the account
 * may not open is «not found», like someone else's work; a role too low is
 * «forbidden».
 */
export async function lockShelf(
  c: PoolClient,
  actor: { id: string; tenant: string },
  min: ShelfRole,
  lock: "UPDATE" | "SHARE" = "UPDATE",
) {
  const tenant = (
    await c.query(
      `SELECT * FROM tenants WHERE id=$1 AND state='active'
         AND ($2::boolean OR kind='personal') FOR ${lock}`,
      [actor.tenant, config.TEAM_SHELVES === "on"],
    )
  ).rows[0];
  if (!tenant) throw missing();
  const account = (
    await c.query(
      `SELECT id FROM accounts
       WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL
       FOR ${lock}`,
      [actor.id],
    )
  ).rows[0];
  if (!account) throw missing();
  const member = (
    await c.query(
      `SELECT role FROM tenant_members
       WHERE tenant_id=$1 AND account_id=$2 AND state='active' FOR ${lock}`,
      [actor.tenant, actor.id],
    )
  ).rows[0];
  if (!member) throw missing();
  if (!atLeast(member.role, min))
    throw new Problem(403, "forbidden", "Для этого нужна другая роль на полке.");
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
  const {
    rows: [admin],
  } = await c.query(
    `SELECT company_admin FROM accounts
     WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
    [actor.id],
  );
  if (!admin) throw missing();
  if (!admin.company_admin)
    throw new Problem(
      403,
      "forbidden",
      "Полки отделов создаёт администратор компании.",
    );
  const id = randomUUID();
  await c.query(
    `INSERT INTO tenants(id,owner_id,kind,name,created_by) VALUES($1,NULL,'team',$2,$3)`,
    [id, name, actor.id],
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
