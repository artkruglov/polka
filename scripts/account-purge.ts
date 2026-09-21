import { randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import type { ErasureRecord, PurgedRecord, RevokeRecord } from "../packages/erasure-ledger.ts";
import {
  appendErasureRecord,
  ErasureLedgerAdapterError,
  type ErasureLedgerTransport,
} from "./erasure-ledger-adapter.ts";
import type {
  MaintenanceObjectStore,
  MaintenanceScope,
} from "./maintenance-cleanup.ts";

const uuid = z.string().uuid();
const phase = z.enum([
  "awaiting_revoke_ledger",
  "deleting_source",
  "source_empty",
  "metadata_purged",
]);
const mailSnapshot = z.object({
  account_email: z.string().nullable(),
  challenges: z.array(
    z.object({ id: uuid, delivery: z.enum(["local", "smtp"]) }).strict(),
  ),
});

type PurgePhase = z.infer<typeof phase>;
type PurgeSnapshot = {
  deletionId: string;
  accountId: string;
  tenantId: string;
  ledgerId: string;
  phase: PurgePhase;
  requestedAt: string;
  revokedAt: string;
  policyVersion: string;
  workingDataPolicyDeadline: string;
  backupRetentionPolicyDeadline: string;
  revokeSha256: string | null;
  sourceEmptyVerifiedAt: string | null;
  localMailClearedAt: string | null;
  metadataPurgedAt: string | null;
};

export type AccountPurgeCounters = {
  jobsClaimed: number;
  revokeRecordsAcknowledged: number;
  sourceVersionsDeleted: number;
  sourcePrefixesVerifiedEmpty: number;
  metadataPurged: number;
  terminalRecordsAcknowledged: number;
};

export type AccountPurgeDependencies = {
  ledgerId: string;
  ledger: ErasureLedgerTransport;
  content: MaintenanceObjectStore;
  removeLocalMail?: (path: string) => Promise<void>;
  now?: () => Date;
  attemptId?: () => string;
  replacementPasswordHash?: () => string;
  restoreRunId?: string;
  restoreDeletionId?: string;
};

class AccountPurgeMailFailure extends Error {}
class AccountPurgeStorageFailure extends Error {}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid purge timestamp");
  return date.toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function snapshot(row: Record<string, unknown>): PurgeSnapshot | null {
  if (!row.deletion_id) return null;
  return {
    deletionId: uuid.parse(row.deletion_id),
    accountId: uuid.parse(row.account_id),
    tenantId: uuid.parse(row.tenant_id),
    ledgerId: uuid.parse(row.ledger_id),
    phase: phase.parse(row.phase),
    requestedAt: iso(row.requested_at),
    revokedAt: iso(row.revoked_at),
    policyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).parse(row.policy_version),
    workingDataPolicyDeadline: iso(row.working_data_policy_deadline),
    backupRetentionPolicyDeadline: iso(row.backup_retention_policy_deadline),
    revokeSha256: row.revoke_sha256 ? z.string().regex(/^[a-f0-9]{64}$/).parse(row.revoke_sha256) : null,
    sourceEmptyVerifiedAt: nullableIso(row.source_empty_verified_at),
    localMailClearedAt: nullableIso(row.local_mail_cleared_at),
    metadataPurgedAt: nullableIso(row.metadata_purged_at),
  };
}

function commonRecord(job: PurgeSnapshot) {
  return {
    schemaVersion: 1 as const,
    ledgerId: job.ledgerId,
    requestId: job.deletionId,
    accountId: job.accountId,
    tenantId: job.tenantId,
    requestedAt: job.requestedAt,
    revokedAt: job.revokedAt,
    policyVersion: job.policyVersion,
    workingDataPolicyDeadline: job.workingDataPolicyDeadline,
    backupRetentionPolicyDeadline: job.backupRetentionPolicyDeadline,
  };
}

function revokeRecord(job: PurgeSnapshot): RevokeRecord {
  return { ...commonRecord(job), event: "revoke" };
}

function purgedRecord(job: PurgeSnapshot): PurgedRecord {
  if (
    !job.revokeSha256 ||
    !job.sourceEmptyVerifiedAt ||
    !job.localMailClearedAt ||
    !job.metadataPurgedAt
  )
    throw new Error("Terminal purge proof is incomplete");
  return {
    ...commonRecord(job),
    event: "purged",
    revokeSha256: job.revokeSha256,
    sourceEmptyVerifiedAt: job.sourceEmptyVerifiedAt,
    localMailClearedAt: job.localMailClearedAt,
    metadataPurgedAt: job.metadataPurgedAt,
  };
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Account purge stopped");
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "null";
}

function emptyCounters(): AccountPurgeCounters {
  return {
    jobsClaimed: 0,
    revokeRecordsAcknowledged: 0,
    sourceVersionsDeleted: 0,
    sourcePrefixesVerifiedEmpty: 0,
    metadataPurged: 0,
    terminalRecordsAcknowledged: 0,
  };
}

