import assert from "node:assert/strict";
import test from "node:test";
import { runAccountPurge, type AccountPurgeDependencies } from "../scripts/account-purge.ts";
import type { MaintenanceScope } from "../scripts/maintenance-cleanup.ts";

const id = {
  deletion: "20000000-0000-4000-8000-000000000001",
  account: "20000000-0000-4000-8000-000000000002",
  tenant: "20000000-0000-4000-8000-000000000003",
  ledger: "20000000-0000-4000-8000-000000000004",
  attempt: "20000000-0000-4000-8000-000000000005",
  challenge: "20000000-0000-4000-8000-000000000006",
};

function makeFixture(phase: string) {
  const current: any = {
    deletion_id: id.deletion, account_id: id.account, tenant_id: id.tenant,
    ledger_id: id.ledger, phase,
    requested_at: new Date("2026-09-21T10:00:00Z"), revoked_at: new Date("2026-09-21T10:00:01Z"),
    policy_version: "local-v1", working_data_policy_deadline: new Date("2026-09-21T11:00:00Z"),
    backup_retention_policy_deadline: new Date("2026-09-22T10:00:00Z"),
    revoke_sha256: phase === "awaiting_revoke_ledger" ? null : "a".repeat(64),
    source_empty_verified_at: phase === "source_empty" || phase === "metadata_purged" ? new Date("2026-09-21T10:00:02Z") : null,
    local_mail_cleared_at: phase === "metadata_purged" ? new Date("2026-09-21T10:00:03Z") : null,
    metadata_purged_at: phase === "metadata_purged" ? new Date("2026-09-21T10:00:04Z") : null,
  };
  const sql: string[] = [];
  const controller = new AbortController();
  const scope: MaintenanceScope = {
    signal: controller.signal,
    transaction: async (operation) => operation({
      async query(text, values) {
        sql.push(text);
        if (text.includes("claim_account_purge_job")) return { rows: [{ ...current }] };
        if (text.includes("acknowledge_account_purge_revoke")) { current.phase = "deleting_source"; current.revoke_sha256 = String(values?.[3]); }
        if (text.includes("mark_account_purge_source_empty")) { current.phase = "source_empty"; current.source_empty_verified_at = new Date(); }
        if (text.includes("lock_account_purge_mail")) return { rows: [{ account_email: "x@example.test", challenges: [{ id: id.challenge, delivery: "local" }] }] };
        if (text.includes("complete_account_purge_mail")) current.local_mail_cleared_at = new Date();
        if (text.includes("terminal_erase_account_metadata")) { current.phase = "metadata_purged"; current.metadata_purged_at = new Date(); return { rows: [{ ...current }] }; }
        if (text.includes("acknowledge_account_purge_terminal")) current.phase = "purged";
        return { rows: [] };
      },
    }),
  };
  return { current, controller, scope, sql };
}

type PurgeExtras = Partial<Pick<AccountPurgeDependencies, "removeLocalMail" | "now" | "attemptId" | "replacementPasswordHash">>;
function base(
  ledger: AccountPurgeDependencies["ledger"],
  content: AccountPurgeDependencies["content"],
  extra: PurgeExtras = {},
): AccountPurgeDependencies {
  return { ledgerId: id.ledger, ledger, content, attemptId: () => id.attempt, now: () => new Date("2026-09-21T10:00:05Z"), replacementPasswordHash: () => "a".repeat(32) + ":" + "b".repeat(128), ...extra };
}

test("ledger failure prevents any content deletion", async () => {
  const { scope, sql } = makeFixture("awaiting_revoke_ledger");
  let deletes = 0;
  await assert.rejects(runAccountPurge(scope, base({ putIfAbsent: async () => { throw new Error("ledger down"); }, read: async () => { throw new Error(); }, list: async () => ({ items: [] }) }, { listVersions: async () => ({ versions: [], deleteMarkers: [], truncated: false }), deleteVersion: async () => { deletes++; } })));
  assert.equal(deletes, 0);
  assert.equal(sql.some((text) => text.includes("acknowledge_account_purge_revoke")), false);
});

