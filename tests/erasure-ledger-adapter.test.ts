import assert from "node:assert/strict";
import test from "node:test";
import {
  appendErasureRecord,
  ErasureLedgerAdapterError,
  ErasureLedgerTransportError,
  readErasureLedger,
  type ErasureLedgerTransport,
} from "../scripts/erasure-ledger-adapter.ts";
import { encodeErasureRecord, type RevokeRecord } from "../packages/erasure-ledger.ts";

const ledgerId = "00000000-0000-4000-8000-000000000001";
const revoke: RevokeRecord = {
  schemaVersion: 1, event: "revoke", ledgerId,
  requestId: "00000000-0000-4000-8000-000000000002",
  accountId: "00000000-0000-4000-8000-000000000003",
  tenantId: "00000000-0000-4000-8000-000000000004",
  requestedAt: "2026-01-01T00:00:00.000Z", revokedAt: "2026-01-01T00:01:00.000Z",
  policyVersion: "r17.v1", workingDataPolicyDeadline: "2026-01-02T00:00:00.000Z",
  backupRetentionPolicyDeadline: "2026-02-01T00:00:00.000Z",
};
const signal = () => new AbortController().signal;
function memoryTransport(): ErasureLedgerTransport & { objects: Map<string, { bytes: Uint8Array; versionId: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; versionId: string }>();
  return {
    objects,
    async putIfAbsent(key, bytes) { if (objects.has(key)) throw new ErasureLedgerTransportError("conditional_conflict"); const versionId = `v${objects.size + 1}`; objects.set(key, { bytes, versionId }); return { versionId }; },
    async read(key) { const value = objects.get(key); if (!value) throw new ErasureLedgerTransportError("unknown_write_outcome"); return value; },
    async list(prefix) { return { items: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, ...value })) }; },
  };
}

test("appends and idempotently replays a 412 record", async () => {
  const transport = memoryTransport();
  const first = await appendErasureRecord(transport, revoke, ledgerId, signal());
  const second = await appendErasureRecord(transport, revoke, ledgerId, signal());
  assert.deepEqual(second, first);
});

test("verifies an unknown write outcome by exact read and rejects conflicts", async () => {
  const encoded = encodeErasureRecord(revoke);
  const transport = memoryTransport();
  transport.putIfAbsent = async (key, bytes) => { transport.objects.set(key, { bytes, versionId: "v-unknown" }); throw new ErasureLedgerTransportError("unknown_write_outcome"); };
  const result = await appendErasureRecord(transport, revoke, ledgerId, signal());
  assert.equal(result.versionId, "v-unknown");
  const conflict = memoryTransport();
  conflict.putIfAbsent = async () => { throw new ErasureLedgerTransportError("unknown_write_outcome"); };
  conflict.read = async () => ({ bytes: Uint8Array.from(encoded.bytes, (byte) => byte ^ 1), versionId: "v1" });
  await assert.rejects(appendErasureRecord(conflict, revoke, ledgerId, signal()), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "remote_conflict");
});

test("rejects bad version, namespace and aborts before transport", async () => {
  const badVersion = memoryTransport();
  badVersion.putIfAbsent = async () => ({ versionId: "null" });
  await assert.rejects(appendErasureRecord(badVersion, revoke, ledgerId, signal()), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "invalid_version");
  await assert.rejects(appendErasureRecord(memoryTransport(), revoke, "00000000-0000-4000-8000-000000000099", signal()), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "namespace_mismatch");
  const controller = new AbortController(); controller.abort();
  let called = false; const transport = memoryTransport(); transport.putIfAbsent = async () => { called = true; return { versionId: "v" }; };
  await assert.rejects(appendErasureRecord(transport, revoke, ledgerId, controller.signal), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "aborted");
  assert.equal(called, false);
  const rejectedAbort = new AbortController();
  let abortReads = 0;
  const abortTransport = memoryTransport();
  abortTransport.putIfAbsent = async () => { rejectedAbort.abort(); throw new Error("aborted by provider"); };
  abortTransport.read = async () => { abortReads++; throw new Error("must not read"); };
  await assert.rejects(appendErasureRecord(abortTransport, revoke, ledgerId, rejectedAbort.signal), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "aborted");
  assert.equal(abortReads, 0);
  let forbiddenReads = 0;
  const forbidden = memoryTransport();
  forbidden.putIfAbsent = async () => { const failure = new Error("forbidden") as Error & { status?: number }; failure.status = 403; throw failure; };
  forbidden.read = async () => { forbiddenReads++; throw new Error("must not read"); };
  await assert.rejects(appendErasureRecord(forbidden, revoke, ledgerId, signal()), (value: unknown) => value instanceof Error && !(value instanceof ErasureLedgerAdapterError) && value.message === "forbidden");
  assert.equal(forbiddenReads, 0);
  let reads = 0;
  const invalid = memoryTransport();
  invalid.list = async () => { reads++; return { items: [] }; };
  await assert.rejects(readErasureLedger(invalid, "bad-ledger", signal()), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "namespace_mismatch");
  assert.equal(reads, 0);
});

test("reads complete paginated ledger and returns canonical records and acknowledgements", async () => {
  const transport = memoryTransport();
  await appendErasureRecord(transport, revoke, ledgerId, signal());
  const pages: Array<string | undefined> = [];
  transport.list = async (prefix, cursor) => { pages.push(cursor); const all = [...transport.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, ...value })); return cursor === undefined ? { items: all.slice(0, 1), nextCursor: "next" } : { items: all.slice(1) }; };
  const result = await readErasureLedger(transport, ledgerId, signal());
  assert.equal(result.entries[0].state, "revoked"); assert.equal(result.records[0].sha256, result.acknowledgements[0].sha256); assert.deepEqual(pages, [undefined, "next"]);
});

test("rejects repeated cursors, foreign/malformed/orphan pages", async () => {
  const repeated = memoryTransport(); repeated.list = async (_prefix, cursor) => ({ items: [], nextCursor: cursor ?? "same" });
  await assert.rejects(readErasureLedger(repeated, ledgerId, signal()), /cursor repeated/);
  const foreign = memoryTransport(); foreign.list = async () => ({ items: [{ key: "erasure/v1/other/x/revoke.json", bytes: new Uint8Array(), versionId: "v1" }] });
  await assert.rejects(readErasureLedger(foreign, ledgerId, signal()), /outside/);
  const malformed = memoryTransport(); malformed.list = async (prefix) => ({ items: [{ key: `${prefix}${revoke.requestId}/revoke.json`, bytes: new TextEncoder().encode("{}"), versionId: "v1" }] });
  await assert.rejects(readErasureLedger(malformed, ledgerId, signal()), (value: unknown) => value instanceof ErasureLedgerAdapterError && value.code === "malformed_remote_record");
  const orphan = memoryTransport(); const purged = { ...revoke, event: "purged" as const, revokeSha256: "a".repeat(64), sourceEmptyVerifiedAt: "2026-01-01T00:02:00.000Z", localMailClearedAt: "2026-01-01T00:03:00.000Z", metadataPurgedAt: "2026-01-01T00:04:00.000Z" }; const encoded = encodeErasureRecord(purged); orphan.objects.set(encoded.key, { bytes: encoded.bytes, versionId: "v1" });
  await assert.rejects(readErasureLedger(orphan, ledgerId, signal()), /no revoke/);
});
