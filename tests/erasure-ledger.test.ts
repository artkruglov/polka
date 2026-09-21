import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeErasureRecord,
  encodeErasureRecord,
  erasureKey,
  validateErasureLedger,
  validateErasurePair,
  type RevokeRecord,
} from "../packages/erasure-ledger.ts";

const ledgerId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const accountId = "00000000-0000-4000-8000-000000000003";
const tenantId = "00000000-0000-4000-8000-000000000004";
const revoke: RevokeRecord = {
  schemaVersion: 1,
  event: "revoke",
  ledgerId,
  requestId,
  accountId,
  tenantId,
  requestedAt: "2026-01-01T00:00:00.000Z",
  revokedAt: "2026-01-01T00:01:00.000Z",
  policyVersion: "r17.v1",
  workingDataPolicyDeadline: "2026-01-02T00:00:00.000Z",
  backupRetentionPolicyDeadline: "2026-02-01T00:00:00.000Z",
};
function purgedFrom(base = revoke) {
  return {
    ...base,
    event: "purged" as const,
    revokeSha256: encodeErasureRecord(base).sha256,
    sourceEmptyVerifiedAt: "2026-01-01T00:02:00.000Z",
    localMailClearedAt: "2026-01-01T00:03:00.000Z",
    metadataPurgedAt: "2026-01-01T00:04:00.000Z",
  };
}

test("canonical bytes and fixed hash vector are stable", () => {
  const encoded = encodeErasureRecord(revoke);
  const expected = '{"accountId":"00000000-0000-4000-8000-000000000003","backupRetentionPolicyDeadline":"2026-02-01T00:00:00.000Z","event":"revoke","ledgerId":"00000000-0000-4000-8000-000000000001","policyVersion":"r17.v1","requestId":"00000000-0000-4000-8000-000000000002","requestedAt":"2026-01-01T00:00:00.000Z","revokedAt":"2026-01-01T00:01:00.000Z","schemaVersion":1,"tenantId":"00000000-0000-4000-8000-000000000004","workingDataPolicyDeadline":"2026-01-02T00:00:00.000Z"}';
  assert.equal(new TextDecoder().decode(encoded.bytes), expected);
  assert.equal(encoded.sha256, "cdb1fd04053c265ef0e757b0a7ac632bcd22359a76ea2f6f24384cf320b7239b");
  assert.equal(encoded.key, `erasure/v1/${ledgerId}/${requestId}/revoke.json`);
  assert.deepEqual(decodeErasureRecord(encoded.bytes, encoded.key, ledgerId), revoke);
  assert.throws(() => decodeErasureRecord(encoded.bytes, encoded.key.replace("revoke", "purged"), ledgerId), /key mismatch/);
  assert.throws(() => decodeErasureRecord(encoded.bytes, encoded.key, "00000000-0000-4000-8000-000000000099"), /key mismatch/);
});

test("rejects fatal UTF-8, duplicate keys, unknown fields, oversize and noncanonical dates", () => {
  const encoded = encodeErasureRecord(revoke);
  assert.throws(() => decodeErasureRecord(Uint8Array.from([0xc3, 0x28]), encoded.key, ledgerId), /UTF-8/);
  const duplicate = new TextEncoder().encode(
    new TextDecoder().decode(encoded.bytes).replace('"event":"revoke"', '"event":"revoke","event":"revoke"'),
  );
  assert.throws(() => decodeErasureRecord(duplicate, encoded.key, ledgerId));
  assert.throws(() => encodeErasureRecord({ ...revoke, extra: true }));
  assert.throws(() => encodeErasureRecord({ ...revoke, policyVersion: "x".repeat(81) }));
  assert.throws(() => decodeErasureRecord(new Uint8Array(8193), encoded.key, ledgerId));
  assert.throws(() => encodeErasureRecord({ ...revoke, requestedAt: "2026-01-01T00:00:00Z" }));
  assert.throws(() => encodeErasureRecord({ ...revoke, ledgerId: "00000000-0000-4000-8000-00000000000A" }));
  assert.doesNotThrow(() => encodeErasureRecord({ ...revoke, ledgerId: "00000000-0000-1000-8000-000000000005" }));
  assert.throws(() => encodeErasureRecord({ ...revoke, requestedAt: "2026-02-01T00:00:00.000Z" }));
  assert.throws(() => erasureKey({ ledgerId, requestId, event: "revoke" }));
});

test("validates revoke-only, valid pair and late purge", () => {
  assert.equal(validateErasurePair(revoke).state, "revoked");
  const purged = purgedFrom();
  assert.equal(validateErasurePair(revoke, purged).state, "purged");
  const late = { ...purged, metadataPurgedAt: "2027-01-01T00:00:00.000Z" };
  assert.equal(validateErasurePair(revoke, late).state, "purged");
});

test("rejects orphan purged, common-field mismatch and bad revoke hash", () => {
  const purged = purgedFrom();
  assert.throws(() => validateErasurePair(purged), /revoke/);
  const alternatives: Array<[keyof RevokeRecord, string]> = [
    ["ledgerId", "00000000-0000-4000-8000-000000000005"],
    ["requestId", "00000000-0000-4000-8000-000000000006"],
    ["accountId", "00000000-0000-4000-8000-000000000005"],
    ["tenantId", "00000000-0000-4000-8000-000000000005"],
    ["requestedAt", "2026-01-01T00:00:01.000Z"],
    ["revokedAt", "2026-01-01T00:02:00.000Z"],
    ["policyVersion", "r17.v2"],
    ["workingDataPolicyDeadline", "2026-01-03T00:00:00.000Z"],
    ["backupRetentionPolicyDeadline", "2026-03-01T00:00:00.000Z"],
  ];
  for (const [field, value] of alternatives) {
    const changed = { ...revoke, [field]: value } as RevokeRecord;
    assert.throws(() => validateErasurePair(revoke, purgedFrom(changed)), /mismatch/);
  }
  assert.throws(() => validateErasurePair(revoke, { ...purged, revokeSha256: "f".repeat(64) }), /hash/);
});

test("deduplicates identical records and rejects conflicting identities", () => {
  const purged = purgedFrom();
  const otherRequest = { ...revoke, requestId: "00000000-0000-4000-8000-000000000006" };
  const otherTenant = { ...otherRequest, tenantId: "00000000-0000-4000-8000-000000000005" };
  const otherAccount = { ...otherRequest, accountId: "00000000-0000-4000-8000-000000000005" };
  assert.equal(validateErasureLedger([revoke, revoke, purged], ledgerId)[0].state, "purged");
  assert.throws(() => validateErasureLedger([purged], ledgerId), /no revoke/);
  assert.throws(() => validateErasureLedger([revoke, { ...revoke, policyVersion: "other" }], ledgerId), /conflicting/);
  assert.throws(() => validateErasureLedger([revoke, otherRequest], ledgerId), /multiple requests/);
  assert.throws(() => validateErasureLedger([revoke, otherTenant], ledgerId), /multiple requests/);
  assert.throws(() => validateErasureLedger([revoke, otherAccount], ledgerId), /multiple requests/);
  assert.throws(() => validateErasureLedger([revoke], "00000000-0000-4000-8000-000000000099"), /namespace/);
});
