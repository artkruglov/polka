import type { PoolClient } from "pg";
import type { Actor } from "./artifacts.ts";
import { config } from "./config.ts";
import { Problem, missing } from "./errors.ts";

/**
 * Lock the owner's tenant, then account. Mutations take FOR UPDATE; a
 * read-only path may pass "SHARE", which still queues behind (and rechecks
 * after) any transaction holding these rows FOR UPDATE — trash, disable,
 * deletion — without serializing readers against each other.
 */
export async function lockActiveOwnerTenant(
  c: PoolClient,
  actor: Actor,
  denied: () => Error = missing,
  lock: "UPDATE" | "SHARE" = "UPDATE",
) {
  const tenant = (
    await c.query(
      `SELECT * FROM tenants WHERE id=$1 AND owner_id=$2 FOR ${lock}`,
      [actor.tenant, actor.id],
    )
  ).rows[0];
  if (!tenant) throw denied();
  const account = (
    await c.query(
      `SELECT id FROM accounts
       WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL
       FOR ${lock}`,
      [actor.id],
    )
  ).rows[0];
  if (!account) throw denied();
  return tenant;
}

/**
 * The account may read this shelf: its own, or a department shelf it is an
 * active member of (any role; docs/specs/TEAM_SHELVES.md). On a personal
 * shelf the owner is its one member, so this is the owner check it was.
 */
export async function assertActiveOwner(
  c: Pick<PoolClient, "query">,
  actor: Actor,
) {
  const active = await c.query(
    `SELECT 1 FROM tenant_members member
     JOIN tenants tenant ON tenant.id=member.tenant_id
     JOIN accounts account ON account.id=member.account_id
     WHERE member.tenant_id=$1 AND member.account_id=$2 AND member.state='active'
       AND tenant.state='active' AND ($3::boolean OR tenant.kind='personal')
       AND NOT account.disabled AND account.deletion_requested_at IS NULL`,
    [actor.tenant, actor.id, config.TEAM_SHELVES === "on"],
  );
  if (!active.rowCount)
    throw new Problem(403, "forbidden", "Доступ к аккаунту закрыт.");
}
