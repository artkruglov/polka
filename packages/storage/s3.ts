import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function createS3Store(config: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}) {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
  const bucket = config.bucket;
  async function prepareBucket() {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode !== 404) throw e;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
  }
  async function putImmutable(key: string, bytes: Buffer) {
    const hash = sha256(bytes);
    try {
      const result = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Metadata: { sha256: hash },
        }),
      );
      if (!result.VersionId || result.VersionId === "null")
        throw new Error("Storage versioning required");
      return result.VersionId;
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode !== 412) throw e;
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (
        !head.VersionId ||
        head.Metadata?.sha256 !== hash ||
        head.ContentLength !== bytes.length
      )
        throw new Error("Immutable object conflict");
      const existing = await readBlob(key, head.VersionId);
      if (sha256(existing) !== hash)
        throw new Error("Stored bytes checksum mismatch");
      return head.VersionId;
    }
  }
  async function readBlob(key: string, version: string) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version }),
    );
    return Buffer.from(await object.Body!.transformToByteArray());
  }

  return { s3, bucket, prepareBucket, putImmutable, readBlob };
}
