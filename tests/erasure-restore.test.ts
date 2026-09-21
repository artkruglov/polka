import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeErasureRecord } from "../packages/erasure-ledger.ts";
import {
  applyErasureRestorePlan,
  assertErasureRestorePlanStable,
  loadErasureRestorePlan,
  requireBackupLedger,
} from "../scripts/erasure-restore.ts";

const ledgerId = randomUUID();
const requestId = randomUUID();
const revoke = {
  schemaVersion: 1 as const,
  event: "revoke" as const,
  ledgerId,
  requestId,
  accountId: randomUUID(),
  tenantId: randomUUID(),
  requestedAt: "2026-09-21T10:00:00.000Z",
  revokedAt: "2026-09-21T10:00:01.000Z",
  policyVersion: "local-v1",
  workingDataPolicyDeadline: "2026-09-21T11:00:00.000Z",
  backupRetentionPolicyDeadline: "2026-09-22T10:00:00.000Z",
};

function transport(records = [encodeErasureRecord(revoke)]) {
  return {
    async putIfAbsent() { throw new Error("restore must not write the ledger"); },
    async read() { throw new Error("restore listing supplies pinned bytes"); },
    async list(_prefix: string, cursor: string | undefined) {
      assert.equal(cursor, undefined);
      return {
        items: records.map((record, index) => ({
          key: record.key,
          bytes: record.bytes,
          versionId: `version-${index}`,
        })),
      };
    },
  };
}

test("restore loads immutable ledger before suppression and never writes it", async () => {
  const signal = new AbortController().signal;
  const plan = await loadErasureRestorePlan(transport(), ledgerId, signal);
  requireBackupLedger({ erasureLedgerId: ledgerId }, plan);
  const seen: string[] = [];
  await applyErasureRestorePlan(plan, signal, async (entry, records) => {
    seen.push(entry.requestId);
    assert.equal(records[0]?.versionId, "version-0");
    assert.deepEqual(records[0]?.bytes, encodeErasureRecord(revoke).bytes);
  });
  assert.deepEqual(seen, [requestId]);
  const second = await loadErasureRestorePlan(transport(), ledgerId, signal);
  assert.doesNotThrow(() => assertErasureRestorePlanStable(plan, second));
});

test("restore blocks a missing namespace, journal delta and abort", async () => {
  const signal = new AbortController().signal;
  const plan = await loadErasureRestorePlan(transport(), ledgerId, signal);
  assert.throws(() => requireBackupLedger({}, plan));
  const changedRecord = encodeErasureRecord({ ...revoke, requestId: randomUUID(), accountId: randomUUID(), tenantId: randomUUID() });
  const changed = await loadErasureRestorePlan(transport([changedRecord]), ledgerId, signal);
  assert.throws(() => assertErasureRestorePlanStable(plan, changed));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(loadErasureRestorePlan(transport(), ledgerId, aborted.signal));
});

test("restore stability preserves every identical historical object version", async () => {
  const record = encodeErasureRecord(revoke);
  const make = (versions: string[]) => ({
    async putIfAbsent() { throw new Error("restore must not write"); },
    async read() { throw new Error("unused"); },
    async list() {
      return {
        items: versions.map((versionId) => ({
          key: record.key,
          bytes: record.bytes,
          versionId,
        })),
      };
    },
  });
  const signal = new AbortController().signal;
  const before = await loadErasureRestorePlan(make(["v1", "v2"]), ledgerId, signal);
  assert.deepEqual(before.records.map(({ versionId }) => versionId), ["v1", "v2"]);
  const replaced = await loadErasureRestorePlan(make(["v3", "v2"]), ledgerId, signal);
  assert.throws(() => assertErasureRestorePlanStable(before, replaced));
  const removed = await loadErasureRestorePlan(make(["v2"]), ledgerId, signal);
  assert.throws(() => assertErasureRestorePlanStable(before, removed));
});
