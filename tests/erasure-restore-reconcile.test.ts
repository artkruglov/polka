import assert from "node:assert/strict";
import test from "node:test";
import { encodeErasureRecord, type PurgedRecord, type RevokeRecord } from "../packages/erasure-ledger.ts";
import { reconcileErasureRestore } from "../scripts/erasure-restore-reconcile.ts";
import { loadErasureRestorePlan } from "../scripts/erasure-restore.ts";
import type { MaintenanceScope } from "../scripts/maintenance-cleanup.ts";

const ids = {
  ledger: "90000000-0000-4000-8000-000000000001",
  restore: "90000000-0000-4000-8000-000000000002",
  presentRequest: "90000000-0000-4000-8000-000000000003",
  presentAccount: "90000000-0000-4000-8000-000000000004",
  presentTenant: "90000000-0000-4000-8000-000000000005",
  absentRequest: "90000000-0000-4000-8000-000000000006",
  absentAccount: "90000000-0000-4000-8000-000000000007",
  absentTenant: "90000000-0000-4000-8000-000000000008",
};

function revoke(requestId: string, accountId: string, tenantId: string): RevokeRecord {
  return {
    schemaVersion: 1,
    event: "revoke",
    ledgerId: ids.ledger,
    requestId,
    accountId,
    tenantId,
    requestedAt: "2026-09-21T10:00:00.000Z",
    revokedAt: "2026-09-21T10:00:01.000Z",
    policyVersion: "local-v1",
    workingDataPolicyDeadline: "2026-09-21T11:00:00.000Z",
    backupRetentionPolicyDeadline: "2026-09-22T10:00:00.000Z",
  };
}

const presentRevoke = revoke(ids.presentRequest, ids.presentAccount, ids.presentTenant);
const presentRevokeEncoded = encodeErasureRecord(presentRevoke);
const presentPurged: PurgedRecord = {
  ...presentRevoke,
  event: "purged",
  revokeSha256: presentRevokeEncoded.sha256,
  sourceEmptyVerifiedAt: "2026-09-21T10:00:02.000Z",
  localMailClearedAt: "2026-09-21T10:00:03.000Z",
  metadataPurgedAt: "2026-09-21T10:00:04.000Z",
};
const absentRevoke = revoke(ids.absentRequest, ids.absentAccount, ids.absentTenant);
const encoded = [presentRevoke, presentPurged, absentRevoke].map(encodeErasureRecord);

function ledger() {
  let lists = 0;
  let puts = 0;
  return {
    get lists() { return lists; },
    get puts() { return puts; },
    transport: {
      async putIfAbsent() {
        puts++;
        throw new Error("restore must not append to the ledger");
      },
      async read() { throw new Error("pinned listing supplies bytes"); },
      async list() {
        lists++;
        return {
          items: encoded.map((record, index) => ({
            key: record.key,
            bytes: record.bytes,
            versionId: `ledger-version-${index}`,
          })),
        };
      },
    },
  };
}

