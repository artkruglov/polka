// Members of a department shelf (docs/specs/TEAM_SHELVES.md, stage 2). An
// admin adds a colleague who already signs in to Полка by address or login,
// changes roles and removes members; a member may leave. A shelf always keeps
// an active admin, as template libraries do. Every change goes to the
// shelf's journal (tenant_member_events).
//
// Lock order: the shelf, then the accounts involved by id, then their
// memberships by account — lockShelf's order (shelf, account, membership).
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { teamShelfNameSchema, type ShelfRole } from "./shelves.ts";
import { config } from "./config.ts";
import { emitEvent } from "./extensions.ts";

type Actor = { id: string };

export const TEAM_ROLES = ["reader", "author", "curator", "admin"] as const;
const roleSchema = z.enum(TEAM_ROLES);

const addInput = z
  .object({
    who: z.string().trim().min(1, "Укажите почту или логин.").max(320),
    role: roleSchema.default("author"),
  })
  .strict();

async function lockTeamShelf(c: PoolClient, shelfId: string) {
  if (config.TEAM_SHELVES !== "on") throw missing();
  const {
    rows: [shelf],
  } = await c.query(
    `SELECT id,name FROM tenants WHERE id=$1 AND kind='team' AND state='active' FOR UPDATE`,
    [shelfId],
  );
  if (!shelf) throw missing();
  return shelf as { id: string; name: string };
}

/** Locks the accounts by id and returns the active ones. */
async function lockAccounts(c: PoolClient, ids: string[]) {
  const { rows } = await c.query(
    `SELECT id FROM accounts WHERE id=ANY($1::uuid[])
       AND NOT disabled AND deletion_requested_at IS NULL
     ORDER BY id FOR UPDATE`,
    [[...new Set(ids)]],
  );
  return new Set(rows.map((row) => row.id as string));
}

async function lockMemberships(c: PoolClient, shelfId: string, ids: string[]) {
  const { rows } = await c.query(
    `SELECT account_id,role,state FROM tenant_members
     WHERE tenant_id=$1 AND account_id=ANY($2::uuid[])
     ORDER BY account_id FOR UPDATE`,
    [shelfId, [...new Set(ids)]],
  );
  return new Map(rows.map((row) => [row.account_id as string, row]));
}

/** The actor's active role, or «not found» for anyone who is not a member. */
function roleOf(
  memberships: Map<string, { role: ShelfRole; state: string }>,
  active: Set<string>,
  actorId: string,
) {
  const member = memberships.get(actorId);
  if (!active.has(actorId) || !member || member.state !== "active") throw missing();
  return member.role;
}

const adminOnly = (role: ShelfRole) => {
  if (role !== "admin")
    throw new Problem(403, "forbidden", "Участниками полки управляет её администратор.");
};

async function ensureAnotherAdmin(c: PoolClient, shelfId: string, accountId: string) {
  const { rowCount } = await c.query(
    `SELECT 1 FROM tenant_members member
     JOIN accounts account ON account.id=member.account_id
     WHERE member.tenant_id=$1 AND member.account_id<>$2
       AND member.role='admin' AND member.state='active'
       AND NOT account.disabled AND account.deletion_requested_at IS NULL
     LIMIT 1`,
    [shelfId, accountId],
  );
  if (!rowCount)
    throw new Problem(
      409,
      "conflict",
      "На полке должен остаться администратор. Сначала назначьте другого.",
    );
}

