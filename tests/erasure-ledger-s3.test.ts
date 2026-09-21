import assert from "node:assert/strict";
import test from "node:test";
import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { type ErasureLedgerS3Client, createErasureLedgerS3Transport } from "../scripts/erasure-ledger-s3.ts";
import { ErasureLedgerTransportError } from "../scripts/erasure-ledger-adapter.ts";

const bucket = "journal";
const key = "erasure/v1/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/revoke.json";
const body = new TextEncoder().encode("canonical");
const signal = () => new AbortController().signal;
function client(send: (command: any, options: any) => Promise<any>): ErasureLedgerS3Client { return { send }; }
function stream(bytes: Uint8Array, onDestroy?: () => void) { return { async *[Symbol.asyncIterator]() { yield bytes; }, destroy: onDestroy }; }

test("puts with IfNoneMatch and propagates exact version", async () => {
  let seen: any;
  const transport = createErasureLedgerS3Transport({ bucket, client: client(async (command) => { seen = command; return { VersionId: "v1" }; }) });
  assert.deepEqual(await transport.putIfAbsent(key, body, signal()), { versionId: "v1" });
  assert.equal(seen instanceof PutObjectCommand, true);
  assert.equal(seen.input.Bucket, bucket); assert.equal(seen.input.Key, key); assert.equal(seen.input.IfNoneMatch, "*"); assert.deepEqual(seen.input.Body, body);
});

test("normalizes only 412 and ambiguous outcomes; definite 403 does not read", async () => {
  for (const failure of [Object.assign(new Error("412"), { $metadata: { httpStatusCode: 412 } }), Object.assign(new Error("timeout"), { $metadata: { httpStatusCode: 500 } })]) {
    const transport = createErasureLedgerS3Transport({ bucket, client: client(async () => { throw failure; }) });
    await assert.rejects(transport.putIfAbsent(key, body, signal()), (value: unknown) => value instanceof ErasureLedgerTransportError && value.code === (failure.$metadata.httpStatusCode === 412 ? "conditional_conflict" : "unknown_write_outcome"));
  }
  let calls = 0;
  const forbidden = createErasureLedgerS3Transport({ bucket, client: client(async () => { calls++; throw Object.assign(new Error("forbidden"), { $metadata: { httpStatusCode: 403 } }); }) });
  await assert.rejects(forbidden.putIfAbsent(key, body, signal()), /forbidden/);
  assert.equal(calls, 1);
});

test("pins every listed version on GetObject and returns exact VersionId", async () => {
  const commands: any[] = [];
  const transport = createErasureLedgerS3Transport({ bucket, client: client(async (command) => {
    commands.push(command);
    if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false, DeleteMarkers: [], Versions: [{ Key: key, VersionId: "v9" }] };
    return { VersionId: "v9", Body: stream(body) };
  }) });
  const page = await transport.list("erasure/v1/00000000-0000-4000-8000-000000000001/", undefined, signal());
  assert.equal(page.items[0].versionId, "v9");
  const get = commands.find((command) => command instanceof GetObjectCommand);
  assert.equal(get?.input.VersionId, "v9");
  const read = await transport.read(key, signal());
  assert.equal(read.versionId, "v9");
});

test("rejects delete markers, malformed cursor and truncated pages without cursor", async () => {
  const marker = createErasureLedgerS3Transport({ bucket, client: client(async () => ({ IsTruncated: false, DeleteMarkers: [{ Key: key, VersionId: "v1" }], Versions: [] })) });
  await assert.rejects(marker.list("erasure/v1/x/", undefined, signal()), /delete marker/);
  const malformed = createErasureLedgerS3Transport({ bucket, client: client(async () => { throw new Error("must not send"); }) });
  await assert.rejects(malformed.list("erasure/v1/x/", "bad", signal()), /invalid ledger listing cursor/);
  const truncated = createErasureLedgerS3Transport({ bucket, client: client(async () => ({ IsTruncated: true, DeleteMarkers: [], Versions: [] })) });
  await assert.rejects(truncated.list("erasure/v1/x/", undefined, signal()), /no continuation cursor/);
});

test("bounds and aborts streamed bodies", async () => {
  const oversized = createErasureLedgerS3Transport({ bucket, client: client(async () => ({ VersionId: "v1", Body: stream(new Uint8Array(8193)) })) });
  await assert.rejects(oversized.read(key, signal()), /exceeds 8192/);
  const controller = new AbortController(); let destroyed = false;
  const aborted = createErasureLedgerS3Transport({ bucket, client: client(async () => ({ VersionId: "v1", Body: { async *[Symbol.asyncIterator]() { yield new Uint8Array([1]); controller.abort(); yield new Uint8Array([2]); }, destroy() { destroyed = true; } } })) });
  await assert.rejects(aborted.read(key, controller.signal), /aborted/);
  assert.equal(destroyed, true);
});

test("rejects malformed pages and a paused body within the configured deadline", async () => {
  const malformed = createErasureLedgerS3Transport({ bucket, client: client(async () => ({})) });
  await assert.rejects(malformed.list("erasure/v1/x/", undefined, signal()), /truncation flag/);
  const paused = createErasureLedgerS3Transport({
    bucket,
    bodyTimeoutMs: 10,
    client: client(async () => ({ VersionId: "v1", Body: { async *[Symbol.asyncIterator]() { await new Promise(() => undefined); } } })),
  });
  await assert.rejects(paused.read(key, signal()), /deadline/);
});

test("accepts SDK-shaped optional empty page arrays", async () => {
  const empty = createErasureLedgerS3Transport({ bucket, client: client(async () => ({ IsTruncated: false })) });
  assert.deepEqual(await empty.list("erasure/v1/x/", undefined, signal()), { items: [] });
  const versionsOnly = createErasureLedgerS3Transport({ bucket, client: client(async (command) => {
    if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] };
    return { VersionId: "v1", Body: stream(body) };
  }) });
  const page = await versionsOnly.list("erasure/v1/00000000-0000-4000-8000-000000000001/", undefined, signal());
  assert.equal(page.items.length, 1);
});

test("destroys bodies when GetObject returns no version", async () => {
  let destroyed = false;
  const transport = createErasureLedgerS3Transport({
    bucket,
    client: client(async () => ({ Body: { destroy() { destroyed = true; } } })),
  });
  await assert.rejects(transport.read(key, signal()), /no version/);
  assert.equal(destroyed, true);
});

test("destroys a pinned body on version mismatch and contains iterator cleanup rejection", async () => {
  let destroyed = false;
  const listing = createErasureLedgerS3Transport({ bucket, client: client(async (command) => {
    if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] };
    return { VersionId: "wrong", Body: { async *[Symbol.asyncIterator]() { yield body; }, destroy() { destroyed = true; } } };
  }) });
  await assert.rejects(listing.list("erasure/v1/00000000-0000-4000-8000-000000000001/", undefined, signal()), /version mismatch/);
  assert.equal(destroyed, true);
  let returnCalls = 0;
  const rejectedReturn = createErasureLedgerS3Transport({ bodyTimeoutMs: 5, bucket, client: client(async () => ({ VersionId: "v1", Body: {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<never>(() => undefined),
        return() { returnCalls += 1; return Promise.reject(new Error("cleanup failure")); },
      };
    },
    destroy() {},
  } })) });
  await assert.rejects(rejectedReturn.read(key, signal()), /deadline/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returnCalls, 1);
});
