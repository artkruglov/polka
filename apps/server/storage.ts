import { createS3Store } from "../../packages/storage/s3.ts";
import { config } from "./config.ts";
export { sha256 } from "../../packages/storage/s3.ts";
export const { s3, bucket, prepareBucket, putImmutable, readBlob } =
  createS3Store({
    endpoint: config.S3_ENDPOINT,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  });
