import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type DrillRole = "source" | "target";

export const fingerprint = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function assertPlainLoopbackUrl(value: URL, label: string) {
  if (
    !["127.0.0.1", "localhost"].includes(value.hostname) ||
    value.search !== "" ||
    value.hash !== ""
  )
    throw new Error(`${label} must be a plain loopback URL`);
}

export function databaseName(drillId: string, role: DrillRole) {
  return `polka_restore_drill_${drillId}_${role}`;
}

export function bucketName(drillId: string, role: DrillRole) {
  return `polka-restore-drill-${drillId}-${role}`;
}

export function assertDrillIdentity(
  drillId: string,
  role: DrillRole,
  database: string,
  bucket: string,
) {
  const safeId = /^[a-z0-9]{10,24}$/.test(drillId);
  if (
    !safeId ||
    database !== databaseName(drillId, role) ||
    bucket !== bucketName(drillId, role) ||
    !/^polka_restore_drill_[a-z0-9]{10,24}_(source|target)$/.test(database) ||
    !/^polka-restore-drill-[a-z0-9]{10,24}-(source|target)$/.test(bucket)
  )
    throw new Error("Unsafe restore drill identity");
}

export function assertSeparatedIdentities(input: {
  workingDatabase: string;
  sourceDatabase: string;
  targetDatabase: string;
  workingBucket: string;
  sourceBucket: string;
  targetBucket: string;
  sourceEndpoint: string;
  targetEndpoint: string;
}) {
  const databases = [
    input.workingDatabase,
    input.sourceDatabase,
    input.targetDatabase,
  ];
  if (new Set(databases).size !== databases.length)
    throw new Error("Restore drill databases must be distinct");
  const buckets = [input.workingBucket, input.sourceBucket, input.targetBucket];
  if (new Set(buckets).size !== buckets.length)
    throw new Error("Restore drill buckets must be distinct");
  if (input.sourceEndpoint !== input.targetEndpoint)
    throw new Error(
      "Local drill source and target must use one reviewed S3 service",
    );
}

export function encryptSecret(secret: string, wrappingKey: Buffer) {
  if (wrappingKey.length !== 32) throw new Error("Invalid wrapping key");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(payload: Buffer, wrappingKey: Buffer) {
  if (wrappingKey.length !== 32 || payload.length < 29)
    throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    wrappingKey,
    payload.subarray(0, 12),
  );
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([
    decipher.update(payload.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
