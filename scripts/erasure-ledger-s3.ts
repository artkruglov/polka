import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  ErasureLedgerTransportError,
  type ErasureLedgerTransport,
} from "./erasure-ledger-adapter.ts";

const MAX_BYTES = 8192;
const PAGE_SIZE = 100;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
type Send = (command: any, options?: any) => Promise<any>;
export type ErasureLedgerS3Client = { send: Send };

function active(signal: AbortSignal) {
  if (signal.aborted) throw new Error("operation aborted");
}
function version(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "null";
}
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status = value.$metadata?.httpStatusCode ?? value.status ?? value.statusCode;
  return typeof status === "number" ? status : undefined;
}
function isAmbiguous(error: unknown): boolean {
  const status = statusOf(error);
  return status === undefined || status >= 500;
}
function makeCursor(prefix: string, keyMarker: string, versionIdMarker: string): string {
  return Buffer.from(JSON.stringify({ prefix, keyMarker, versionIdMarker }), "utf8").toString("base64url");
}
function parseCursor(cursor: string, prefix: string): { keyMarker: string; versionIdMarker: string } {
  let parsed: any;
  try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("invalid ledger listing cursor"); }
  if (parsed?.prefix !== prefix || typeof parsed.keyMarker !== "string" || !parsed.keyMarker || typeof parsed.versionIdMarker !== "string" || !parsed.versionIdMarker)
    throw new Error("invalid ledger listing cursor");
  return { keyMarker: parsed.keyMarker, versionIdMarker: parsed.versionIdMarker };
}

async function readBody(body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Uint8Array> {
  active(signal);
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_BYTES) throw new Error("ledger object exceeds 8192 bytes");
    return body;
  }
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function")
    throw new Error("ledger object body is not readable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    const stop = () => reject(new Error("operation aborted"));
    onAbort = stop;
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ledger object body deadline exceeded")), timeoutMs);
  });
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), abort, deadline]);
      if (result.done) break;
      const part = result.value;
      active(signal);
      if (!(part instanceof Uint8Array)) throw new Error("ledger object body yielded a non-byte chunk");
      const chunk = part;
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error("ledger object exceeds 8192 bytes");
      chunks.push(chunk);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    (body as { destroy?: () => void }).destroy?.();
    try {
      const returned = iterator.return?.();
      if (returned && typeof (returned as Promise<unknown>).catch === "function")
        void (returned as Promise<unknown>).catch(() => undefined);
    } catch { /* cleanup must not replace the bounded body error */ }
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function destroyBody(body: unknown) {
  (body as { destroy?: () => void } | undefined)?.destroy?.();
}

async function readVersionedBody(result: any, signal: AbortSignal, timeoutMs: number, expectedVersion?: string) {
  let handedToReader = false;
  try {
    active(signal);
    if (!version(result?.VersionId)) throw new Error("storage read returned no version id");
    if (expectedVersion !== undefined && result.VersionId !== expectedVersion) throw new Error("ledger version mismatch");
    handedToReader = true;
    const bytes = await readBody(result.Body, signal, timeoutMs);
    active(signal);
    return { bytes, versionId: result.VersionId as string };
  } catch (error) {
    if (!handedToReader) destroyBody(result?.Body);
    throw error;
  }
}

function optionalArray(value: unknown, label: string): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`ledger listing has invalid ${label}`);
  return value;
}

export function createErasureLedgerS3Transport(input: {
  client: ErasureLedgerS3Client;
  bucket: string;
  bodyTimeoutMs?: number;
}): ErasureLedgerTransport {
  const bodyTimeoutMs = input.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  if (!Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs <= 0) throw new Error("invalid body timeout");
  const send = (command: unknown, signal: AbortSignal) => input.client.send(command, { abortSignal: signal });
  return {
    async putIfAbsent(key, bytes, signal) {
      active(signal);
      try {
        const result = await send(new PutObjectCommand({ Bucket: input.bucket, Key: key, Body: bytes, IfNoneMatch: "*" }), signal);
        active(signal);
        if (!version(result.VersionId)) throw new Error("storage write returned no version id");
        return { versionId: result.VersionId };
      } catch (error) {
        if (signal.aborted) throw error;
        if (statusOf(error) === 412) throw new ErasureLedgerTransportError("conditional_conflict");
        if (statusOf(error) === 403 || !isAmbiguous(error)) throw error;
        throw new ErasureLedgerTransportError("unknown_write_outcome");
      }
    },
    async read(key, signal) {
      active(signal);
      const result = await send(new GetObjectCommand({ Bucket: input.bucket, Key: key, VersionId: undefined }), signal);
      return readVersionedBody(result, signal, bodyTimeoutMs);
    },
    async list(prefix, cursor, signal) {
      active(signal);
      const marker = cursor === undefined ? undefined : parseCursor(cursor, prefix);
      const result = await send(new ListObjectVersionsCommand({
        Bucket: input.bucket,
        Prefix: prefix,
        KeyMarker: marker?.keyMarker,
        VersionIdMarker: marker?.versionIdMarker,
        MaxKeys: PAGE_SIZE,
      }), signal);
      active(signal);
      if (typeof result.IsTruncated !== "boolean") throw new Error("ledger listing has invalid truncation flag");
      const deleteMarkers = optionalArray(result.DeleteMarkers, "delete marker page");
      const versions = optionalArray(result.Versions, "version page");
      if (deleteMarkers.length) throw new Error("ledger listing contains a delete marker");
      const items: Array<{ key: string; bytes: Uint8Array; versionId: string }> = [];
      for (const listed of versions) {
        if (typeof listed.Key !== "string" || !listed.Key.startsWith(prefix)) throw new Error("ledger listing key outside prefix");
        if (!version(listed.VersionId)) throw new Error("ledger listing version missing");
        active(signal);
        const read = await send(new GetObjectCommand({ Bucket: input.bucket, Key: listed.Key, VersionId: listed.VersionId }), signal);
        const resolved = await readVersionedBody(read, signal, bodyTimeoutMs, listed.VersionId);
        items.push({ key: listed.Key, bytes: resolved.bytes, versionId: listed.VersionId });
      }
      if (!result.IsTruncated) return { items };
      if (!version(result.NextVersionIdMarker) || typeof result.NextKeyMarker !== "string" || !result.NextKeyMarker || !result.NextKeyMarker.startsWith(prefix))
        throw new Error("truncated ledger listing has no continuation cursor");
      return { items, nextCursor: makeCursor(prefix, result.NextKeyMarker, result.NextVersionIdMarker) };
    },
  };
}
