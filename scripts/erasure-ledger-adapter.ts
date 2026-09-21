import {
  decodeErasureRecord,
  encodeErasureRecord,
  erasureKey,
  validateErasureLedger,
  type ErasureEntry,
  type ErasureRecord,
} from "../packages/erasure-ledger.ts";

export type ErasureLedgerTransport = {
  putIfAbsent: (key: string, bytes: Uint8Array, signal: AbortSignal) => Promise<{ versionId: string }>;
  read: (key: string, signal: AbortSignal) => Promise<{ bytes: Uint8Array; versionId: string }>;
  list: (prefix: string, cursor: string | undefined, signal: AbortSignal) => Promise<{
    items: Array<{ key: string; bytes: Uint8Array; versionId: string }>;
    nextCursor?: string;
  }>;
};

export type ErasureLedgerAdapterErrorCode =
  | "invalid_record"
  | "invalid_version"
  | "namespace_mismatch"
  | "malformed_remote_record"
  | "remote_conflict"
  | "unknown_write_outcome"
  | "cursor_cycle"
  | "aborted";

export type ErasureLedgerTransportErrorCode =
  | "conditional_conflict"
  | "unknown_write_outcome";

export class ErasureLedgerTransportError extends Error {
  constructor(
    public readonly code: ErasureLedgerTransportErrorCode,
    message = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ErasureLedgerTransportError";
  }
}

export class ErasureLedgerAdapterError extends Error {
  constructor(
    public readonly code: ErasureLedgerAdapterErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ErasureLedgerAdapterError";
  }
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new ErasureLedgerAdapterError("aborted", "operation aborted");
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "null";
}

function wrapRecordError(error: unknown): ErasureLedgerAdapterError {
  if (error instanceof ErasureLedgerAdapterError) return error;
  return new ErasureLedgerAdapterError("invalid_record", "invalid erasure record", { cause: error });
}

function isConditionalConflict(error: unknown): boolean {
  return error instanceof ErasureLedgerTransportError && error.code === "conditional_conflict";
}

function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ErasureLedgerTransportError && error.code === "unknown_write_outcome";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function verifyExisting(
  transport: ErasureLedgerTransport,
  key: string,
  expectedBytes: Uint8Array,
  expectedSha256: string,
  expectedLedgerId: string,
  signal: AbortSignal,
): Promise<{ versionId: string }> {
  assertActive(signal);
  let existing: { bytes: Uint8Array; versionId: string };
  try {
    existing = await transport.read(key, signal);
  } catch (error) {
    if (signal.aborted)
      throw new ErasureLedgerAdapterError("aborted", "operation aborted", { cause: error });
    throw new ErasureLedgerAdapterError("unknown_write_outcome", "write outcome could not be verified", { cause: error });
  }
  assertActive(signal);
  if (!validVersion(existing.versionId))
    throw new ErasureLedgerAdapterError("invalid_version", "remote record has no version id");
  if (!bytesEqual(existing.bytes, expectedBytes))
    throw new ErasureLedgerAdapterError("remote_conflict", "remote record bytes conflict");
  try {
    const decoded = decodeErasureRecord(existing.bytes, key, expectedLedgerId);
    const encoded = encodeErasureRecord(decoded);
    if (encoded.sha256 !== expectedSha256 || !bytesEqual(encoded.bytes, expectedBytes))
      throw new Error("hash mismatch");
  } catch (error) {
    if (signal.aborted)
      throw new ErasureLedgerAdapterError("aborted", "operation aborted", { cause: error });
    if (error instanceof ErasureLedgerAdapterError) throw error;
    throw new ErasureLedgerAdapterError("malformed_remote_record", "remote record is not the expected canonical record", { cause: error });
  }
  return { versionId: existing.versionId };
}

export async function appendErasureRecord(
  transport: ErasureLedgerTransport,
  recordInput: unknown,
  expectedLedgerId: string,
  signal: AbortSignal,
) {
  let encoded: ReturnType<typeof encodeErasureRecord>;
  try {
    encoded = encodeErasureRecord(recordInput);
  } catch (error) {
    throw wrapRecordError(error);
  }
  if (encoded.record.ledgerId !== expectedLedgerId)
    throw new ErasureLedgerAdapterError("namespace_mismatch", "record ledger does not match expected ledger");
  assertActive(signal);
  try {
    const result = await transport.putIfAbsent(encoded.key, encoded.bytes, signal);
    assertActive(signal);
    if (!validVersion(result.versionId)) throw new ErasureLedgerAdapterError("invalid_version", "write returned no version id");
    return { key: encoded.key, sha256: encoded.sha256, versionId: result.versionId };
  } catch (error) {
    if (signal.aborted)
      throw new ErasureLedgerAdapterError("aborted", "operation aborted", { cause: error });
    if (error instanceof ErasureLedgerAdapterError) throw error;
    if (!isConditionalConflict(error) && !isUnknownOutcome(error)) throw error;
    return {
      key: encoded.key,
      sha256: encoded.sha256,
      ...(await verifyExisting(transport, encoded.key, encoded.bytes, encoded.sha256, expectedLedgerId, signal)),
    };
  }
}

export async function readErasureLedger(
  transport: ErasureLedgerTransport,
  ledgerId: string,
  signal: AbortSignal,
): Promise<{
  entries: ErasureEntry[];
  records: Array<{ key: string; record: ErasureRecord; sha256: string }>;
  acknowledgements: Array<{ key: string; versionId: string; sha256: string }>;
}> {
  try {
    validateErasureLedger([], ledgerId);
  } catch (error) {
    throw new ErasureLedgerAdapterError("namespace_mismatch", "invalid ledger namespace", { cause: error });
  }
  const prefix = `erasure/v1/${ledgerId}/`;
  const records: Array<{ key: string; record: ErasureRecord; sha256: string }> = [];
  const acknowledgements: Array<{ key: string; versionId: string; sha256: string }> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    assertActive(signal);
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new ErasureLedgerAdapterError("cursor_cycle", "ledger listing cursor repeated");
      cursors.add(cursor);
    }
    let page: Awaited<ReturnType<ErasureLedgerTransport["list"]>>;
    try {
      page = await transport.list(prefix, cursor, signal);
    } catch (error) {
      if (signal.aborted) throw new ErasureLedgerAdapterError("aborted", "operation aborted", { cause: error });
      throw error;
    }
    assertActive(signal);
    for (const item of page.items) {
      if (!item.key.startsWith(prefix)) throw new ErasureLedgerAdapterError("namespace_mismatch", "listed key is outside ledger namespace");
      if (!validVersion(item.versionId)) throw new ErasureLedgerAdapterError("invalid_version", "listed record has no version id");
      try {
        const record = decodeErasureRecord(item.bytes, item.key, ledgerId);
        const encoded = encodeErasureRecord(record);
        records.push({ key: item.key, record, sha256: encoded.sha256 });
        acknowledgements.push({ key: item.key, versionId: item.versionId, sha256: encoded.sha256 });
      } catch (error) {
        throw new ErasureLedgerAdapterError("malformed_remote_record", "listed record is malformed", { cause: error });
      }
    }
    if (page.nextCursor === undefined) break;
    if (page.nextCursor === cursor || cursors.has(page.nextCursor))
      throw new ErasureLedgerAdapterError("cursor_cycle", "ledger listing cursor repeated");
    cursor = page.nextCursor;
  }
  const entries = validateErasureLedger(records.map((item) => item.record), ledgerId);
  return { entries, records, acknowledgements };
}