function randomPasswordHash() {
  return `${randomBytes(16).toString("hex")}:${randomBytes(64).toString("hex")}`;
}

function errorCode(error: unknown, stage: "ledger" | "storage" | "mail" | "database") {
  if (stage === "ledger" || error instanceof ErasureLedgerAdapterError) return "ledger";
  if (stage === "storage" || error instanceof AccountPurgeStorageFailure) return "storage";
  if (stage === "mail" || error instanceof AccountPurgeMailFailure) return "mail";
  return stage;
}

async function claim(
  scope: MaintenanceScope,
  attemptId: string,
  ledgerId: string,
  restore?: { runId: string; deletionId: string },
) {
  return scope.transaction(async (c) => {
    const result = await c.query(
      restore
        ? "SELECT * FROM claim_restored_account_purge_job($1,$2,$3,$4)"
        : "SELECT * FROM claim_account_purge_job($1,$2)",
      restore
        ? [restore.runId, restore.deletionId, attemptId, ledgerId]
        : [attemptId, ledgerId],
    );
    return snapshot(result.rows?.[0] ?? {});
  });
}

async function acknowledgeRevoke(
  scope: MaintenanceScope,
  job: PurgeSnapshot,
  attemptId: string,
  acknowledgement: { key: string; sha256: string; versionId: string },
) {
  await scope.transaction(async (c) => {
    await c.query(
      "SELECT acknowledge_account_purge_revoke($1,$2,$3,$4,$5)",
      [job.deletionId, attemptId, acknowledgement.key, acknowledgement.sha256, acknowledgement.versionId],
    );
  });
  job.phase = "deleting_source";
  job.revokeSha256 = acknowledgement.sha256;
}

async function deleteSourceBatch(
  scope: MaintenanceScope,
  content: MaintenanceObjectStore,
  job: PurgeSnapshot,
  attemptId: string,
  now: () => Date,
) {
  const prefix = `${job.tenantId}/`;
  assertActive(scope.signal);
  const page = await content.listVersions({ prefix, maxKeys: 100 }, scope.signal);
  assertActive(scope.signal);
  const candidates = [...page.versions, ...page.deleteMarkers];
  if (candidates.length > 100) throw new AccountPurgeStorageFailure();
  for (const candidate of candidates) {
    assertActive(scope.signal);
    if (!candidate.key?.startsWith(prefix) || !validVersion(candidate.versionId))
      throw new AccountPurgeStorageFailure();
    await content.deleteVersion(candidate.key, candidate.versionId, scope.signal);
    assertActive(scope.signal);
  }
  if (!candidates.length && page.truncated) throw new AccountPurgeStorageFailure();
  if (candidates.length) {
    const remaining = await content.listVersions(
      { prefix, maxKeys: 1 },
      scope.signal,
    );
    assertActive(scope.signal);
    if (remaining.versions.length || remaining.deleteMarkers.length)
      return { deleted: candidates.length, empty: false };
    if (remaining.truncated) throw new AccountPurgeStorageFailure();
  }
  const verifiedAt = now().toISOString();
  await scope.transaction(async (c) => {
    await c.query("SELECT mark_account_purge_source_empty($1,$2,$3)", [
      job.deletionId,
      attemptId,
      verifiedAt,
    ]);
  });
  job.phase = "source_empty";
  job.sourceEmptyVerifiedAt = verifiedAt;
  return { deleted: candidates.length, empty: true };
}

