import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { createS3Store } from "../../packages/storage/s3.ts";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
export { sha256 } from "../../packages/storage/s3.ts";
const store = createS3Store({
  endpoint: config.S3_ENDPOINT,
  accessKey: config.S3_ACCESS_KEY,
  secretKey: config.S3_SECRET_KEY,
  bucket: config.S3_BUCKET,
});
export const { s3, bucket, prepareBucket, putImmutable, putStream, verifyObject, deleteAllVersions } = store;
export { StreamRejected } from "../../packages/storage/s3.ts";

/** One object version, for good (the bucket is versioned: the key alone would only add a delete marker). */
export async function deleteVersion(key: string, version: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
}

/**
 * A copy of one object version under another key, inside the store (no
 * bytes through Полка). Returns the new version; the bucket is versioned.
 */
export async function copyVersion(fromKey: string, fromVersion: string, toKey: string) {
  const result = await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: toKey,
      CopySource: `${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}?versionId=${encodeURIComponent(fromVersion)}`,
      MetadataDirective: "COPY",
    }),
  );
  if (!result.VersionId || result.VersionId === "null") throw new Error("Storage versioning required");
  return result.VersionId;
}

/**
 * An object's bytes. A version that is gone was deleted by moderation
 * (content-moderation.ts): the reader learns that, not a storage error.
 */
export async function readBlob(key: string, version: string) {
  // Isolated by a block (docs/specs/CONTENT_FILTER.md): nobody reads it, the
  // owner included, until it is deleted or the block is lifted.
  const { isolatedObject } = await import("./content-moderation.ts");
  if (await isolatedObject(key))
    throw new Problem(410, "expired", "Содержимое заблокировано модератором Полки и недоступно.");
  try {
    return await store.readBlob(key, version);
  } catch (error: any) {
    const { purgedObject } = await import("./content-moderation.ts");
    if (error?.$metadata?.httpStatusCode === 404 && (await purgedObject(key)))
      throw new Problem(410, "expired", "Содержимое удалено по решению модератора Полки.");
    throw error;
  }
}

/**
 * A stored object as a stream, whole or one byte range (`bytes=a-b`, already
 * checked against `size`), for a video: never held in memory. Isolated and
 * purged objects answer as readBlob does.
 */
export async function readStream(
  key: string,
  version: string,
  range?: { start: number; end: number },
): Promise<Readable> {
  const { isolatedObject } = await import("./content-moderation.ts");
  if (await isolatedObject(key))
    throw new Problem(410, "expired", "Содержимое заблокировано модератором Полки и недоступно.");
  try {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: version,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    return object.Body as Readable;
  } catch (error: any) {
    const { purgedObject } = await import("./content-moderation.ts");
    if (error?.$metadata?.httpStatusCode === 404 && (await purgedObject(key)))
      throw new Problem(410, "expired", "Содержимое удалено по решению модератора Полки.");
    throw error;
  }
}
