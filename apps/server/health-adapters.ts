import pg from "pg";
import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  READINESS_BYTES,
  READINESS_KEY,
  READINESS_MAX_BYTES,
} from "../../packages/storage/readiness.ts";

type DbResult = { rows?: Array<Record<string, unknown>> };
type DbClient = {
  query: (query: unknown) => Promise<DbResult>;
  release: (destroy?: boolean) => void;
};
type DbPool = {
  connect: () => Promise<DbClient>;
  end: () => Promise<void>;
  on?: (event: "error", listener: () => void) => void;
};

export type DatabaseHealthConfig = {
  databaseUrl: string;
  expectedMigrations: readonly number[];
  timeoutMs?: number;
};

export type DatabasePoolOptions = {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
};

export type HealthAdapter = {
  probe: (signal: AbortSignal) => Promise<boolean>;
  close: () => Promise<void>;
};

export function createDatabaseHealthAdapter(
  config: DatabaseHealthConfig,
  dependencies: {
    createPool?: (options: DatabasePoolOptions) => DbPool;
  } = {},
): HealthAdapter {
  const timeoutMs = Math.min(config.timeoutMs ?? 1000, 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid database health timeout");
  const expected = [...config.expectedMigrations];
  if (
    expected.some((version) => !Number.isInteger(version) || version < 0) ||
    new Set(expected).size !== expected.length
  )
    throw new Error("Invalid migration catalog");
  const createPool =
    dependencies.createPool ??
    ((options: DatabasePoolOptions) =>
      new pg.Pool(options) as unknown as DbPool);
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
  });
  // pg emits idle-client errors asynchronously. Keep the health pool from
  // turning a transient database restart into an uncaught process error.
  pool.on?.("error", () => undefined);
  let closed = false;

  return {
    async probe(signal) {
      if (closed || signal.aborted) return false;
      let client: DbClient | undefined;
      let destroyed = false;
      const destroyClient = () => {
        if (!client || destroyed) return;
        destroyed = true;
        client.release(true);
      };
      signal.addEventListener("abort", destroyClient, { once: true });
      try {
        client = await pool.connect();
        if (signal.aborted) {
          destroyClient();
          return false;
        }
        const result = await client.query({
          text: "SELECT version FROM schema_migrations ORDER BY version ASC",
        });
        if (signal.aborted) return false;
        const actual = (result.rows ?? []).map((row) => Number(row.version));
        return (
          actual.length === expected.length &&
          actual.every((version, index) => version === expected[index])
        );
      } catch {
        return false;
      } finally {
        signal.removeEventListener("abort", destroyClient);
        if (client && !destroyed) client.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

type S3SendOptions = { abortSignal?: AbortSignal };
type S3ClientLike = {
  send: (command: unknown, options?: S3SendOptions) => Promise<unknown>;
  destroy: () => void;
};

export type StorageHealthConfig = {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  timeoutMs?: number;
};

export type StorageClientOptions = StorageHealthConfig & {
  maxAttempts: 1;
};

async function readBoundedBody(
  body: unknown,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  if (!(body instanceof Uint8Array) && !body) throw new Error("empty body");
  if (signal.aborted) throw new Error("aborted");
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new Error("body limit");
    return Buffer.from(body);
  }
  const stream = body as AsyncIterable<Uint8Array> & {
    destroy?: () => void;
    cancel?: () => Promise<void>;
  };
  if (typeof stream[Symbol.asyncIterator] !== "function")
    throw new Error("unsupported body");
  let aborted = false;
  const abort = () => {
    aborted = true;
    stream.destroy?.();
    void stream.cancel?.();
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      if (aborted || signal.aborted) throw new Error("aborted");
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        stream.destroy?.();
        void stream.cancel?.();
        throw new Error("body limit");
      }
      chunks.push(bytes);
    }
    if (aborted || signal.aborted) throw new Error("aborted");
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function disposeBody(body: unknown) {
  if (!body || body instanceof Uint8Array) return;
  const stream = body as {
    destroy?: () => void;
    cancel?: () => Promise<void>;
  };
  stream.destroy?.();
  void stream.cancel?.();
}

export function createStorageHealthAdapter(
  config: StorageHealthConfig,
  dependencies: {
    createClient?: (options: StorageClientOptions) => S3ClientLike;
  } = {},
): HealthAdapter {
  const timeoutMs = Math.min(config.timeoutMs ?? 1000, 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid storage health timeout");
  const createClient =
    dependencies.createClient ??
    ((options: StorageClientOptions) =>
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
          accessKeyId: options.accessKey,
          secretAccessKey: options.secretKey,
        },
        requestHandler: new NodeHttpHandler({
          connectionTimeout: timeoutMs,
          requestTimeout: timeoutMs,
        }),
      }) as unknown as S3ClientLike);
  const client = createClient({ ...config, timeoutMs, maxAttempts: 1 });
  let closed = false;

  return {
    async probe(signal) {
      if (closed || signal.aborted) return false;
      try {
        const versioning = (await client.send(
          new GetBucketVersioningCommand({ Bucket: config.bucket }),
          { abortSignal: signal },
        )) as { Status?: string };
        if (versioning.Status !== "Enabled" || signal.aborted) return false;
        const first = (await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: READINESS_KEY }),
          { abortSignal: signal },
        )) as { VersionId?: string | null; Body?: unknown };
        if (!first.VersionId || first.VersionId === "null") {
          disposeBody(first.Body);
          return false;
        }
        let firstBytes: Buffer;
        try {
          firstBytes = await readBoundedBody(
            first.Body,
            signal,
            READINESS_MAX_BYTES,
          );
        } finally {
          disposeBody(first.Body);
        }
        if (!firstBytes.equals(READINESS_BYTES)) return false;
        const exact = (await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: READINESS_KEY,
            VersionId: first.VersionId,
          }),
          { abortSignal: signal },
        )) as { VersionId?: string | null; Body?: unknown };
        if (exact.VersionId !== first.VersionId) {
          disposeBody(exact.Body);
          return false;
        }
        let exactBytes: Buffer;
        try {
          exactBytes = await readBoundedBody(
            exact.Body,
            signal,
            READINESS_MAX_BYTES,
          );
        } finally {
          disposeBody(exact.Body);
        }
        return exactBytes.equals(READINESS_BYTES);
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      client.destroy();
    },
  };
}

export function createHealthAdapters(config: {
  database: DatabaseHealthConfig;
  storage: StorageHealthConfig;
}): {
  database: HealthAdapter;
  storage: HealthAdapter;
  close: () => Promise<void>;
} {
  const database = createDatabaseHealthAdapter(config.database);
  const storage = createStorageHealthAdapter(config.storage);
  return {
    database,
    storage,
    async close() {
      await Promise.all([database.close(), storage.close()]);
    },
  };
}