async function clearLocalMail(
  scope: MaintenanceScope,
  job: PurgeSnapshot,
  attemptId: string,
  now: () => Date,
  removeLocalMail: (path: string) => Promise<void>,
) {
  return scope.transaction(async (c) => {
    const result = await c.query("SELECT * FROM lock_account_purge_mail($1,$2)", [
      job.deletionId,
      attemptId,
    ]);
    const mail = mailSnapshot.parse(result.rows?.[0]);
    for (const challenge of mail.challenges) {
      assertActive(scope.signal);
      if (challenge.delivery !== "local") continue;
      try {
        await removeLocalMail(`.local/mail/${challenge.id}.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AccountPurgeMailFailure();
      }
      assertActive(scope.signal);
    }
    const clearedAt = job.localMailClearedAt ?? now().toISOString();
    await c.query("SELECT complete_account_purge_mail($1,$2,$3,$4)", [
      job.deletionId,
      attemptId,
      clearedAt,
      mail.challenges.map((challenge) => challenge.id),
    ]);
    job.localMailClearedAt = clearedAt;
  });
}

async function terminalErase(
  scope: MaintenanceScope,
  job: PurgeSnapshot,
  attemptId: string,
  passwordHash: string,
) {
  const result = await scope.transaction(async (c) =>
    c.query(
      "SELECT * FROM terminal_erase_account_metadata($1,$2,$3)",
      [job.deletionId, attemptId, passwordHash],
    ),
  );
  const updated = snapshot(result.rows?.[0] ?? {});
  if (!updated || updated.phase !== "metadata_purged")
    throw new Error("Terminal erase returned an invalid snapshot");
  return updated;
}

async function markFailure(
  scope: MaintenanceScope,
  deletionId: string,
  attemptId: string,
  code: string,
) {
  if (scope.signal.aborted) return;
  try {
    await scope.transaction(async (c) => {
      await c.query("SELECT fail_account_purge_attempt($1,$2,$3)", [
        deletionId,
        attemptId,
        code,
      ]);
    });
  } catch {
    // A stale attempt or lost guard is already non-authoritative.
  }
}

/** Processes at most one tenant and at most 100 exact content versions. */
export async function runAccountPurge(
  scope: MaintenanceScope,
  dependencies: AccountPurgeDependencies,
): Promise<AccountPurgeCounters> {
  const counters = emptyCounters();
  const attemptId = (dependencies.attemptId ?? randomUUID)();
  const now = dependencies.now ?? (() => new Date());
  const removeLocalMail = dependencies.removeLocalMail ?? unlink;
  const replacementPasswordHash =
    dependencies.replacementPasswordHash ?? randomPasswordHash;
  if ((dependencies.restoreRunId === undefined) !== (dependencies.restoreDeletionId === undefined))
    throw new Error("Restore purge identity is incomplete");
  const job = await claim(
    scope,
    attemptId,
    dependencies.ledgerId,
    dependencies.restoreRunId && dependencies.restoreDeletionId
      ? { runId: dependencies.restoreRunId, deletionId: dependencies.restoreDeletionId }
      : undefined,
  );
  if (!job) return counters;
  counters.jobsClaimed = 1;
  let stage: "ledger" | "storage" | "mail" | "database" = "ledger";
  try {
    if (job.phase === "awaiting_revoke_ledger") {
      const acknowledgement = await appendErasureRecord(
        dependencies.ledger,
        revokeRecord(job),
        dependencies.ledgerId,
        scope.signal,
      );
      await acknowledgeRevoke(scope, job, attemptId, acknowledgement);
      counters.revokeRecordsAcknowledged = 1;
    }

    if (job.phase === "deleting_source") {
      stage = "storage";
      const source = await deleteSourceBatch(
        scope,
        dependencies.content,
        job,
        attemptId,
        now,
      );
      counters.sourceVersionsDeleted = source.deleted;
      if (!source.empty) {
        await scope.transaction(async (c) => {
          await c.query("SELECT yield_account_purge_attempt($1,$2)", [
            job.deletionId,
            attemptId,
          ]);
        });
        return counters;
      }
      counters.sourcePrefixesVerifiedEmpty = 1;
    }

    if (job.phase === "source_empty") {
      stage = "mail";
      await clearLocalMail(
        scope,
        job,
        attemptId,
        now,
        removeLocalMail,
      );
      stage = "database";
      Object.assign(
        job,
        await terminalErase(
          scope,
          job,
          attemptId,
          replacementPasswordHash(),
        ),
      );
      counters.metadataPurged = 1;
    }

    if (job.phase === "metadata_purged") {
      stage = "ledger";
      if (dependencies.restoreRunId) {
        const historic = await scope.transaction(async (c) => {
          const result = await c.query(
            "SELECT acknowledge_historic_restored_purge($1,$2,$3) AS acknowledged",
            [dependencies.restoreRunId, job.deletionId, attemptId],
          );
          return result.rows?.[0]?.acknowledged === true;
        });
        if (!historic)
          throw new Error("Restore suppression has no historic ledger record");
        counters.terminalRecordsAcknowledged = 1;
        return counters;
      }
      const acknowledgement = await appendErasureRecord(
        dependencies.ledger,
        purgedRecord(job),
        dependencies.ledgerId,
        scope.signal,
      );
      await scope.transaction(async (c) => {
        await c.query(
          "SELECT acknowledge_account_purge_terminal($1,$2,$3,$4,$5)",
          [job.deletionId, attemptId, acknowledgement.key, acknowledgement.sha256, acknowledgement.versionId],
        );
      });
      counters.terminalRecordsAcknowledged = 1;
    }
    return counters;
  } catch (error) {
    await markFailure(scope, job.deletionId, attemptId, errorCode(error, stage));
    throw error;
  }
}

export function recordForPurgeSnapshot(
  row: Record<string, unknown>,
  event: "revoke" | "purged",
): ErasureRecord {
  const parsed = snapshot(row);
  if (!parsed) throw new Error("Purge snapshot is missing");
  return event === "revoke" ? revokeRecord(parsed) : purgedRecord(parsed);
}
