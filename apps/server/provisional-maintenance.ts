// Maintenance of provisional shelves (docs/specs/SIGN_IN_PROVIDERS.md § 8):
// one nobody used for PROVISIONAL_IDLE_DAYS (no visit of its browser, no
// agent call, no save) is deleted through the ordinary account deletion
// pipeline, so its objects, metadata and backups follow the same erasure
// guarantees as a deletion the owner confirmed. No application config here:
// maintenance passes the deletion policy in.
import { createHash, randomBytes, randomUUID } from "node:crypto";

type Client = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows?: Array<Record<string, any>>; rowCount?: number | null }>;
};

export type ProvisionalRetirementPolicy = {
  idleDays: number;
  policyVersion: string;
  purgeMaxHours: number;
  backupRetentionMaxDays: number;
};

const IDLE = `a.provisional_at IS NOT NULL AND a.claimed_at IS NULL
  AND NOT a.disabled AND a.deletion_requested_at IS NULL
  AND a.provisional_at<now()-$1*interval '1 day'
  AND NOT EXISTS(SELECT 1 FROM sessions s
                  WHERE s.account_id=a.id AND s.expires_at>now())
  AND NOT EXISTS(SELECT 1 FROM agent_connections c
                  WHERE c.account_id=a.id
                    AND COALESCE(c.last_seen_at,c.created_at)>now()-$1*interval '1 day')
  AND NOT EXISTS(SELECT 1 FROM revisions r
                  WHERE r.tenant_id=t.id AND r.created_at>now()-$1*interval '1 day')`;

/** Provisional shelves idle long enough to delete, oldest first. */
export async function idleProvisionalShelves(
  c: Client,
  policy: Pick<ProvisionalRetirementPolicy, "idleDays">,
  limit = 20,
) {
  const { rows } = await c.query(
    `SELECT a.id,t.id AS tenant FROM accounts a
       JOIN tenants t ON t.owner_id=a.id
      WHERE ${IDLE}
      ORDER BY a.provisional_at LIMIT $2`,
    [policy.idleDays, limit],
  );
  return (rows ?? []) as Array<{ id: string; tenant: string }>;
}

/**
 * Requests deletion of one idle provisional shelf (in the caller's
 * transaction): the same steps as a confirmed deletion (account-deletion.ts),
 * and the purge worker takes it from there. False when it is no longer idle.
 */
export async function retireProvisionalShelf(
  c: Client,
  shelf: { id: string; tenant: string },
  policy: ProvisionalRetirementPolicy,
) {
  await c.query("SELECT 1 FROM tenants WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
    shelf.tenant,
    shelf.id,
  ]);
  const still = await c.query(
    `SELECT a.id FROM accounts a JOIN tenants t ON t.owner_id=a.id
      WHERE a.id=$2 AND ${IDLE} FOR UPDATE OF a`,
    [policy.idleDays, shelf.id],
  );
  if (!still.rows?.length) return false;
  const capability = createHash("sha256")
    .update(randomBytes(32))
    .digest("hex");
  const {
    rows: [planned] = [],
  } = await c.query(
    `INSERT INTO account_deletions(
       id,account_id,tenant_id,state,status_capability_hash,plan_expires_at,
       artifact_count,revision_count,source_bytes,derivative_bytes,
       policy_version,purge_max_hours,backup_retention_max_days)
     SELECT $1,$2,$3,'planned',$4,now()+interval '10 minutes',
            (SELECT count(*) FROM artifacts WHERE tenant_id=$3),
            (SELECT count(*) FROM revisions WHERE tenant_id=$3),
            t.used_bytes,t.derivative_used_bytes,$5,$6,$7
       FROM tenants t WHERE t.id=$3
     ON CONFLICT (account_id) DO UPDATE SET
       status_capability_hash=EXCLUDED.status_capability_hash,
       plan_expires_at=EXCLUDED.plan_expires_at,
       artifact_count=EXCLUDED.artifact_count,
       revision_count=EXCLUDED.revision_count,
       source_bytes=EXCLUDED.source_bytes,
       derivative_bytes=EXCLUDED.derivative_bytes,
       policy_version=EXCLUDED.policy_version,
       purge_max_hours=EXCLUDED.purge_max_hours,
       backup_retention_max_days=EXCLUDED.backup_retention_max_days,
       planned_at=clock_timestamp()
     WHERE account_deletions.state='planned'
     RETURNING id`,
    [
      randomUUID(),
      shelf.id,
      shelf.tenant,
      capability,
      policy.policyVersion,
      policy.purgeMaxHours,
      policy.backupRetentionMaxDays,
    ],
  );
  if (!planned) return false;
  const {
    rows: [{ now }] = [{ now: new Date() }],
  } = await c.query("SELECT clock_timestamp() AS now");
  await c.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=$2 WHERE id=$1",
    [shelf.id, now],
  );
  await c.query(
    "UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,$2) WHERE tenant_id=$1",
    [shelf.tenant, now],
  );
  await c.query(
    `UPDATE oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2)
      WHERE tenant_id=$1`,
    [shelf.tenant, now],
  );
  await c.query(
    `DELETE FROM viewer_grants viewer USING revisions revision
      WHERE viewer.revision_id=revision.id AND revision.tenant_id=$1`,
    [shelf.tenant],
  );
  await c.query(
    `DELETE FROM grants issued USING shares share
      WHERE issued.share_id=share.id AND share.tenant_id=$1`,
    [shelf.tenant],
  );
  await c.query("UPDATE shares SET revoked=true WHERE tenant_id=$1", [
    shelf.tenant,
  ]);
  await c.query(
    "UPDATE uploads SET aborted=true WHERE tenant_id=$1 AND receipt IS NULL",
    [shelf.tenant],
  );
  await c.query(
    `UPDATE revision_derivatives
        SET attempt_expires_at=LEAST(attempt_expires_at,$2),updated_at=$2
      WHERE tenant_id=$1 AND state='pending'`,
    [shelf.tenant, now],
  );
  await c.query(
    `INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id)
     VALUES($1,$2,'account.provisional_retired',$3)`,
    [shelf.tenant, shelf.id, planned.id],
  );
  await c.query(
    `UPDATE account_deletions SET
       state='access_revoked_pending_purge',
       requested_at=$2::timestamptz,revoked_at=$2::timestamptz,
       working_data_policy_deadline=$2::timestamptz+purge_max_hours*interval '1 hour',
       backup_retention_policy_deadline=$2::timestamptz+backup_retention_max_days*interval '1 day',
       confirmation_session_hash=$3
     WHERE id=$1`,
    [
      planned.id,
      now,
      createHash("sha256").update(randomBytes(32)).digest("hex"),
    ],
  );
  await c.query("DELETE FROM sessions WHERE account_id=$1", [shelf.id]);
  return true;
}

