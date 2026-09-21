import {
  encodeErasureRecord,
  type ErasureEntry,
  type ErasureRecord,
} from "../packages/erasure-ledger.ts";
import {
  readErasureLedger,
  type ErasureLedgerTransport,
} from "./erasure-ledger-adapter.ts";

export type ErasureRestoreRecord = {
  key: string;
  versionId: string;
  sha256: string;
  bytes: Uint8Array;
  record: ErasureRecord;
};

export type ErasureRestorePlan = {
  ledgerId: string;
  entries: readonly ErasureEntry[];
  records: readonly ErasureRestoreRecord[];
};

function active(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Erasure restore stopped");
}

function freezePlan(plan: ErasureRestorePlan): ErasureRestorePlan {
  for (const record of plan.records) {
    Object.freeze(record.record);
    Object.freeze(record);
  }
  for (const entry of plan.entries) Object.freeze(entry);
  Object.freeze(plan.records);
  Object.freeze(plan.entries);
  return Object.freeze(plan);
}

/** Must complete before a backup is allowed to mutate its restore target. */
export async function loadErasureRestorePlan(
  transport: ErasureLedgerTransport,
  expectedLedgerId: string,
  signal: AbortSignal,
): Promise<ErasureRestorePlan> {
  active(signal);
  const ledger = await readErasureLedger(transport, expectedLedgerId, signal);
  active(signal);
  if (ledger.records.length !== ledger.acknowledgements.length)
    throw new Error("Erasure ledger acknowledgement is incomplete");
  const records = ledger.records.map(({ key, record, sha256 }, index) => {
    const encoded = encodeErasureRecord(record);
    const acknowledgement = ledger.acknowledgements[index];
    if (
      !acknowledgement ||
      acknowledgement.key !== key ||
      acknowledgement.sha256 !== sha256
    )
      throw new Error("Erasure ledger acknowledgement is incomplete");
    return {
      key,
      versionId: acknowledgement.versionId,
      sha256,
      bytes: encoded.bytes,
      record,
    };
  });
  return freezePlan({ ledgerId: expectedLedgerId, entries: ledger.entries, records });
}

export function requireBackupLedger(
  backup: { erasureLedgerId?: unknown },
  plan: ErasureRestorePlan,
) {
  if (backup.erasureLedgerId !== plan.ledgerId)
    throw new Error("Backup erasure ledger namespace mismatch");
}

export async function applyErasureRestorePlan(
  plan: ErasureRestorePlan,
  signal: AbortSignal,
  suppress: (
    entry: ErasureEntry,
    immutableRecords: readonly ErasureRestoreRecord[],
    signal: AbortSignal,
  ) => Promise<void>,
) {
  for (const entry of plan.entries) {
    active(signal);
    const records = plan.records.filter(
      ({ record }) => record.requestId === entry.requestId,
    );
    if (!records.length) throw new Error("Erasure restore entry has no immutable record");
    await suppress(entry, records, signal);
    active(signal);
  }
}

/** Re-read after suppression while writers remain barred; any delta blocks open. */
export function assertErasureRestorePlanStable(
  before: ErasureRestorePlan,
  after: ErasureRestorePlan,
) {
  if (before.ledgerId !== after.ledgerId)
    throw new Error("Erasure ledger namespace changed during restore");
  const identity = (plan: ErasureRestorePlan) =>
    plan.records
      .map(({ key, versionId, sha256 }) => `${key}\0${versionId}\0${sha256}`)
      .sort();
  if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after)))
    throw new Error("Erasure ledger changed during restore");
}
