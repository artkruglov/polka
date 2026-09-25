// The company admin's page (docs/specs/TEAM_SHELVES.md, stage 4): every
// department shelf with its members, and taking a leaving employee off all of
// them at once. Their memberships end (and with them their agents on those
// shelves, migration 045); the works stay with the shelves. Signing in is the
// company's SSO's business: this does not close the account.
//
// Only an account with accounts.company_admin, while TEAM_SHELVES is on; for
// anyone else these routes do not exist (404).
//
// Lock order: the shelves by id, then the accounts by id, then memberships —
// the order of shelf-members.ts and lockShelf.
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";

type Actor = { id: string };

async function assertCompanyAdmin(c: Pick<PoolClient, "query">, actor: Actor) {
  if (config.TEAM_SHELVES !== "on") throw missing();
  const { rowCount } = await c.query(
    `SELECT 1 FROM accounts WHERE id=$1 AND company_admin
       AND NOT disabled AND deletion_requested_at IS NULL`,
    [actor.id],
  );
  if (!rowCount) throw missing();
}

/** Every active department shelf: members, works, who administers it. */
export async function listCompanyShelves(actor: Actor) {
  await assertCompanyAdmin(db, actor);
  const { rows } = await db.query(
    `SELECT tenant.id,tenant.name,tenant.created_at AS "createdAt",
            (SELECT count(*)::int FROM tenant_members m
              WHERE m.tenant_id=tenant.id AND m.state='active') AS members,
            (SELECT count(*)::int FROM artifacts a
              WHERE a.tenant_id=tenant.id AND a.trashed_at IS NULL) AS works,
            COALESCE((SELECT array_agg(COALESCE(acc.display_name,acc.name) ORDER BY lower(COALESCE(acc.display_name,acc.name)))
               FROM tenant_members m JOIN accounts acc ON acc.id=m.account_id
              WHERE m.tenant_id=tenant.id AND m.state='active' AND m.role='admin'),
              '{}') AS admins
     FROM tenants tenant
     WHERE tenant.kind='team' AND tenant.state='active'
     ORDER BY lower(tenant.name),tenant.id
     LIMIT 500`,
  );
  return { items: rows };
}

/** One shelf's members, for a company admin who need not be on it. */
export async function listCompanyShelfMembers(actor: Actor, shelfId: string) {
  await assertCompanyAdmin(db, actor);
  const { rows } = await db.query(
    `SELECT member.account_id AS "accountId",
            COALESCE(account.display_name,account.name) AS name,
            account.email,member.role,member.joined_at AS "joinedAt"
     FROM tenants tenant
     JOIN tenant_members member ON member.tenant_id=tenant.id AND member.state='active'
     JOIN accounts account ON account.id=member.account_id
     WHERE tenant.id=$1 AND tenant.kind='team' AND tenant.state='active'
     ORDER BY lower(COALESCE(account.display_name,account.name)),member.account_id
     LIMIT 1000`,
    [shelfId],
  );
  return { items: rows };
}

const whoSchema = z.object({ who: z.string().trim().min(1).max(320) });

/** An employee by address or login, and the department shelves they are on. */
export async function findEmployee(actor: Actor, query: unknown) {
  await assertCompanyAdmin(db, actor);
  const who = whoSchema.parse(query).who.toLowerCase();
  const { rows: found } = await db.query(
    `SELECT id,COALESCE(display_name,name) AS name,email,disabled,
            deletion_requested_at IS NOT NULL AS leaving
     FROM accounts WHERE email=$1 OR lower(name)=$1 LIMIT 2`,
    [who],
  );
  if (found.length !== 1) throw missing();
  const person = found[0];
  const { rows: shelves } = await db.query(
    `SELECT tenant.id,tenant.name,member.role
     FROM tenant_members member JOIN tenants tenant ON tenant.id=member.tenant_id
     WHERE member.account_id=$1 AND member.state='active'
       AND tenant.kind='team' AND tenant.state='active'
     ORDER BY lower(tenant.name)`,
    [person.id],
  );
  const {
    rows: [agents],
  } = await db.query(
    `SELECT count(*)::int AS count FROM agent_connections connection
     JOIN tenants tenant ON tenant.id=connection.tenant_id AND tenant.kind='team'
     WHERE connection.account_id=$1 AND connection.parent_id IS NULL
       AND connection.revoked_at IS NULL AND connection.expires_at>now()`,
    [person.id],
  );
  return {
    accountId: person.id,
    name: person.name,
    email: person.email,
    disabled: person.disabled || person.leaving,
    shelves,
    teamAgents: agents.count,
  };
}

/**
 * Takes an employee off every department shelf. Where they were the last
 * admin, the company admin takes that role first, so no shelf is left
 * without one. Idempotent: someone already off every shelf gets an empty list.
 */