for (const [label, candidate] of [["wrong prefix", { key: "other/object", versionId: "v1" }], ["null version", { key: `${id.tenant}/object`, versionId: null }]] as const) {
  test(`invalid content candidate (${label}) is not deleted or terminal`, async () => {
    const { scope, sql } = makeFixture("deleting_source");
    let deletes = 0;
    await assert.rejects(runAccountPurge(scope, base({ putIfAbsent: async () => { throw new Error(); }, read: async () => { throw new Error(); }, list: async () => ({ items: [] }) }, { listVersions: async () => ({ versions: [candidate as { key?: string; versionId?: string }], deleteMarkers: [], truncated: false }), deleteVersion: async () => { deletes++; } })));
    assert.equal(deletes, 0);
    assert.equal(sql.some((text) => text.includes("terminal_erase_account_metadata") || text.includes("acknowledge_account_purge_terminal")), false);
  });
}

test("abort during content deletion leaves metadata and terminal record untouched", async () => {
  const { scope, controller, sql } = makeFixture("deleting_source");
  let deletes = 0;
  await assert.rejects(runAccountPurge(scope, base({ putIfAbsent: async () => { throw new Error(); }, read: async () => { throw new Error(); }, list: async () => ({ items: [] }) }, { listVersions: async () => ({ versions: [{ key: `${id.tenant}/object`, versionId: "v1" }], deleteMarkers: [], truncated: false }), deleteVersion: async () => { deletes++; controller.abort(); } })));
  assert.equal(deletes, 1);
  assert.deepEqual(sql.filter((text) => text.includes("terminal_erase_account_metadata") || text.includes("acknowledge_account_purge_terminal")), [], sql.join(" | "));
});

test("local mail unlink failure prevents terminal metadata and ledger records", async () => {
  const { scope, sql } = makeFixture("source_empty");
  let ledgerWrites = 0;
  let unlinkCalls = 0;
  await assert.rejects(runAccountPurge(scope, base({ putIfAbsent: async () => { ledgerWrites++; return { versionId: "v1" }; }, read: async () => { throw new Error(); }, list: async () => ({ items: [] }) }, { listVersions: async () => ({ versions: [], deleteMarkers: [], truncated: false }), deleteVersion: async () => {} }, { removeLocalMail: async () => { unlinkCalls++; const error: any = new Error("disk"); error.code = "EIO"; throw error; } })));
  assert.equal(ledgerWrites, 0);
  assert.equal(unlinkCalls, 1);
  assert.equal(sql.some((text) => text.includes("terminal_erase_account_metadata") || text.includes("acknowledge_account_purge_terminal")), false);
});

test("metadata_purged resume writes only terminal ledger proof", async () => {
  const { scope, sql } = makeFixture("metadata_purged");
  let mail = 0; let deletes = 0; let writes = 0;
  const result = await runAccountPurge(scope, base({ putIfAbsent: async () => { writes++; return { versionId: "v1" }; }, read: async () => { throw new Error(); }, list: async () => ({ items: [] }) }, { listVersions: async () => { throw new Error("content should not be read"); }, deleteVersion: async () => { deletes++; } }, { removeLocalMail: async () => { mail++; } }));
  assert.equal(result.terminalRecordsAcknowledged, 1);
  assert.equal(writes, 1); assert.equal(mail, 0); assert.equal(deletes, 0);
  assert.equal(sql.some((text) => text.includes("terminal_erase_account_metadata") || text.includes("acknowledge_account_purge_revoke")), false);
});

test("terminal ledger failure does not acknowledge terminal SQL", async () => {
  const { scope, sql } = makeFixture("metadata_purged");
  await assert.rejects(runAccountPurge(scope, base({ putIfAbsent: async () => { throw new Error("ledger unavailable"); }, read: async () => { throw new Error(); }, list: async () => ({ items: [] }) }, { listVersions: async () => ({ versions: [], deleteMarkers: [], truncated: false }), deleteVersion: async () => {} })));
  assert.equal(sql.some((text) => text.includes("acknowledge_account_purge_terminal")), false);
});
