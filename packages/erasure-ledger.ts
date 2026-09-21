import { createHash } from "node:crypto";
import { z } from "zod";

const MAX_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const POLICY = /^[A-Za-z0-9._-]{1,80}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const uuid = z.string().regex(UUID);
const sha256 = z.string().regex(SHA256);
const timestamp = z.string().refine((value) => {
  if (!TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, "invalid canonical UTC timestamp");
const common = {
  schemaVersion: z.literal(1),
  ledgerId: uuid,
  requestId: uuid,
  accountId: uuid,
  tenantId: uuid,
  requestedAt: timestamp,
  revokedAt: timestamp,
  policyVersion: z.string().regex(POLICY),
  workingDataPolicyDeadline: timestamp,
  backupRetentionPolicyDeadline: timestamp,
} as const;

const revokeSchema = z.object({ ...common, event: z.literal("revoke") }).strict();
const purgedSchema = z.object({
  ...common,
  event: z.literal("purged"),
  revokeSha256: sha256,
  sourceEmptyVerifiedAt: timestamp,
  localMailClearedAt: timestamp,
  metadataPurgedAt: timestamp,
}).strict();
const recordSchema = z.discriminatedUnion("event", [revokeSchema, purgedSchema]);

export type RevokeRecord = z.infer<typeof revokeSchema>;
export type PurgedRecord = z.infer<typeof purgedSchema>;
export type ErasureRecord = RevokeRecord | PurgedRecord;
export type ErasureEntry = {
  requestId: string;
  accountId: string;
  tenantId: string;
  state: "revoked" | "purged";
  revoke: RevokeRecord;
  purged?: PurgedRecord;
};

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) throw new Error("arrays are not allowed");
  if (value === null || typeof value !== "object") {
    if (typeof value === "undefined" || typeof value === "function")
      throw new Error("unsupported JSON value");
    return JSON.stringify(value);
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key])}`).join(",")}}`;
}

function canonicalBytes(record: ErasureRecord): Uint8Array {
  return new TextEncoder().encode(canonicalValue(record));
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertTimeline(record: ErasureRecord) {
  const requested = Date.parse(record.requestedAt);
  const revoked = Date.parse(record.revokedAt);
  if (requested > revoked) throw new Error("requestedAt must not be after revokedAt");
  for (const deadline of [record.workingDataPolicyDeadline, record.backupRetentionPolicyDeadline])
    if (Date.parse(deadline) < requested) throw new Error("policy deadline precedes request");
  if (record.event === "purged") {
    const metadata = Date.parse(record.metadataPurgedAt);
    if (Date.parse(record.sourceEmptyVerifiedAt) < revoked || Date.parse(record.localMailClearedAt) < revoked)
      throw new Error("purge proof precedes revoke");
    if (Date.parse(record.sourceEmptyVerifiedAt) > metadata || Date.parse(record.localMailClearedAt) > metadata)
      throw new Error("purge proof follows metadata purge");
  }
}

function parseRecord(input: unknown): ErasureRecord {
  const record = recordSchema.parse(input);
  assertTimeline(record);
  return record;
}

function recordKey(record: ErasureRecord): string {
  return `erasure/v1/${record.ledgerId}/${record.requestId}/${record.event}.json`;
}

export function erasureKey(recordInput: unknown): string {
  return recordKey(parseRecord(recordInput));
}

export function encodeErasureRecord(recordInput: unknown) {
  const record = parseRecord(recordInput);
  const bytes = canonicalBytes(record);
  if (bytes.byteLength > MAX_BYTES) throw new Error("record exceeds 8192 bytes");
  return { record, key: recordKey(record), bytes, sha256: hashBytes(bytes) };
}

export function decodeErasureRecord(
  bytesInput: Uint8Array,
  expectedKey: string,
  expectedLedgerId: string,
): ErasureRecord {
  if (bytesInput.byteLength > MAX_BYTES) throw new Error("record exceeds 8192 bytes");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytesInput);
  } catch {
    throw new Error("invalid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }
  const encoded = encodeErasureRecord(parsed);
  if (encoded.key !== expectedKey || encoded.record.ledgerId !== expectedLedgerId)
    throw new Error("ledger key mismatch");
  if (encoded.bytes.length !== bytesInput.length || encoded.bytes.some((byte, index) => byte !== bytesInput[index]))
    throw new Error("non-canonical JSON");
  return encoded.record;
}

function commonOf(record: ErasureRecord) {
  const { event: _event, revokeSha256: _hash, sourceEmptyVerifiedAt: _source, localMailClearedAt: _mail, metadataPurgedAt: _metadata, ...value } = record as ErasureRecord & Partial<PurgedRecord>;
  return value;
}

export function validateErasurePair(revokeInput: unknown, purgedInput?: unknown): ErasureEntry {
  const revoke = parseRecord(revokeInput);
  if (revoke.event !== "revoke") throw new Error("revoke record required");
  if (purgedInput === undefined)
    return { requestId: revoke.requestId, accountId: revoke.accountId, tenantId: revoke.tenantId, state: "revoked", revoke };
  const purged = parseRecord(purgedInput);
  if (purged.event !== "purged") throw new Error("purged record required");
  if (JSON.stringify(commonOf(revoke)) !== JSON.stringify(commonOf(purged)))
    throw new Error("common ledger fields mismatch");
  if (purged.revokeSha256 !== encodeErasureRecord(revoke).sha256)
    throw new Error("revoke hash mismatch");
  return { requestId: revoke.requestId, accountId: revoke.accountId, tenantId: revoke.tenantId, state: "purged", revoke, purged };
}

export function validateErasureLedger(recordsInput: readonly unknown[], expectedLedgerId: string): ErasureEntry[] {
  if (!UUID.test(expectedLedgerId)) throw new Error("invalid expected ledger id");
  const records = recordsInput.map(parseRecord);
  const groups = new Map<string, { revoke?: RevokeRecord; purged?: PurgedRecord; hashes: Set<string> }>();
  for (const record of records) {
    if (record.ledgerId !== expectedLedgerId) throw new Error("ledger namespace mismatch");
    const encoded = encodeErasureRecord(record);
    const group = groups.get(record.requestId) ?? { hashes: new Set<string>() };
    if (group.hashes.has(encoded.sha256)) continue;
    group.hashes.add(encoded.sha256);
    if (record.event === "revoke") {
      if (group.revoke) throw new Error("conflicting revoke records");
      group.revoke = record;
    } else {
      if (group.purged) throw new Error("conflicting purged records");
      group.purged = record;
    }
    groups.set(record.requestId, group);
  }
  const entries: ErasureEntry[] = [];
  const accounts = new Map<string, string>();
  const tenants = new Map<string, string>();
  for (const [requestId, group] of groups) {
    if (!group.revoke) throw new Error("purged record has no revoke");
    const entry = validateErasurePair(group.revoke, group.purged);
    const previousAccount = accounts.get(entry.accountId);
    const previousTenant = tenants.get(entry.tenantId);
    if ((previousAccount && previousAccount !== requestId) || (previousTenant && previousTenant !== requestId))
      throw new Error("account or tenant appears in multiple requests");
    accounts.set(entry.accountId, requestId);
    tenants.set(entry.tenantId, requestId);
    entries.push(entry);
  }
  return entries.sort((a, b) => a.requestId.localeCompare(b.requestId));
}
