// Returns lost objects of the works bucket from its copy (deploy/hosted
// README.md, «Копия работ»). Every object version the database refers to is
// checked in S3_BUCKET; a version that is gone is read from MIRROR_BUCKET
// (the newest version of the same key there, a delete marker skipped),
// checked against its SHA-256, written back to S3_BUCKET and the rows that
// referred to the old version are pointed at the new one. Objects of works
// whose content moderation erased (content_purged_at) stay gone. Without
// --apply it only reports what it would do.
//
//   objects-restore.ts [--apply] [--limit N] [--key <object key>]
//
// DATABASE_URL: the schema owner (it updates the rows); S3_*: the app key;
// MIRROR_READ_ACCESS_KEY / MIRROR_READ_SECRET_KEY: a key that may read
// MIRROR_BUCKET.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import pg from "pg";
import { createS3Store, sha256 } from "../packages/storage/s3.ts";

/** Every place that names an object version of S3_BUCKET. */
export const OBJECT_REFERENCES = [
  { table: "revisions", key: "object_key", version: "object_version", revision: "id" },
  { table: "revision_files", key: "object_key", version: "object_version", revision: "revision_id" },
  { table: "revision_derivatives", key: "object_key", version: "object_version", revision: "revision_id" },
  { table: "upload_files", key: "object_key", version: "object_version", revision: null },
  { table: "agent_sessions", key: "transcript_key", version: "transcript_version", revision: null },
] as const;

/** Larger objects go back in parts, never whole in memory. */
const IN_MEMORY_BYTES = 64 * 1024 * 1024;

export function referencesQuery() {
  return OBJECT_REFERENCES.map(
    (ref) =>
      `SELECT DISTINCT ${ref.key} AS key, ${ref.version} AS version FROM ${ref.table} t
       WHERE ${ref.key} IS NOT NULL AND ${ref.version} IS NOT NULL` +
      (ref.revision
        ? ` AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id = t.${ref.revision} AND r.content_purged_at IS NOT NULL)`
        : ""),
  ).join("\nUNION\n");
}

function client(endpoint: string, accessKeyId: string, secretAccessKey: string) {
  return new S3Client({
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 120_000 }),
  });
}

const status = (error: any) => error?.$metadata?.httpStatusCode as number | undefined;

export async function runObjectsRestore(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: "boolean", default: false },
      limit: { type: "string" },
      key: { type: "string", multiple: true },
    },
  });
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name}`);
    return value;
  };
  const endpoint = env("S3_ENDPOINT");
  const bucket = env("S3_BUCKET");
  const mirrorBucket = env("MIRROR_BUCKET");
  if (mirrorBucket === bucket) throw new Error("MIRROR_BUCKET is S3_BUCKET");
  const store = createS3Store({ endpoint, accessKey: env("S3_ACCESS_KEY"), secretKey: env("S3_SECRET_KEY"), bucket });
  const mirror = client(endpoint, env("MIRROR_READ_ACCESS_KEY"), env("MIRROR_READ_SECRET_KEY"));
  const db = new pg.Client({ connectionString: env("DATABASE_URL") });
  await db.connect();
  const limit = values.limit ? Number(values.limit) : Infinity;
  const counts = { referenced: 0, present: 0, missing: 0, restored: 0, unavailable: 0 };
  try {
    const only = values.key?.length ? values.key : null;
    const { rows } = await db.query<{ key: string; version: string }>(
      only ? `SELECT * FROM (${referencesQuery()}) refs WHERE key = ANY($1)` : referencesQuery(),
      only ? [only] : [],
    );
    counts.referenced = rows.length;
    for (const { key, version } of rows) {
      if (counts.missing >= limit) break;
      try {
        await store.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
        counts.present++;
        continue;
      } catch (error) {
        // 400: a version id the store does not know at all (another bucket's).
        if (![400, 404].includes(status(error) ?? 0)) throw error;
      }
      counts.missing++;
      const source = await newestCopy(mirror, mirrorBucket, key);
      if (!source) {
        counts.unavailable++;
        console.log(`unavailable ${key} ${version}: no version in ${mirrorBucket}`);
        continue;
      }
      if (!values.apply) {
        console.log(`would restore ${key} ${version} from ${mirrorBucket} version ${source}`);
        continue;
      }
      const restored = await copyBack(mirror, mirrorBucket, store, key, source);
      await db.query("BEGIN");
      try {
        for (const ref of OBJECT_REFERENCES)
          await db.query(`UPDATE ${ref.table} SET ${ref.version}=$3 WHERE ${ref.key}=$1 AND ${ref.version}=$2`, [
            key,
            version,
            restored,
          ]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      counts.restored++;
      console.log(`restored ${key} ${version} -> ${restored}`);
    }
  } finally {
    await db.end();
    mirror.destroy();
    store.s3.destroy();
  }
  console.log(
    `${counts.referenced} referenced, ${counts.present} present, ${counts.missing} missing, ` +
      `${values.apply ? `${counts.restored} restored` : "dry run (--apply restores)"}, ${counts.unavailable} not in the copy`,
  );
  return counts.unavailable ? 1 : 0;
}

/** The newest real version of `key` in the copy, a delete marker skipped. */
async function newestCopy(s3: S3Client, bucket: string, key: string) {
  const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 100 }));
  const versions = (listed.Versions ?? [])
    .filter((v) => v.Key === key && v.VersionId && v.VersionId !== "null")
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
  return versions[0]?.VersionId ?? null;
}

async function copyBack(
  mirror: S3Client,
  mirrorBucket: string,
  store: ReturnType<typeof createS3Store>,
  key: string,
  versionId: string,
) {
  const object: GetObjectCommandOutput = await mirror.send(
    new GetObjectCommand({ Bucket: mirrorBucket, Key: key, VersionId: versionId }),
  );
  const expected = object.Metadata?.sha256;
  const size = object.ContentLength ?? 0;
  if (!expected) throw new Error(`${key}: the copy has no sha256 metadata`);
  if (size > IN_MEMORY_BYTES)
    return store.putStream(key, object.Body as AsyncIterable<Uint8Array>, { size, sha256: expected });
  const bytes = Buffer.from(await object.Body!.transformToByteArray());
  if (sha256(bytes) !== expected) throw new Error(`${key}: the copy does not match its sha256`);
  return store.putImmutable(key, bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runObjectsRestore(process.argv.slice(2));
