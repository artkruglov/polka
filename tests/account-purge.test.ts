import assert from "node:assert/strict";
import test from "node:test";
import { runAccountPurge } from "../scripts/account-purge.ts";
import { parseAccountPurgeConfig } from "../scripts/account-purge-config.ts";
import type { MaintenanceScope } from "../scripts/maintenance-cleanup.ts";

const ids = {
  deletion: "10000000-0000-4000-8000-000000000001",
  account: "10000000-0000-4000-8000-000000000002",
  tenant: "10000000-0000-4000-8000-000000000003",
  ledger: "10000000-0000-4000-8000-000000000004",
  attempt: "10000000-0000-4000-8000-000000000005",
  challenge: "10000000-0000-4000-8000-000000000006",
};

function row(phase: string) {
  return {
    deletion_id: ids.deletion,
    account_id: ids.account,
    tenant_id: ids.tenant,
    ledger_id: ids.ledger,
    phase,
    requested_at: new Date("2026-09-21T10:00:00.000Z"),
    revoked_at: new Date("2026-09-21T10:00:01.000Z"),
    policy_version: "local-v1",
    working_data_policy_deadline: new Date("2026-09-21T11:00:00.000Z"),
    backup_retention_policy_deadline: new Date("2026-09-22T10:00:00.000Z"),
    revoke_sha256: null as string | null,
    source_empty_verified_at: null as Date | null,
    local_mail_cleared_at: null as Date | null,
    metadata_purged_at: null as Date | null,
  };
}

function fixture(initialPhase = "awaiting_revoke_ledger") {
  const current = row(initialPhase);
  const sql: Array<{ text: string; values?: unknown[] }> = [];
  const controller = new AbortController();
  const scope: MaintenanceScope = {
    signal: controller.signal,
    transaction: async (operation) =>
      operation({
        async query(text, values) {
          sql.push({ text, values });
          if (text.includes("claim_account_purge_job")) return { rows: [{ ...current }] };
          if (text.includes("acknowledge_account_purge_revoke")) {
            current.phase = "deleting_source";
            current.revoke_sha256 = String(values?.[3]);
          }
          if (text.includes("mark_account_purge_source_empty")) {
            current.phase = "source_empty";
            current.source_empty_verified_at = new Date(String(values?.[2]));
          }
          if (text.includes("lock_account_purge_mail")) {
            return {
              rows: [{
                account_email: "owner@example.test",
                challenges: [{ id: ids.challenge, delivery: "local" }],
              }],
            };
          }
          if (text.includes("complete_account_purge_mail"))
            current.local_mail_cleared_at = new Date(String(values?.[2]));
          if (text.includes("terminal_erase_account_metadata")) {
            current.phase = "metadata_purged";
            current.metadata_purged_at = new Date("2026-09-21T10:00:04.000Z");
            return { rows: [{ ...current }] };
          }
          if (text.includes("acknowledge_account_purge_terminal")) current.phase = "purged";
          return { rows: [] };
        },
      }),
  };
  return { current, sql, scope };
}

test("purge records revoke, verifies an empty source, scrubs mail/metadata, then records terminal proof", async () => {
  const { current, sql, scope } = fixture();
  const ledger = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const counters = await runAccountPurge(scope, {
    ledgerId: ids.ledger,
    attemptId: () => ids.attempt,
    now: () => new Date("2026-09-21T10:00:03.000Z"),
    replacementPasswordHash: () => `${"a".repeat(32)}:${"b".repeat(128)}`,
    removeLocalMail: async (path) => { removed.push(path); },
    ledger: {
      async putIfAbsent(key, bytes) {
        assert.equal(ledger.has(key), false);
        ledger.set(key, bytes);
        return { versionId: `version-${ledger.size}` };
      },
      async read(key) { return { bytes: ledger.get(key)!, versionId: "version-existing" }; },
      async list() { return { items: [] }; },
    },
    content: {
      async listVersions(input) {
        assert.equal(input.prefix, `${ids.tenant}/`);
        assert.equal(input.maxKeys, 100);
        return { versions: [], deleteMarkers: [], truncated: false };
      },
      async deleteVersion() { throw new Error("nothing may be deleted"); },
    },
  });
  assert.deepEqual(counters, {
    jobsClaimed: 1,
    revokeRecordsAcknowledged: 1,
    sourceVersionsDeleted: 0,
    sourcePrefixesVerifiedEmpty: 1,
    metadataPurged: 1,
    terminalRecordsAcknowledged: 1,
  });
  assert.equal(current.phase, "purged");
  assert.deepEqual(removed, [`.local/mail/${ids.challenge}.json`]);
  assert.deepEqual(
    [...ledger.keys()],
    [
      `erasure/v1/${ids.ledger}/${ids.deletion}/revoke.json`,
      `erasure/v1/${ids.ledger}/${ids.deletion}/purged.json`,
    ],
  );
  const completion = sql.find((query) => query.text.includes("complete_account_purge_mail"));
  assert.deepEqual(completion?.values?.[3], [ids.challenge]);
});

test("one pass deletes at most one 100-version source batch and leaves metadata intact", async () => {
  const { current, sql, scope } = fixture("deleting_source");
  current.revoke_sha256 = "a".repeat(64);
  const versions = Array.from({ length: 100 }, (_, index) => ({
    key: `${ids.tenant}/orphan-${index}`,
    versionId: `v-${index}`,
  }));
  const deleted: string[] = [];
  const counters = await runAccountPurge(scope, {
    ledgerId: ids.ledger,
    attemptId: () => ids.attempt,
    ledger: {
      async putIfAbsent() { throw new Error("ledger should not be called"); },
      async read() { throw new Error("ledger should not be called"); },
      async list() { return { items: [] }; },
    },
    content: {
      async listVersions() { return { versions, deleteMarkers: [], truncated: true, nextKeyMarker: "next", nextVersionIdMarker: "next-version" }; },
      async deleteVersion(key, version) { deleted.push(`${key}@${version}`); },
    },
  });
  assert.equal(counters.sourceVersionsDeleted, 100);
  assert.equal(deleted.length, 100);
  assert.equal(current.phase, "deleting_source");
  assert.equal(sql.some((query) => query.text.includes("yield_account_purge_attempt")), true);
  assert.equal(sql.some((query) => query.text.includes("terminal_erase")), false);
});

test("purge config requires separate loopback worker and journal identities", () => {
  const base = {
    ACCOUNT_DELETION_ENABLED: "true",
    DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:5432/polka",
    MAINTENANCE_DATABASE_URL: "postgresql://purger:secret@127.0.0.1:5432/polka",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_ACCESS_KEY: "content",
    S3_SECRET_KEY: "content-secret-0000",
    S3_BUCKET: "content-bucket",
    ERASURE_LEDGER_ID: ids.ledger,
    ERASURE_LEDGER_ENDPOINT: "http://localhost:9000",
    ERASURE_LEDGER_ACCESS_KEY: "ledger",
    ERASURE_LEDGER_SECRET_KEY: "ledger-secret-0000",
    ERASURE_LEDGER_BUCKET: "ledger-bucket",
  };
  assert.equal(parseAccountPurgeConfig(base).ERASURE_LEDGER_ID, ids.ledger);
  assert.throws(() => parseAccountPurgeConfig({ ...base, MAINTENANCE_DATABASE_URL: base.DATABASE_URL }));
  assert.throws(() => parseAccountPurgeConfig({ ...base, ERASURE_LEDGER_BUCKET: base.S3_BUCKET }));
  assert.throws(() => parseAccountPurgeConfig({ ...base, DATABASE_URL: `${base.DATABASE_URL}?host=remote.example` }));
});
