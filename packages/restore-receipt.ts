import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from "./migrations.ts";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const receiptSchema = z
  .object({
    version: z.literal(1),
    restoreRunId: z.string().uuid(),
    backupSha256: sha256Schema,
    targetIdentitySha256: sha256Schema,
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    schemaManifestSha256: sha256Schema,
    ledgerId: z.string().uuid(),
    ledgerManifestSha256: sha256Schema,
  })
  .strict();

export type RestoreCompletionReceipt = z.infer<typeof receiptSchema>;

export type RestoreTargetIdentity = {
  databaseProtocol: string;
  databaseHost: string;
  databasePort: string;
  databaseName: string;
  databaseOid: string;
  storageEndpoint: string;
  storageBucket: string;
};

const MAX_RECEIPT_BYTES = 16 * 1024;

export function sha256Hex(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalDatabaseTarget(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (url.search || url.hash)
    throw new Error("Database URL routing parameters are not supported");
  if (!url.pathname || url.pathname === "/")
    throw new Error("Database URL must name a database");
  return {
    databaseProtocol: url.protocol.toLowerCase(),
    databaseHost: url.hostname.toLowerCase(),
    databasePort: url.port || "5432",
    databaseName: decodeURIComponent(url.pathname.slice(1)),
  };
}

function canonicalStorageOrigin(storageEndpoint: string) {
  const url = new URL(storageEndpoint);
  if (url.search || url.hash)
    throw new Error("Storage endpoint routing parameters are not supported");
  if (url.username || url.password)
    throw new Error("Storage endpoint must not contain credentials");
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin.toLowerCase()}${pathname}`;
}

export function restoreTargetIdentity(input: {
  databaseUrl: string;
  databaseOid: string | number;
  storageEndpoint: string;
  storageBucket: string;
}): RestoreTargetIdentity {
  const database = canonicalDatabaseTarget(input.databaseUrl);
  const databaseOid = String(input.databaseOid);
  if (!/^\d+$/.test(databaseOid)) throw new Error("Database OID is invalid");
  if (!input.storageBucket) throw new Error("Storage bucket is required");
  return Object.freeze({
    ...database,
    databaseOid,
    storageEndpoint: canonicalStorageOrigin(input.storageEndpoint),
    storageBucket: input.storageBucket,
  });
}

export function canonicalTargetIdentity(identity: RestoreTargetIdentity) {
  return JSON.stringify({
    databaseProtocol: identity.databaseProtocol,
    databaseHost: identity.databaseHost,
    databasePort: identity.databasePort,
    databaseName: identity.databaseName,
    databaseOid: identity.databaseOid,
    storageEndpoint: identity.storageEndpoint,
    storageBucket: identity.storageBucket,
  });
}

export function targetIdentitySha256(identity: RestoreTargetIdentity) {
  return sha256Hex(canonicalTargetIdentity(identity));
}

export function schemaManifestSha256(appliedVersions: readonly number[]) {
  return sha256Hex(
    JSON.stringify({
      migrations: SCHEMA_MIGRATIONS.map(({ version, file }) => ({
        version,
        file,
      })),
      appliedVersions: [...appliedVersions],
    }),
  );
}

export function ledgerManifestSha256(
  records: readonly { key: string; versionId: string; sha256: string }[],
) {
  const canonical = records
    .map(({ key, versionId, sha256 }) => ({ key, versionId, sha256 }))
    .sort((left, right) => {
      for (const field of ["key", "versionId", "sha256"] as const) {
        if (left[field] < right[field]) return -1;
        if (left[field] > right[field]) return 1;
      }
      return 0;
    });
  return sha256Hex(JSON.stringify(canonical));
}

export function canonicalRestoreReceipt(input: RestoreCompletionReceipt) {
  const value = receiptSchema.parse(input);
  return `${JSON.stringify({
    version: value.version,
    restoreRunId: value.restoreRunId,
    backupSha256: value.backupSha256,
    targetIdentitySha256: value.targetIdentitySha256,
    schemaVersion: value.schemaVersion,
    schemaManifestSha256: value.schemaManifestSha256,
    ledgerId: value.ledgerId,
    ledgerManifestSha256: value.ledgerManifestSha256,
  })}\n`;
}

export function parseRestoreReceipt(bytes: Uint8Array | string) {
  const text =
    typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES)
    throw new Error("Restore receipt exceeds its size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Restore receipt is invalid");
  }
  const receipt = receiptSchema.parse(parsed);
  if (canonicalRestoreReceipt(receipt) !== text)
    throw new Error("Restore receipt is not canonical");
  return Object.freeze(receipt);
}

export async function readRestoreReceipt(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("Restore receipt must be a regular file");
    if (stat.size > MAX_RECEIPT_BYTES)
      throw new Error("Restore receipt exceeds its size limit");
    const bytes = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_RECEIPT_BYTES)
      throw new Error("Restore receipt exceeds its size limit");
    return parseRestoreReceipt(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Creates once; an exact retry succeeds without replacing the authority file. */
export async function writeRestoreReceipt(
  path: string,
  receipt: RestoreCompletionReceipt,
  options: {
    signal?: AbortSignal;
    /** Deterministic pre-commit seam for cancellation tests. */
    beforePublish?: () => Promise<void>;
  } = {},
) {
  const active = () => {
    if (options.signal?.aborted)
      throw new Error("Restore stopped before completion receipt publication");
  };
  active();
  const canonical = canonicalRestoreReceipt(receipt);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  active();
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(canonical, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforePublish?.();
    // link(2) is the authority commit point. Cancellation after a successful
    // link must never remove this or a pre-existing exact receipt.
    active();
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readRestoreReceipt(path);
      if (canonicalRestoreReceipt(existing) !== canonical)
        throw new Error(
          "Restore receipt already belongs to another restore generation",
        );
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return receipt;
}
