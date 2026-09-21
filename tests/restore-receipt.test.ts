import { CURRENT_SCHEMA_VERSION } from "../packages/migrations.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalRestoreReceipt,
  ledgerManifestSha256,
  parseRestoreReceipt,
  readRestoreReceipt,
  restoreTargetIdentity,
  schemaManifestSha256,
  targetIdentitySha256,
  writeRestoreReceipt,
  type RestoreCompletionReceipt,
} from "../packages/restore-receipt.ts";
import { EXPECTED_MIGRATION_VERSIONS } from "../packages/migrations.ts";

const hex = (value: string) => value.repeat(64).slice(0, 64);
const receipt = (
  overrides: Partial<RestoreCompletionReceipt> = {},
): RestoreCompletionReceipt => ({
  version: 1,
  restoreRunId: "00000000-0000-4000-8000-000000000001",
  backupSha256: hex("a"),
  targetIdentitySha256: hex("b"),
  schemaVersion: CURRENT_SCHEMA_VERSION,
  schemaManifestSha256: schemaManifestSha256(EXPECTED_MIGRATION_VERSIONS),
  ledgerId: "00000000-0000-4000-8000-000000000002",
  ledgerManifestSha256: hex("c"),
  ...overrides,
});

test("restore receipt is canonical, bounded, and atomically retryable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "polka-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "receipt.json");
  await writeRestoreReceipt(target, receipt());
  assert.deepEqual(await readRestoreReceipt(target), receipt());
  await writeRestoreReceipt(target, receipt());
  await assert.rejects(
    writeRestoreReceipt(target, receipt({ backupSha256: hex("d") })),
    /another restore generation/,
  );
  assert.throws(
    () => parseRestoreReceipt(` ${canonicalRestoreReceipt(receipt())}`),
    /not canonical/,
  );
  const oversized = path.join(directory, "oversized.json");
  await writeFile(oversized, Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(readRestoreReceipt(oversized), /size limit/);
  const linked = path.join(directory, "linked.json");
  await symlink(target, linked);
  await assert.rejects(readRestoreReceipt(linked));
  const fifo = path.join(directory, "receipt.fifo");
  await promisify(execFile)("mkfifo", [fifo]);
  await assert.rejects(readRestoreReceipt(fifo), /regular file/);

  const cancelled = path.join(directory, "cancelled.json");
  const controller = new AbortController();
  await assert.rejects(
    writeRestoreReceipt(cancelled, receipt(), {
      signal: controller.signal,
      beforePublish: async () => controller.abort(),
    }),
    /stopped/,
  );
  await assert.rejects(access(cancelled));
  await writeRestoreReceipt(target, receipt(), {
    signal: controller.signal,
  }).catch((error) => assert.match(String(error), /stopped/));
  assert.deepEqual(await readRestoreReceipt(target), receipt());
});

test("target, schema, and ledger hashes have explicit stable identities", () => {
  const first = restoreTargetIdentity({
    databaseUrl: "postgres://alice:secret@LOCALHOST:5432/polka",
    databaseOid: 42,
    storageEndpoint: "http://LOCALHOST:9000/storage/",
    storageBucket: "content",
  });
  const second = restoreTargetIdentity({
    databaseUrl: "postgres://bob:other@localhost/polka",
    databaseOid: "42",
    storageEndpoint: "http://localhost:9000/storage",
    storageBucket: "content",
  });
  assert.equal(targetIdentitySha256(first), targetIdentitySha256(second));
  assert.notEqual(
    targetIdentitySha256(first),
    targetIdentitySha256({ ...second, databaseOid: "43" }),
  );
  assert.notEqual(
    targetIdentitySha256(first),
    targetIdentitySha256({
      ...second,
      storageEndpoint: "http://localhost:9000/other",
    }),
  );
  const records = [
    { key: "b", versionId: "2", sha256: hex("b") },
    { key: "a", versionId: "1", sha256: hex("a") },
  ];
  assert.equal(
    ledgerManifestSha256(records),
    ledgerManifestSha256([...records].reverse()),
  );
  assert.notEqual(
    schemaManifestSha256(EXPECTED_MIGRATION_VERSIONS),
    schemaManifestSha256(EXPECTED_MIGRATION_VERSIONS.slice(0, -1)),
  );
});
