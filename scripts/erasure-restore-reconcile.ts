import { randomBytes } from "node:crypto";
import type {
  ErasureEntry,
  ErasureRecord,
} from "../packages/erasure-ledger.ts";
import { runAccountPurge, type AccountPurgeCounters } from "./account-purge.ts";
import type { ErasureLedgerTransport } from "./erasure-ledger-adapter.ts";
import {
  applyErasureRestorePlan,
  assertErasureRestorePlanStable,
  loadErasureRestorePlan,
  type ErasureRestorePlan,
  type ErasureRestoreRecord,
} from "./erasure-restore.ts";
import type {
  MaintenanceObjectStore,
  MaintenanceScope,
} from "./maintenance-cleanup.ts";

const MAX_RECONCILIATION_PASSES = 10_000;

export type ErasureRestoreReconciliation = {
  entriesCompleted: number;
  metadataTenantsCompleted: number;
  absentTenantsCompleted: number;
  sourceVersionsDeleted: number;
  metadataPurged: number;
};

type RestoreStatus = {
  state: "registered" | "completed";
  metadataPresent: boolean;
  tenantId: string;
};

function active(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Erasure restore reconciliation stopped");
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "null";
}

function immutableRecord(
  records: readonly ErasureRestoreRecord[],
  event: ErasureRecord["event"],
) {
  const matches = records
    .filter(({ record }) => record.event === event)
    .sort((left, right) =>
      left.versionId < right.versionId
        ? -1
        : left.versionId > right.versionId
          ? 1
          : 0,
    );
  const selected = matches[0];
  if (!selected)
    throw new Error(`Erasure restore has no ${event} acknowledgement`);
  return selected;
}

function secretHash() {
  return randomBytes(32).toString("hex");
}

function statusRow(row: Record<string, unknown> | undefined): RestoreStatus {
  if (
    !row ||
    (row.state !== "registered" && row.state !== "completed") ||
    typeof row.metadata_present !== "boolean" ||
    typeof row.tenant_id !== "string"
  )
    throw new Error("Restore suppression status is invalid");
  return {
    state: row.state,
    metadataPresent: row.metadata_present,
    tenantId: row.tenant_id,
  };
}

async function readStatus(
  scope: MaintenanceScope,
  restoreRunId: string,
  deletionId: string,
) {
  return scope.transaction(async (client) => {
    const result = await client.query(
      "SELECT * FROM restored_erasure_status($1,$2)",
      [restoreRunId, deletionId],
    );
    return statusRow(result.rows?.[0]);
  });
}

async function register(
  scope: MaintenanceScope,
  plan: ErasureRestorePlan,
  restoreRunId: string,
  entry: ErasureEntry,
  records: readonly ErasureRestoreRecord[],
) {
  const revoke = immutableRecord(records, "revoke");
  const purged =
    entry.state === "purged" ? immutableRecord(records, "purged") : undefined;
  const result = await scope.transaction((client) =>
    client.query(
      `SELECT register_restored_erasure(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
      ) AS metadata_present`,
      [
        restoreRunId,
        entry.requestId,
        entry.accountId,
        entry.tenantId,
        plan.ledgerId,
        entry.state,
        entry.revoke.requestedAt,
        entry.revoke.revokedAt,
        entry.revoke.policyVersion,
        entry.revoke.workingDataPolicyDeadline,
        entry.revoke.backupRetentionPolicyDeadline,
        revoke.key,
        revoke.sha256,
        revoke.versionId,
        purged?.key ?? null,
        purged?.sha256 ?? null,
        purged?.versionId ?? null,
        entry.purged?.sourceEmptyVerifiedAt ?? null,
        entry.purged?.localMailClearedAt ?? null,
        entry.purged?.metadataPurgedAt ?? null,
        secretHash(),
        secretHash(),
      ],
    ),
  );
  const metadataPresent = result.rows?.[0]?.metadata_present;
  if (typeof metadataPresent !== "boolean")
    throw new Error("Restore registration result is invalid");
  return metadataPresent;
}

async function deleteAbsentPrefixPass(
  scope: MaintenanceScope,
  content: MaintenanceObjectStore,
  tenantId: string,
) {
  const prefix = `${tenantId}/`;
  active(scope.signal);
  const page = await content.listVersions(
    { prefix, maxKeys: 100 },
    scope.signal,
  );
  active(scope.signal);
  const candidates = [...page.versions, ...page.deleteMarkers];
  if (candidates.length > 100)
    throw new Error("Restore source page exceeded its bound");
  for (const candidate of candidates) {
    active(scope.signal);
    if (
      !candidate.key?.startsWith(prefix) ||
      !validVersion(candidate.versionId)
    )
      throw new Error("Restore source listing is invalid");
    await content.deleteVersion(
      candidate.key,
      candidate.versionId,
      scope.signal,
    );
    active(scope.signal);
  }
  if (!candidates.length && page.truncated)
    throw new Error("Restore source listing is incomplete");
  return {
    deleted: candidates.length,
    empty: !candidates.length && !page.truncated,
  };
}

