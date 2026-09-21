import { randomUUID } from "node:crypto";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import {
  GetBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../apps/server/config.ts";
import {
  READINESS_KEY,
  READINESS_BYTES,
  READINESS_MAX_BYTES,
} from "../packages/storage/readiness.ts";

if (!process.argv.includes("--confirm-bootstrap"))
  throw new Error(
    "Pass --confirm-bootstrap for the scoped storage capability check",
  );
const client = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  maxAttempts: 1,
  // This one-shot probe deliberately triggers 412. Some S3 servers close that
  // socket; do not reuse it for the following read or retry ambiguous writes.
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 3000,
    httpAgent: new HttpAgent({ keepAlive: false }),
    httpsAgent: new HttpsAgent({ keepAlive: false }),
  },
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});
const Bucket = config.S3_BUCKET;
const key = `polka-system/smoke/${randomUUID()}`;
const ownedVersions: string[] = [];
let uncertainWrite = false;
const signal = AbortSignal.timeout(15000);
const send = (command: any) =>
  client.send(command, { abortSignal: signal }) as Promise<any>;
const validVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value !== "null";
async function readSmall(
  Key: string,
  VersionId?: string,
  expected = READINESS_BYTES,
) {
  const response = await send(
    new GetObjectCommand({ Bucket, Key, ...(VersionId ? { VersionId } : {}) }),
  );
  try {
    if (
      !validVersion(response.VersionId) ||
      (VersionId && response.VersionId !== VersionId)
    )
      throw new Error("Storage version read failed");
    if (response.ContentLength > READINESS_MAX_BYTES)
      throw new Error("Probe object too large");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const part of response.Body) {
      const chunk = Buffer.from(part);
      size += chunk.length;
      if (size > READINESS_MAX_BYTES) throw new Error("Probe object too large");
      chunks.push(chunk);
    }
    if (!Buffer.concat(chunks).equals(expected))
      throw new Error("Probe bytes mismatch");
    return response.VersionId as string;
  } finally {
    response.Body?.destroy?.();
  }
}
let successful = false;
let phase = "versioning";
try {
  const versioning = await send(new GetBucketVersioningCommand({ Bucket }));
  if (versioning.Status !== "Enabled")
    throw new Error("Bucket versioning must already be enabled");
  phase = "canary_create";
  try {
    const canary = await send(
      new PutObjectCommand({
        Bucket,
        Key: READINESS_KEY,
        Body: READINESS_BYTES,
        IfNoneMatch: "*",
        ContentType: "text/plain",
      }),
    );
    if (!validVersion(canary.VersionId))
      throw new Error("Canary version missing");
  } catch (error: any) {
    if (error.$metadata?.httpStatusCode !== 412) throw error;
  }
  phase = "canary_read";
  const canaryVersion = await readSmall(READINESS_KEY);
  await readSmall(READINESS_KEY, canaryVersion);
  const bytes = Buffer.from(`polka-storage-smoke:${randomUUID()}\n`);
  phase = "probe_create";
  uncertainWrite = true;
  const created = await send(
    new PutObjectCommand({ Bucket, Key: key, Body: bytes, IfNoneMatch: "*" }),
  );
  if (!validVersion(created.VersionId))
    throw new Error("Probe version missing");
  ownedVersions.push(created.VersionId);
  uncertainWrite = false;
  phase = "probe_read";
  await readSmall(key, created.VersionId, bytes);
  phase = "conditional_create";
  let conflict = false;
  try {
    uncertainWrite = true;
    const duplicate = await send(
      new PutObjectCommand({ Bucket, Key: key, Body: bytes, IfNoneMatch: "*" }),
    );
    if (validVersion(duplicate.VersionId)) {
      ownedVersions.push(duplicate.VersionId);
      uncertainWrite = false;
    }
  } catch (error: any) {
    if (error.$metadata?.httpStatusCode !== 412) throw error;
    conflict = true;
    uncertainWrite = false;
  }
  if (!conflict) throw new Error("Conditional creation not enforced");
  phase = "version_list";
  const listed = await send(
    new ListObjectVersionsCommand({ Bucket, Prefix: key, MaxKeys: 10 }),
  );
  if (
    listed.IsTruncated ||
    !listed.Versions?.some(
      (v: any) => v.Key === key && v.VersionId === created.VersionId,
    )
  )
    throw new Error("Probe version not listed");
  phase = "version_delete";
  await send(
    new DeleteObjectCommand({ Bucket, Key: key, VersionId: created.VersionId }),
  );
  try {
    await readSmall(key, created.VersionId, bytes);
    throw new Error("Deleted probe remains readable");
  } catch (error: any) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
  }
  ownedVersions.splice(0);
  successful = true;
} catch (error: any) {
  process.exitCode = 1;
  console.error(
    JSON.stringify({
      event: "storage.bootstrap.failed",
      phase,
      reason: [
        "Storage version read failed",
        "Probe object too large",
        "Probe bytes mismatch",
      ].includes(error?.message)
        ? error.message
        : "unexpected",
      errorType: ["TypeError", "AbortError", "Error"].includes(error?.name)
        ? error.name
        : "provider",
      httpStatus: Number.isInteger(error?.$metadata?.httpStatusCode)
        ? error.$metadata.httpStatusCode
        : undefined,
      probeKey: key,
      cleanupPending: uncertainWrite,
    }),
  );
} finally {
  // Cleanup only versions successfully returned for this invocation's unique key.
  // A fresh bounded deadline permits cleanup even when the main check timed out.
  for (const VersionId of ownedVersions) {
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket, Key: key, VersionId }),
        { abortSignal: AbortSignal.timeout(3000) },
      );
    } catch {
      process.exitCode = 1;
      console.error(
        JSON.stringify({
          event: "storage.bootstrap.cleanup_failed",
          probeKey: key,
          cleanupPending: true,
        }),
      );
    }
  }
  client.destroy();
}
if (successful)
  console.log(
    JSON.stringify({
      event: "storage.bootstrap.passed",
      versioning: true,
      exactVersionRead: true,
      conditionalCreate: true,
      versionList: true,
      exactVersionDelete: true,
    }),
  );