// Without the deletion pipeline (ACCOUNT_DELETION_ENABLED=false) maintenance
// deletes an idle provisional shelf itself, in three steps: close it (this
// transaction), delete every stored object under its tenant prefix, then
// delete its rows. A provisional shelf has no address, links, discussions,
// publications or identities by construction; one that somehow has any, or
// has blocked content (evidence), is only closed and left to the operator.

/** Step 1: close the shelf. False when it is no longer idle or not simple. */
export async function closeProvisionalShelf(
  c: Client,
  shelf: { id: string; tenant: string },
  idleDays: number,
) {
  await c.query("SELECT 1 FROM tenants WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
    shelf.tenant,
    shelf.id,
  ]);
  const still = await c.query(
    `SELECT a.id,
            (a.email IS NULL
             AND NOT EXISTS(SELECT 1 FROM shares WHERE tenant_id=t.id)
             AND NOT EXISTS(SELECT 1 FROM comments WHERE author_account_id=a.id)
             AND NOT EXISTS(SELECT 1 FROM comment_reactions WHERE author_account_id=a.id)
             AND NOT EXISTS(SELECT 1 FROM moderation_blocks WHERE tenant_id=t.id)
             AND NOT EXISTS(SELECT 1 FROM editorial_publications WHERE tenant_id=t.id)
             AND NOT EXISTS(SELECT 1 FROM template_library_members WHERE account_id=a.id)
             AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE account_id=a.id)
            ) AS simple
       FROM accounts a JOIN tenants t ON t.owner_id=a.id
      WHERE a.id=$2 AND ${IDLE} FOR UPDATE OF a`,
    [idleDays, shelf.id],
  );
  const row = still.rows?.[0];
  if (!row) return { closed: false, erase: false };
  const {
    rows: [{ now }] = [{ now: new Date() }],
  } = await c.query("SELECT clock_timestamp() AS now");
  await c.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=$2 WHERE id=$1",
    [shelf.id, now],
  );
  await c.query(
    "UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,$2) WHERE tenant_id=$1",
    [shelf.tenant, now],
  );
  await c.query(
    "UPDATE oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE tenant_id=$1",
    [shelf.tenant, now],
  );
  await c.query(
    "UPDATE uploads SET aborted=true WHERE tenant_id=$1 AND receipt IS NULL",
    [shelf.tenant],
  );
  await c.query("DELETE FROM sessions WHERE account_id=$1", [shelf.id]);
  return { closed: true, erase: !!row.simple };
}

/** Step 3 (after the objects are gone): the shelf's rows. */
export async function eraseProvisionalShelfRows(
  c: Client,
  shelf: { id: string; tenant: string },
) {
  await c.query("SELECT 1 FROM tenants WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
    shelf.tenant,
    shelf.id,
  ]);
  for (const sql of [
    "DELETE FROM agent_operations WHERE tenant_id=$1",
    "DELETE FROM url_import_jobs WHERE tenant_id=$1",
    "DELETE FROM oauth_refresh_tokens WHERE tenant_id=$1",
    "DELETE FROM oauth_authorizations WHERE tenant_id=$1",
    "DELETE FROM audit_outbox WHERE tenant_id=$1",
    "DELETE FROM upload_files f USING uploads u WHERE u.id=f.upload_id AND u.tenant_id=$1",
    "DELETE FROM uploads WHERE tenant_id=$1",
    "DELETE FROM agent_connections WHERE tenant_id=$1",
    `DELETE FROM viewer_grants v USING revisions r
      WHERE v.revision_id=r.id AND r.tenant_id=$1`,
    "UPDATE artifacts SET latest_revision_id=NULL WHERE tenant_id=$1",
    "DELETE FROM revision_derivatives WHERE tenant_id=$1",
    "DELETE FROM revision_files f USING revisions r WHERE r.id=f.revision_id AND r.tenant_id=$1",
    "DELETE FROM revisions WHERE tenant_id=$1",
    "DELETE FROM artifacts WHERE tenant_id=$1",
    "DELETE FROM folders WHERE tenant_id=$1",
    "UPDATE tenants SET used_bytes=0,derivative_used_bytes=0 WHERE id=$1",
  ])
    await c.query(sql, [shelf.tenant]);
}
