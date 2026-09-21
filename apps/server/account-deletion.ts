import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { audit, type Actor } from "./artifacts.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { withdrawEditorialForDeletionInTransaction } from "./editorial.ts";
import { Problem, missing } from "./errors.ts";
import { limitAttempts } from "./auth.ts";
import { sha256 } from "./storage.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const uuid = z.string().uuid();

export type AccountDeletionReceipt = {
  requestId: string;
  state: "planned" | "access_revoked_pending_purge" | "failed" | "purged";
  requestedAt: string | null;
  revokedAt: string | null;
  workingDataPolicyDeadline: string | null;
  backupRetentionPolicyDeadline: string | null;
  policyVersion: string;
  purgeAvailable: false;
};

export const confirmAccountDeletionSchema = z
  .object({
    planId: uuid,
    expectedAccountId: uuid,
    expectedTenantId: uuid,
    confirmation: z.literal("DELETE"),
  })
  .strict();

const unavailable = () =>
  new Problem(
    503,
    "invalid",
    "Удаление аккаунта не включено на этой локальной установке.",
  );
const forbidden = () =>
  new Problem(403, "forbidden", "Проверка запроса истекла.");

function requireEnabled() {
  if (!config.ACCOUNT_DELETION_ENABLED) throw unavailable();
}

async function lockTenantAccount(c: PoolClient, actor: Actor) {
  const tenant = (
    await c.query(
      "SELECT * FROM tenants WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [actor.tenant, actor.id],
    )
  ).rows[0];
  if (!tenant) throw missing();
  const account = (
    await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [actor.id])
  ).rows[0];
  if (!account) throw missing();
  return { tenant, account };
}

async function validateSessionCsrf(
  c: PoolClient,
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
) {
  if (!TOKEN.test(sessionToken) || !TOKEN.test(csrfToken)) throw forbidden();
  const sessionHash = sha256(sessionToken);
  const valid = await c.query(
    `SELECT 1 FROM sessions session
     JOIN account_deletion_csrf csrf ON csrf.session_hash=session.hash
     WHERE session.hash=$1 AND session.account_id=$2 AND session.expires_at>now()
       AND csrf.token_hash=$3 AND csrf.expires_at>now()`,
    [sessionHash, actor.id, sha256(csrfToken)],
  );
  if (!valid.rowCount) throw forbidden();
  return sessionHash;
}

const receipt = (row: any): AccountDeletionReceipt => ({
  requestId: row.id,
  state: row.state,
  requestedAt: row.requested_at
    ? new Date(row.requested_at).toISOString()
    : null,
  revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  workingDataPolicyDeadline: row.working_data_policy_deadline
    ? new Date(row.working_data_policy_deadline).toISOString()
    : null,
  backupRetentionPolicyDeadline: row.backup_retention_policy_deadline
    ? new Date(row.backup_retention_policy_deadline).toISOString()
    : null,
  policyVersion: row.policy_version,
  purgeAvailable: false as const,
});

const plan = (row: any, statusCapability: string | null) => ({
  planId: row.id,
  expectedAccountId: row.account_id,
  expectedTenantId: row.tenant_id,
  expiresAt: new Date(row.plan_expires_at).toISOString(),
  counts: {
    artifacts: Number(row.artifact_count),
    revisions: Number(row.revision_count),
    sourceBytes: Number(row.source_bytes),
    derivativeBytes: Number(row.derivative_bytes),
  },
  provisionalPolicy: {
    purgeMaxHours: Number(row.purge_max_hours),
    backupRetentionMaxDays: Number(row.backup_retention_max_days),
    policyVersion: row.policy_version,
  },
  statusCapability,
  purgeAvailable: false as const,
});

export async function issueAccountDeletionCsrf(
  actor: Actor,
  sessionToken: string,
) {
  requireEnabled();
  if (!TOKEN.test(sessionToken)) throw forbidden();
  const csrfToken = randomBytes(32).toString("base64url");
  const row = (
    await db.query(
      `INSERT INTO account_deletion_csrf(session_hash,token_hash,expires_at)
       SELECT session.hash,$3,now()+interval '10 minutes'
       FROM sessions session
       JOIN accounts account ON account.id=session.account_id
       JOIN tenants tenant ON tenant.owner_id=account.id
       WHERE session.hash=$1 AND session.account_id=$2 AND tenant.id=$4
         AND session.expires_at>now() AND NOT account.disabled
         AND account.deletion_requested_at IS NULL
       ON CONFLICT(session_hash) DO UPDATE
         SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,
             created_at=clock_timestamp()
       RETURNING expires_at`,
      [sha256(sessionToken), actor.id, sha256(csrfToken), actor.tenant],
    )
  ).rows[0];
  if (!row) throw forbidden();
  return { csrfToken, expiresAt: new Date(row.expires_at).toISOString() };
}