async function completeAbsent(
  scope: MaintenanceScope,
  content: MaintenanceObjectStore,
  restoreRunId: string,
  entry: ErasureEntry,
  now: () => Date,
) {
  let deleted = 0;
  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass++) {
    const result = await deleteAbsentPrefixPass(scope, content, entry.tenantId);
    deleted += result.deleted;
    if (!result.empty) continue;
    await scope.transaction(async (client) => {
      await client.query(
        "SELECT complete_absent_restore_suppression($1,$2,$3)",
        [restoreRunId, entry.requestId, now().toISOString()],
      );
    });
    return deleted;
  }
  throw new Error("Restore source reconciliation exceeded its pass bound");
}

function sumCounters(
  target: ErasureRestoreReconciliation,
  value: AccountPurgeCounters,
) {
  target.sourceVersionsDeleted += value.sourceVersionsDeleted;
  target.metadataPurged += value.metadataPurged;
}

async function completePresent(
  scope: MaintenanceScope,
  content: MaintenanceObjectStore,
  ledger: ErasureLedgerTransport,
  plan: ErasureRestorePlan,
  restoreRunId: string,
  entry: ErasureEntry,
  counters: ErasureRestoreReconciliation,
  now: () => Date,
) {
  const readOnlyLedger: ErasureLedgerTransport = {
    ...ledger,
    async putIfAbsent() {
      throw new Error(
        "Restore reconciliation must not write the erasure ledger",
      );
    },
  };
  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass++) {
    const state = await readStatus(scope, restoreRunId, entry.requestId);
    if (state.state === "completed") return;
    const result = await runAccountPurge(scope, {
      ledgerId: plan.ledgerId,
      ledger: readOnlyLedger,
      content,
      now,
      restoreRunId,
      restoreDeletionId: entry.requestId,
    });
    sumCounters(counters, result);
    if (!result.jobsClaimed) {
      const after = await readStatus(scope, restoreRunId, entry.requestId);
      if (after.state === "completed") return;
      throw new Error("Restored purge job is not claimable");
    }
  }
  throw new Error("Restore metadata reconciliation exceeded its pass bound");
}

/**
 * Runs behind the restore barrier with a restore-only DB identity. It never
 * writes the external ledger and re-reads every immutable version before the
 * restored application may be created.
 */
export async function reconcileErasureRestore(input: {
  scope: MaintenanceScope;
  content: MaintenanceObjectStore;
  ledger: ErasureLedgerTransport;
  plan: ErasureRestorePlan;
  restoreRunId: string;
  now?: () => Date;
}): Promise<ErasureRestoreReconciliation> {
  const counters: ErasureRestoreReconciliation = {
    entriesCompleted: 0,
    metadataTenantsCompleted: 0,
    absentTenantsCompleted: 0,
    sourceVersionsDeleted: 0,
    metadataPurged: 0,
  };
  const now = input.now ?? (() => new Date());
  await applyErasureRestorePlan(
    input.plan,
    input.scope.signal,
    async (entry, records) => {
      active(input.scope.signal);
      const metadataPresent = await register(
        input.scope,
        input.plan,
        input.restoreRunId,
        entry,
        records,
      );
      const state = await readStatus(
        input.scope,
        input.restoreRunId,
        entry.requestId,
      );
      if (
        state.tenantId !== entry.tenantId ||
        state.metadataPresent !== metadataPresent
      )
        throw new Error("Restore registration identity changed");
      if (state.state !== "completed") {
        if (metadataPresent) {
          await completePresent(
            input.scope,
            input.content,
            input.ledger,
            input.plan,
            input.restoreRunId,
            entry,
            counters,
            now,
          );
        } else {
          counters.sourceVersionsDeleted += await completeAbsent(
            input.scope,
            input.content,
            input.restoreRunId,
            entry,
            now,
          );
        }
      }
      const completed = await readStatus(
        input.scope,
        input.restoreRunId,
        entry.requestId,
      );
      if (completed.state !== "completed")
        throw new Error("Restore suppression did not complete");
      counters.entriesCompleted++;
      if (metadataPresent) counters.metadataTenantsCompleted++;
      else counters.absentTenantsCompleted++;
    },
  );
  active(input.scope.signal);
  const after = await loadErasureRestorePlan(
    input.ledger,
    input.plan.ledgerId,
    input.scope.signal,
  );
  assertErasureRestorePlanStable(input.plan, after);
  return counters;
}