const event = (
  c: PoolClient,
  shelfId: string,
  actor: Actor,
  action: string,
  target: string | null,
  oldRole: string | null,
  newRole: string | null,
) =>
  c.query(
    `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role,new_role)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [shelfId, actor.id, action, target, oldRole, newRole],
  );

/** Everyone on the shelf; any member sees who else is there. */
export async function listShelfMembers(actor: Actor, shelfId: string) {
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id]);
    const role = roleOf(await lockMemberships(c, shelfId, [actor.id]), active, actor.id);
    const { rows } = await c.query(
      `SELECT member.account_id AS "accountId",
              COALESCE(account.display_name,account.name) AS name,
              CASE WHEN $2 THEN account.email END AS email,
              member.role,member.joined_at AS "joinedAt"
       FROM tenant_members member
       JOIN accounts account ON account.id=member.account_id
       WHERE member.tenant_id=$1 AND member.state='active'
         AND NOT account.disabled AND account.deletion_requested_at IS NULL
       ORDER BY lower(COALESCE(account.display_name,account.name)),member.account_id
       LIMIT 1001`,
      [shelfId, role === "admin"],
    );
    return { role, items: rows.slice(0, 1000), hasMore: rows.length > 1000 };
  });
}

/**
 * An admin adds a colleague by address or login. Within one company's
 * installation every account is a colleague, so the member is added at once;
 * someone who has never signed in is not found yet.
 */
export async function addShelfMember(actor: Actor, shelfId: string, body: unknown) {
  const input = addInput.parse(body);
  const who = input.who.toLowerCase();
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    // Only the shelf's admin may look people up: nobody else learns from the
    // answer which addresses and logins exist. Rechecked under lock below.
    const {
      rows: [asker],
    } = await c.query(
      "SELECT role FROM tenant_members WHERE tenant_id=$1 AND account_id=$2 AND state='active'",
      [shelfId, actor.id],
    );
    if (!asker) throw missing();
    adminOnly(asker.role);
    const found = await c.query(
      `SELECT id,COALESCE(display_name,name) AS name FROM accounts
       WHERE (email=$1 OR lower(name)=$1)
         AND NOT disabled AND deletion_requested_at IS NULL
       LIMIT 2`,
      [who],
    );
    if (found.rows.length !== 1)
      throw new Problem(
        404,
        "not_found",
        "Такого сотрудника нет в Полке. Пусть он один раз войдёт, затем добавьте его снова.",
      );
    const target = found.rows[0] as { id: string; name: string };
    const active = await lockAccounts(c, [actor.id, target.id]);
    const memberships = await lockMemberships(c, shelfId, [actor.id, target.id]);
    adminOnly(roleOf(memberships, active, actor.id));
    if (!active.has(target.id)) throw missing();
    const existing = memberships.get(target.id);
    if (existing?.state === "active")
      throw new Problem(409, "conflict", `${target.name} уже на этой полке.`);
    await c.query(
      `INSERT INTO tenant_members(tenant_id,account_id,role,invited_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (tenant_id,account_id) DO UPDATE
         SET role=EXCLUDED.role,state='active',revoked_at=NULL,
             joined_at=now(),invited_by=EXCLUDED.invited_by`,
      [shelfId, target.id, input.role, actor.id],
    );
    await event(c, shelfId, actor, "member_added", target.id, null, input.role);
    return { accountId: target.id, name: target.name, role: input.role };
  });
}

export async function changeShelfMemberRole(
  actor: Actor,
  shelfId: string,
  accountId: string,
  body: unknown,
) {
  const { role } = z.object({ role: roleSchema }).strict().parse(body);
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id, accountId]);
    const memberships = await lockMemberships(c, shelfId, [actor.id, accountId]);
    adminOnly(roleOf(memberships, active, actor.id));
    const target = memberships.get(accountId);
    if (!target || target.state !== "active") throw missing();
    if (target.role === role) return { accountId, role };
    if (target.role === "admin") await ensureAnotherAdmin(c, shelfId, accountId);
    await c.query(
      "UPDATE tenant_members SET role=$3 WHERE tenant_id=$1 AND account_id=$2",
      [shelfId, accountId, role],
    );
    await event(c, shelfId, actor, "member_role_changed", accountId, target.role, role);
    return { accountId, role };
  });
}

/** An admin removes a member, or a member leaves. The works stay on the shelf. */
export async function revokeShelfMember(actor: Actor, shelfId: string, accountId: string) {
  const result = await revokeShelfMemberInTransaction(actor, shelfId, accountId);
  if (result.revoked)
    emitEvent({ type: "member.revoked", tenantId: shelfId, accountId, at: new Date().toISOString() });
  return { ok: true };
}

async function revokeShelfMemberInTransaction(actor: Actor, shelfId: string, accountId: string) {
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id, accountId]);
    const memberships = await lockMemberships(c, shelfId, [actor.id, accountId]);
    const role = roleOf(memberships, active, actor.id);
    if (accountId !== actor.id) adminOnly(role);
    const target = memberships.get(accountId);
    if (!target) throw missing();
    if (target.state !== "active") return { ok: true, revoked: false };
    if (target.role === "admin") await ensureAnotherAdmin(c, shelfId, accountId);
    await c.query(
      `UPDATE tenant_members SET state='revoked',revoked_at=clock_timestamp()
       WHERE tenant_id=$1 AND account_id=$2`,
      [shelfId, accountId],
    );
    await event(c, shelfId, actor, "member_revoked", accountId, target.role, null);
    return { ok: true, revoked: true };
  });
}

export async function renameShelf(actor: Actor, shelfId: string, body: unknown) {
  const { name: raw } = z.object({ name: z.string().max(200) }).strict().parse(body);
  const name = teamShelfNameSchema.parse(raw);
  return transaction(async (c) => {
    const shelf = await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id]);
    adminOnly(roleOf(await lockMemberships(c, shelfId, [actor.id]), active, actor.id));
    if (shelf.name === name) return { id: shelfId, name };
    await c.query("UPDATE tenants SET name=$2 WHERE id=$1", [shelfId, name]);
    await event(c, shelfId, actor, "shelf_renamed", null, null, null);
    return { id: shelfId, name };
  });
}

/** The shelf's journal, newest first; for its admins. */
export async function listShelfEvents(actor: Actor, shelfId: string) {
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id]);
    adminOnly(roleOf(await lockMemberships(c, shelfId, [actor.id]), active, actor.id));
    const { rows } = await c.query(
      `SELECT event.id::text,event.action,event.old_role AS "oldRole",event.new_role AS "newRole",
              event.created_at AS "createdAt",
              COALESCE(actor.display_name,actor.name) AS "actorName",
              COALESCE(target.display_name,target.name) AS "targetName"
       FROM tenant_member_events event
       LEFT JOIN accounts actor ON actor.id=event.actor_id
       LEFT JOIN accounts target ON target.id=event.target_account_id
       WHERE event.tenant_id=$1
       ORDER BY event.id DESC LIMIT 100`,
      [shelfId],
    );
    return { items: rows };
  });
}