export async function createAccountDeletionPlan(
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
) {
  requireEnabled();
  const statusCapability = randomBytes(32).toString("base64url");
  return transaction(async (c) => {
    const { tenant, account } = await lockTenantAccount(c, actor);
    if (account.disabled || account.deletion_requested_at) throw missing();
    await validateSessionCsrf(c, actor, sessionToken, csrfToken);
    const old = (
      await c.query(
        "SELECT * FROM account_deletions WHERE account_id=$1 FOR UPDATE",
        [actor.id],
      )
    ).rows[0];
    if (old && old.state !== "planned") return receipt(old);
    const counts = (
      await c.query(
        `SELECT
           (SELECT count(*) FROM artifacts WHERE tenant_id=$1) AS artifacts,
           (SELECT count(*) FROM revisions WHERE tenant_id=$1) AS revisions`,
        [actor.tenant],
      )
    ).rows[0];
    const id = randomUUID();
    const values = [
      id,
      actor.id,
      actor.tenant,
      sha256(statusCapability),
      Number(counts.artifacts),
      Number(counts.revisions),
      Number(tenant.used_bytes),
      Number(tenant.derivative_used_bytes),
      config.ACCOUNT_DELETION_POLICY_VERSION!,
      config.ACCOUNT_PURGE_MAX_HOURS!,
      config.BACKUP_RETENTION_MAX_DAYS!,
    ];
    const row = old
      ? (
          await c.query(
            `UPDATE account_deletions SET
               id=$1,status_capability_hash=$4,plan_expires_at=now()+interval '10 minutes',
               artifact_count=$5,revision_count=$6,source_bytes=$7,
               derivative_bytes=$8,policy_version=$9,purge_max_hours=$10,
               backup_retention_max_days=$11,planned_at=clock_timestamp()
             WHERE account_id=$2 AND tenant_id=$3 RETURNING *`,
            values,
          )
        ).rows[0]
      : (
          await c.query(
            `INSERT INTO account_deletions(
               id,account_id,tenant_id,state,status_capability_hash,
               plan_expires_at,artifact_count,revision_count,source_bytes,
               derivative_bytes,policy_version,purge_max_hours,
               backup_retention_max_days
             ) VALUES($1,$2,$3,'planned',$4,now()+interval '10 minutes',
               $5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            values,
          )
        ).rows[0];
    return plan(row, statusCapability);
  });
}

export async function confirmAccountDeletion(
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
  body: unknown,
) {
  requireEnabled();
  const input = confirmAccountDeletionSchema.parse(body);
  if (
    input.expectedAccountId !== actor.id ||
    input.expectedTenantId !== actor.tenant
  )
    throw missing();
  const sessionHash = sha256(sessionToken);
  return transaction(async (c) => {
    const { account } = await lockTenantAccount(c, actor);
    const deletion = (
      await c.query(
        "SELECT * FROM account_deletions WHERE account_id=$1 FOR UPDATE",
        [actor.id],
      )
    ).rows[0];
    if (!deletion || deletion.id !== input.planId)
      throw new Problem(409, "conflict", "План удаления был заменён.");
    if (deletion.state !== "planned") {
      if (deletion.confirmation_session_hash !== sessionHash) throw missing();
      return receipt(deletion);
    }
    if (
      account.disabled ||
      account.deletion_requested_at ||
      new Date(deletion.plan_expires_at).getTime() <= Date.now()
    )
      throw new Problem(409, "conflict", "План удаления истёк.");
    await validateSessionCsrf(c, actor, sessionToken, csrfToken);

    await c.query(
      "SELECT id FROM agent_connections WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );
    await c.query(
      "SELECT id FROM uploads WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );
    await c.query(
      "SELECT id FROM artifacts WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );
    await c.query(
      "SELECT id FROM shares WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );
    await c.query(
      "SELECT id FROM revision_derivatives WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );
    await c.query(
      "SELECT id FROM editorial_publications WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );

    const now = (await c.query("SELECT clock_timestamp() AS value")).rows[0]
      .value;
    await c.query(
      `UPDATE accounts SET disabled=true,deletion_requested_at=$2
       WHERE id=$1`,
      [actor.id, now],
    );
    await c.query(
      `UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,$2)
       WHERE tenant_id=$1`,
      [actor.tenant, now],
    );
    await c.query(
      `DELETE FROM viewer_grants viewer
       USING revisions revision
       WHERE viewer.revision_id=revision.id AND revision.tenant_id=$1`,
      [actor.tenant],
    );
    await c.query(
      `DELETE FROM grants issued
       USING shares share
       WHERE issued.share_id=share.id AND share.tenant_id=$1`,
      [actor.tenant],
    );
    await withdrawEditorialForDeletionInTransaction(c, actor);
    await c.query("UPDATE shares SET revoked=true WHERE tenant_id=$1", [
      actor.tenant,
    ]);
    await c.query(
      `UPDATE uploads SET aborted=true
       WHERE tenant_id=$1 AND receipt IS NULL`,
      [actor.tenant],
    );
    await c.query(
      `UPDATE revision_derivatives
       SET attempt_expires_at=LEAST(attempt_expires_at,$2),updated_at=$2
       WHERE tenant_id=$1 AND state='pending'`,
      [actor.tenant, now],
    );
    await audit(c, actor, "account.deletion.requested", deletion.id);
    const updated = (
      await c.query(
        `UPDATE account_deletions SET
           state='access_revoked_pending_purge',
           requested_at=$2::timestamptz,revoked_at=$2::timestamptz,
           working_data_policy_deadline=$2::timestamptz+purge_max_hours*interval '1 hour',
           backup_retention_policy_deadline=$2::timestamptz+backup_retention_max_days*interval '1 day',
           confirmation_session_hash=$3
         WHERE id=$1 RETURNING *`,
        [deletion.id, now, sessionHash],
      )
    ).rows[0];
    await c.query("DELETE FROM sessions WHERE account_id=$1", [actor.id]);
    return receipt(updated);
  });
}

export async function accountDeletionStatus(capability: string, ip: string) {
  if (!TOKEN.test(capability)) throw missing();
  const hash = sha256(capability);
  await limitAttempts(`account-deletion-status-ip:${ip}`, 120);
  await limitAttempts(`account-deletion-status:${hash}`, 60);
  const row = (
    await db.query(
      "SELECT * FROM account_deletions WHERE status_capability_hash=$1",
      [hash],
    )
  ).rows[0];
  if (!row) throw missing();
  return receipt(row);
}