test("restore reconciles present and absent tenants without changing the journal", async () => {
  const journal = ledger();
  const controller = new AbortController();
  const plan = await loadErasureRestorePlan(journal.transport, ids.ledger, controller.signal);
  const suppressions = new Map<string, { metadata: boolean; state: "registered" | "completed" }>();
  const present = {
    phase: "deleting_source",
    sourceEmpty: null as Date | null,
    mailCleared: null as Date | null,
    metadataPurged: null as Date | null,
  };
  const registrations: unknown[][] = [];
  const queries: string[] = [];
  const scope: MaintenanceScope = {
    signal: controller.signal,
    transaction: async (operation) =>
      operation({
        async query(sql, values) {
          queries.push(sql);
          if (sql.includes("register_restored_erasure")) {
            registrations.push(values ?? []);
            const deletionId = String(values?.[1]);
            const metadata = deletionId === ids.presentRequest;
            if (!suppressions.has(deletionId))
              suppressions.set(deletionId, { metadata, state: "registered" });
            return { rows: [{ metadata_present: metadata }] };
          }
          if (sql.includes("restored_erasure_status")) {
            const deletionId = String(values?.[1]);
            const value = suppressions.get(deletionId)!;
            return {
              rows: [{
                state: value.state,
                metadata_present: value.metadata,
                tenant_id: deletionId === ids.presentRequest
                  ? ids.presentTenant
                  : ids.absentTenant,
              }],
            };
          }
          if (sql.includes("claim_restored_account_purge_job")) {
            return {
              rows: [{
                deletion_id: ids.presentRequest,
                account_id: ids.presentAccount,
                tenant_id: ids.presentTenant,
                ledger_id: ids.ledger,
                phase: present.phase,
                requested_at: new Date(presentRevoke.requestedAt),
                revoked_at: new Date(presentRevoke.revokedAt),
                policy_version: presentRevoke.policyVersion,
                working_data_policy_deadline: new Date(presentRevoke.workingDataPolicyDeadline),
                backup_retention_policy_deadline: new Date(presentRevoke.backupRetentionPolicyDeadline),
                revoke_sha256: presentRevokeEncoded.sha256,
                source_empty_verified_at: present.sourceEmpty,
                local_mail_cleared_at: present.mailCleared,
                metadata_purged_at: present.metadataPurged,
              }],
            };
          }
          if (sql.includes("mark_account_purge_source_empty")) {
            present.phase = "source_empty";
            present.sourceEmpty = new Date(String(values?.[2]));
          }
          if (sql.includes("lock_account_purge_mail"))
            return { rows: [{ account_email: null, challenges: [] }] };
          if (sql.includes("complete_account_purge_mail"))
            present.mailCleared = new Date(String(values?.[2]));
          if (sql.includes("terminal_erase_account_metadata")) {
            present.phase = "metadata_purged";
            present.metadataPurged = new Date("2026-09-21T10:00:08.000Z");
            return {
              rows: [{
                deletion_id: ids.presentRequest,
                account_id: ids.presentAccount,
                tenant_id: ids.presentTenant,
                ledger_id: ids.ledger,
                phase: present.phase,
                requested_at: new Date(presentRevoke.requestedAt),
                revoked_at: new Date(presentRevoke.revokedAt),
                policy_version: presentRevoke.policyVersion,
                working_data_policy_deadline: new Date(presentRevoke.workingDataPolicyDeadline),
                backup_retention_policy_deadline: new Date(presentRevoke.backupRetentionPolicyDeadline),
                revoke_sha256: presentRevokeEncoded.sha256,
                source_empty_verified_at: present.sourceEmpty,
                local_mail_cleared_at: present.mailCleared,
                metadata_purged_at: present.metadataPurged,
              }],
            };
          }
          if (sql.includes("acknowledge_historic_restored_purge")) {
            suppressions.get(ids.presentRequest)!.state = "completed";
            return { rows: [{ acknowledged: true }] };
          }
          if (sql.includes("complete_absent_restore_suppression")) {
            suppressions.get(ids.absentRequest)!.state = "completed";
            return { rows: [] };
          }
          return { rows: [] };
        },
      }),
  };
  const objects = new Map([
    [`${ids.presentTenant}/restored.html`, "content-v1"],
    [`${ids.absentTenant}/orphan.bin`, "orphan-v1"],
  ]);
  const content = {
    async listVersions(input: { prefix: string; maxKeys: number }) {
      assert.ok(input.maxKeys === 100 || input.maxKeys === 1);
      const matches = [...objects].filter(([key]) => key.startsWith(input.prefix));
      return {
        versions: matches.slice(0, input.maxKeys).map(([key, versionId]) => ({ key, versionId })),
        deleteMarkers: [],
        truncated: matches.length > input.maxKeys,
      };
    },
    async deleteVersion(key: string, versionId: string) {
      assert.equal(objects.get(key), versionId);
      objects.delete(key);
    },
  };
  const counters = await reconcileErasureRestore({
    scope,
    content,
    ledger: journal.transport,
    plan,
    restoreRunId: ids.restore,
    now: () => new Date("2026-09-21T10:00:08.000Z"),
  });
  assert.deepEqual(counters, {
    entriesCompleted: 2,
    metadataTenantsCompleted: 1,
    absentTenantsCompleted: 1,
    sourceVersionsDeleted: 2,
    metadataPurged: 1,
  });
  assert.equal(objects.size, 0);
  assert.equal(journal.puts, 0);
  assert.equal(journal.lists, 2);
  assert.equal(registrations.length, 2);
  const presentRegistration = registrations.find((values) => values[1] === ids.presentRequest)!;
  assert.equal(presentRegistration[13], "ledger-version-0");
  assert.equal(presentRegistration[16], "ledger-version-1");
  assert.equal(presentRegistration[19], presentPurged.metadataPurgedAt);
  assert.equal(queries.some((sql) => sql.includes("claim_account_purge_job($1,$2)")), false);
});

test("restore rejects an unclaimable registered tenant and never writes the journal", async () => {
  const journal = ledger();
  const controller = new AbortController();
  const plan = await loadErasureRestorePlan(journal.transport, ids.ledger, controller.signal);
  const presentOnly = {
    ...plan,
    entries: plan.entries.filter((entry) => entry.requestId === ids.presentRequest),
    records: plan.records.filter(({ record }) => record.requestId === ids.presentRequest),
  };
  const scope: MaintenanceScope = {
    signal: controller.signal,
    transaction: async (operation) => operation({
      async query(sql) {
        if (sql.includes("register_restored_erasure"))
          return { rows: [{ metadata_present: true }] };
        if (sql.includes("restored_erasure_status"))
          return { rows: [{ state: "registered", metadata_present: true, tenant_id: ids.presentTenant }] };
        if (sql.includes("claim_restored_account_purge_job")) return { rows: [{}] };
        return { rows: [] };
      },
    }),
  };
  await assert.rejects(
    reconcileErasureRestore({
      scope,
      content: {
        async listVersions() { return { versions: [], deleteMarkers: [], truncated: false }; },
        async deleteVersion() { throw new Error("unused"); },
      },
      ledger: journal.transport,
      plan: presentOnly,
      restoreRunId: ids.restore,
    }),
    /not claimable/,
  );
  assert.equal(journal.puts, 0);
});
