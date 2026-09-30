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
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
/** Parts of a streamed object: S3 wants at least 5 MiB except the last. */
const STREAM_PART_BYTES = 8 * 1024 * 1024;
/** Why putStream refused a stream: nothing was stored. */
export class StreamRejected extends Error {
  constructor(readonly reason: "size" | "sha256" | "format" | "conflict") {
    super(`stream rejected: ${reason}`);
  }
}
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
   * A large object from a stream, in parts, never held whole in memory (a
   * video, docs/specs/PROJECT_VIDEO.md). The bytes must be exactly `size`
   * long with the SHA-256 `sha256`, or nothing is stored: the parts are
   * uploaded first and the object only exists once the last check passes,
   * so a wrong or cut-off file leaves no version behind. `head` sees the
   * first 16 bytes (a format check). Sending the same file again returns the
   * version already stored.
   */
  async function putStream(
    key: string,
    body: AsyncIterable<Buffer | Uint8Array>,
    expected: { size: number; sha256: string; head?: (first: Buffer) => boolean },
  ): Promise<string> {
    const existing = await s3
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .catch((e: any) => {
        if (e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      });
    if (existing) {
      if (
        existing.VersionId &&
        existing.VersionId !== "null" &&
        existing.Metadata?.sha256 === expected.sha256 &&
        existing.ContentLength === expected.size
      )
        return existing.VersionId;
      throw new StreamRejected("conflict");
    }
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: "application/octet-stream",
        Metadata: { sha256: expected.sha256 },
      }),
    );
    if (!UploadId) throw new Error("Storage refused a multipart upload");
    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    let inFlight = null as Promise<void> | null;
    try {
      const hash = createHash("sha256");
      let total = 0;
      let headBytes = Buffer.alloc(0);
      let headChecked = !expected.head;
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      const send = (chunk: Buffer) => {
        const PartNumber = parts.length + 1;
        parts.push({ ETag: "", PartNumber });
        const slot = parts[PartNumber - 1];
        return s3
          .send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId,
              PartNumber,
              Body: chunk,
              ContentLength: chunk.length,
            }),
          )
          .then((result) => {
            if (!result.ETag) throw new Error("Storage returned a part without an ETag");
            slot.ETag = result.ETag;
          });
      };
      const flush = async () => {
        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;
        // One part uploads while the next is read: two parts in memory at most.
        await inFlight;
        inFlight = send(chunk);
      };
      for await (const piece of body) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        if (!headChecked) {
          headBytes = Buffer.concat([headBytes, chunk.subarray(0, 16)]);
          if (headBytes.length >= 16) {
            headChecked = true;
            if (!expected.head!(headBytes)) throw new StreamRejected("format");
          }
        }
        total += chunk.length;
        if (total > expected.size) throw new StreamRejected("size");
        hash.update(chunk);
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes >= STREAM_PART_BYTES) await flush();
      }
      if (total !== expected.size) throw new StreamRejected("size");
      if (!headChecked && !expected.head!(headBytes)) throw new StreamRejected("format");
      if (hash.digest("hex") !== expected.sha256) throw new StreamRejected("sha256");
      if (pendingBytes) await flush();
      await inFlight;
      if (!parts.length) throw new StreamRejected("size");
      const done = await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      if (!done.VersionId || done.VersionId === "null")
        throw new Error("Storage versioning required");
      return done.VersionId;
    } catch (error) {
      await inFlight?.catch(() => undefined);
      await s3
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }))
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * That a stored version has exactly the size and SHA-256 recorded for it
   * (putStream stores the hash as metadata; a copy keeps it), without
   * reading its bytes.
   */
  async function verifyObject(key: string, version: string, size: number, sha: string) {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version }),
    );
    return head.ContentLength === size && head.Metadata?.sha256 === sha;
  }

  /** Delete every version and delete marker of the keys under `prefix` that
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

  return {
    s3,
    bucket,
    prepareBucket,
    putImmutable,
    putStream,
    verifyObject,
    readBlob,
    deleteAllVersions,
  };
}
