import type { PoolClient } from "pg";
import type { Actor } from "./artifacts.ts";
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

export async function assertActiveOwner(
  c: Pick<PoolClient, "query">,
  actor: Actor,
) {
  const active = await c.query(
    `SELECT 1 FROM tenants tenant
     JOIN accounts account ON account.id=tenant.owner_id
     WHERE tenant.id=$1 AND tenant.owner_id=$2
       AND NOT account.disabled AND account.deletion_requested_at IS NULL`,
    [actor.tenant, actor.id],
  );
  if (!active.rowCount)
    throw new Problem(403, "forbidden", "Доступ к аккаунту закрыт.");
}
