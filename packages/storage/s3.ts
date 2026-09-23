import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
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
    // Some calls run while the owner's rows are locked, so a stalled S3 holds
    // those locks for up to maxAttempts × requestTimeout (60 s). Requests
    // waiting on them get a retryable 503 after the pool's statement_timeout.
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
    }),
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

  /**
   * Delete every version and delete marker of the keys under `prefix` that
   * `keep` does not keep: the only way an object leaves a versioned bucket
   * for good. Returns how many versions were removed.
   */
  async function deleteAllVersions(
    prefix: string,
    matches: (key: string) => boolean = () => true,
  ) {
    let deleted = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 500,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      for (const version of [
        ...(result.Versions ?? []),
        ...(result.DeleteMarkers ?? []),
      ]) {
        if (!version.Key || !version.VersionId || !matches(version.Key))
          continue;
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: version.Key,
            VersionId: version.VersionId,
          }),
        );
        deleted++;
      }
      if (!result.IsTruncated) return deleted;
      keyMarker = result.NextKeyMarker;
      versionIdMarker = result.NextVersionIdMarker;
    }
    throw new Error("Too many object versions to delete");
  }

  return { s3, bucket, prepareBucket, putImmutable, readBlob, deleteAllVersions };
}
