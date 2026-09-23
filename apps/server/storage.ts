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
export const { s3, bucket, prepareBucket, putImmutable, deleteAllVersions } =
  store;

/**
 * An object's bytes. A version that is gone was deleted by moderation
 * (content-moderation.ts): the reader learns that, not a storage error.
 */
export async function readBlob(key: string, version: string) {
  // Isolated by a block (docs/specs/CONTENT_FILTER.md): nobody reads it, the
  // owner included, until it is deleted or the block is lifted.
  const { isolatedObject } = await import("./content-moderation.ts");
  if (await isolatedObject(key))
    throw new Problem(
      410,
      "expired",
      "Содержимое заблокировано модератором Полки и недоступно.",
    );
  try {
    return await store.readBlob(key, version);
  } catch (error: any) {
    const { purgedObject } = await import("./content-moderation.ts");
    if (error?.$metadata?.httpStatusCode === 404 && (await purgedObject(key)))
      throw new Problem(
        410,
        "expired",
        "Содержимое удалено по решению модератора Полки.",
      );
    throw error;
  }
}
