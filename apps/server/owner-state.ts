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

/**
 * Lock a link's shelf and the account that answers for it, and tell whether
 * both are active: a personal shelf and its owner, or a department shelf and
 * the link's issuer (who need not be a member any more: the link is the
 * company's). Stricter moderation still applies to an inactive one; nothing
 * of theirs is released.
 */
export async function lockAnsweringAccount(
  c: PoolClient,
  answering: { id: string; tenant: string },
  lock: "UPDATE" | "SHARE" = "UPDATE",
) {
  const tenant = (
    await c.query(
      `SELECT kind,owner_id FROM tenants WHERE id=$1 AND ${linkShelfOpenSql("tenants")} FOR ${lock}`,
      [answering.tenant],
    )
  ).rows[0];
  if (!tenant || (tenant.kind === "personal" && tenant.owner_id !== answering.id)) return false;
  const account = await c.query(
    `SELECT 1 FROM accounts WHERE id=$1 AND NOT disabled
       AND deletion_requested_at IS NULL FOR ${lock}`,
    [answering.id],
  );
  return !!account.rowCount;
}

/**
 * The account that answers for a link (docs/specs/TEAM_SHELVES.md, stage 5):
 * a personal shelf's owner, else — on a department shelf, which has none —
 * the member who issued it (shares.created_by, migration 048). Its standing
 * is what moderation weighs, it gets the letters, and disabling it closes
 * the link.
 */
export const answeringAccountSql = (tenant = "tenant", share = "share") =>
  `COALESCE(${tenant}.owner_id,${share}.created_by)`;

/** Links out of department shelves open only while TEAM_SHELVES is on. */
export const linkShelfOpenSql = (tenant = "tenant") =>
  config.TEAM_SHELVES === "on"
    ? `${tenant}.state='active'`
    : `${tenant}.state='active' AND ${tenant}.kind='personal'`;