export async function offboardEmployee(actor: Actor, accountId: string) {
  if (accountId === actor.id)
    throw new Problem(
      409,
      "conflict",
      "Себя так убрать нельзя: сначала назначьте другого администратора компании.",
    );
  return transaction(async (c) => {
    await assertCompanyAdmin(c, actor);
    const { rows: candidates } = await c.query(
      `SELECT member.tenant_id FROM tenant_members member
       JOIN tenants tenant ON tenant.id=member.tenant_id AND tenant.kind='team'
       WHERE member.account_id=$1 AND member.state='active'`,
      [accountId],
    );
    const shelfIds = candidates.map((row) => row.tenant_id as string);
    if (!shelfIds.length) return { removed: [] as { id: string; name: string; role: string }[] };
    const { rows: shelves } = await c.query(
      `SELECT id,name FROM tenants WHERE id=ANY($1::uuid[]) AND kind='team'
       ORDER BY id FOR UPDATE`,
      [shelfIds],
    );
    await c.query(
      "SELECT id FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [[...new Set([actor.id, accountId])]],
    );
    await assertCompanyAdmin(c, actor);
    const removed: { id: string; name: string; role: string }[] = [];
    for (const shelf of shelves) {
      const { rows: members } = await c.query(
        `SELECT account_id,role,state FROM tenant_members
         WHERE tenant_id=$1 AND account_id=ANY($2::uuid[])
         ORDER BY account_id FOR UPDATE`,
        [shelf.id, [...new Set([actor.id, accountId])]],
      );
      const target = members.find((row) => row.account_id === accountId);
      if (!target || target.state !== "active") continue;
      if (target.role === "admin" && accountId !== actor.id) {
        const { rowCount } = await c.query(
          `SELECT 1 FROM tenant_members member
           JOIN accounts account ON account.id=member.account_id
           WHERE member.tenant_id=$1 AND member.account_id<>$2
             AND member.role='admin' AND member.state='active'
             AND NOT account.disabled AND account.deletion_requested_at IS NULL
           LIMIT 1`,
          [shelf.id, accountId],
        );
        if (!rowCount) {
          const mine = members.find((row) => row.account_id === actor.id);
          await c.query(
            `INSERT INTO tenant_members(tenant_id,account_id,role,invited_by)
             VALUES($1,$2,'admin',$2)
             ON CONFLICT (tenant_id,account_id) DO UPDATE
               SET role='admin',state='active',revoked_at=NULL,
                   joined_at=CASE WHEN tenant_members.state='active'
                                  THEN tenant_members.joined_at ELSE now() END`,
            [shelf.id, actor.id],
          );
          await c.query(
            `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role,new_role)
             VALUES($1,$2,$3,$2,$4,'admin')`,
            [
              shelf.id,
              actor.id,
              mine?.state === "active" ? "member_role_changed" : "member_added",
              mine?.state === "active" ? mine.role : null,
            ],
          );
        }
      }
      await c.query(
        `UPDATE tenant_members SET state='revoked',revoked_at=clock_timestamp()
         WHERE tenant_id=$1 AND account_id=$2`,
        [shelf.id, accountId],
      );
      await c.query(
        `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role)
         VALUES($1,$2,'member_revoked',$3,$4)`,
        [shelf.id, actor.id, accountId, target.role],
      );
      removed.push({ id: shelf.id, name: shelf.name, role: target.role });
    }
    return { removed };
  });
}

/**
 * The company admin becomes an admin of a department shelf: for a shelf left
 * without one (its admin left through the SSO without being taken off), or to
 * look after it. Recorded in the shelf's journal.
 */
export async function adminCompanyShelf(actor: Actor, shelfId: string) {
  return transaction(async (c) => {
    await assertCompanyAdmin(c, actor);
    const {
      rows: [shelf],
    } = await c.query(
      `SELECT id,name FROM tenants WHERE id=$1 AND kind='team' AND state='active' FOR UPDATE`,
      [shelfId],
    );
    if (!shelf) throw missing();
    await c.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [actor.id]);
    const {
      rows: [mine],
    } = await c.query(
      "SELECT role,state FROM tenant_members WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE",
      [shelfId, actor.id],
    );
    if (mine?.state === "active" && mine.role === "admin") return { id: shelf.id, name: shelf.name, role: "admin" };
    await c.query(
      `INSERT INTO tenant_members(tenant_id,account_id,role,invited_by)
       VALUES($1,$2,'admin',$2)
       ON CONFLICT (tenant_id,account_id) DO UPDATE
         SET role='admin',state='active',revoked_at=NULL,
             joined_at=CASE WHEN tenant_members.state='active'
                            THEN tenant_members.joined_at ELSE now() END`,
      [shelfId, actor.id],
    );
    await c.query(
      `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role,new_role)
       VALUES($1,$2,$3,$2,$4,'admin')`,
      [shelfId, actor.id, mine?.state === "active" ? "member_role_changed" : "member_added", mine?.state === "active" ? mine.role : null],
    );
    return { id: shelf.id, name: shelf.name, role: "admin" };
  });
}
