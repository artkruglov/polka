import pg from "pg";
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { MaintenanceClient } from "./maintenance-guard.ts";
import type {
  MaintenanceObjectPage,
  MaintenanceObjectStore,
} from "./maintenance-cleanup.ts";
import { MaintenanceStorageFailure } from "./maintenance-cleanup.ts";

type PgClientLike = {
  connect: () => Promise<void>;
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows?: Array<Record<string, unknown>> }>;
  on: (event: "error" | "end", listener: () => void) => void;
  off: (event: "error" | "end", listener: () => void) => void;
  end: () => Promise<void>;
  connection?: { stream?: { destroy?: () => void } };
};

export type MaintenanceDatabase = MaintenanceClient & {
  connect: () => Promise<void>;
  forceClose?: () => void;
};

export function createMaintenanceDatabase(
  databaseUrl: string,
  dependencies: {
    createClient?: () => PgClientLike;
    queryTimeoutMs?: number;
  } = {},
): MaintenanceDatabase {
  const queryTimeoutMs = Math.min(
    dependencies.queryTimeoutMs ?? 15_000,
    15_000,
  );
  if (!Number.isFinite(queryTimeoutMs) || queryTimeoutMs <= 0)
    throw new Error("Invalid maintenance database timeout");
  const raw =
    dependencies.createClient?.() ??
    (new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      statement_timeout: Math.min(queryTimeoutMs, 15_000),
    }) as unknown as PgClientLike);
  let closing: Promise<void> | null = null;
  const close = () => {
    if (!closing)
      closing = Promise.resolve()
        .then(() => raw.end())
        .then(() => undefined)
        .catch(() => undefined);
    return closing;
  };
  return {
    connect: () => raw.connect(),
    forceClose() {
      try {
        raw.connection?.stream?.destroy?.();
      } catch {
        // A forced close is used only after the bounded graceful close failed.
      }
    },
    query(sql, values) {
      if (closing)
        return Promise.reject(new Error("Maintenance database closed"));
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: (value: any) => void, value: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          void close();
          finish(reject, new Error("Maintenance database query timed out"));
        }, queryTimeoutMs);
        Promise.resolve()
          .then(() => {
            if (closing || settled)
              throw new Error("Maintenance database closed");
            return raw.query(sql, values);
          })
          .then(
            (result) => finish(resolve, result),
            (error) => finish(reject, error),
          );
      });
    },
    on(event, listener) {
      raw.on(event, listener);
    },
    off(event, listener) {
      raw.off(event, listener);
    },
    end: close,
  };
}

type S3ClientLike = {
  send: (
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<any>;
  destroy: () => void;
};

export function createMaintenanceObjectStore(
  config: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  },
  dependencies: {
    createClient?: () => S3ClientLike;
    requestTimeoutMs?: number;
  } = {},
): MaintenanceObjectStore & { close: () => void } {
  const requestTimeoutMs = Math.min(
    dependencies.requestTimeoutMs ?? 3_000,
    3_000,
  );
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
    throw new Error("Invalid maintenance storage timeout");
  const client =
    dependencies.createClient?.() ??
    (new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 1_000,
        requestTimeout: requestTimeoutMs,
      }),
    }) as unknown as S3ClientLike);
  let closed = false;
  const send = async (command: unknown, signal: AbortSignal) => {
    if (closed || signal.aborted) throw new MaintenanceStorageFailure();
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(requestTimeoutMs),
    ]);
    try {
      const result = await client.send(command, { abortSignal: requestSignal });
      if (closed || requestSignal.aborted)
        throw new MaintenanceStorageFailure();
      return result;
    } catch {
      throw new MaintenanceStorageFailure();
    }
  };
  return {
    async listVersions(input, signal): Promise<MaintenanceObjectPage> {
      const result = await send(
        new ListObjectVersionsCommand({
          Bucket: config.bucket,
          Prefix: input.prefix,
          MaxKeys: input.maxKeys,
          KeyMarker: input.keyMarker,
          VersionIdMarker: input.versionIdMarker,
        }),
        signal,
      );
      if (
        typeof result.IsTruncated !== "boolean" ||
        (result.Versions !== undefined && !Array.isArray(result.Versions)) ||
        (result.DeleteMarkers !== undefined && !Array.isArray(result.DeleteMarkers))
      )
        throw new MaintenanceStorageFailure();
      const versions = result.Versions ?? [];
      const deleteMarkers = result.DeleteMarkers ?? [];
      for (const value of [...versions, ...deleteMarkers])
        if (
          typeof value !== "object" ||
          value === null ||
          typeof value.Key !== "string" ||
          !value.Key ||
          typeof value.VersionId !== "string" ||
          !value.VersionId ||
          value.VersionId === "null"
        )
          throw new MaintenanceStorageFailure();
      return {
        versions: versions.map((value: any) => ({
          key: value.Key,
          versionId: value.VersionId,
        })),
        deleteMarkers: deleteMarkers.map((value: any) => ({
          key: value.Key,
          versionId: value.VersionId,
        })),
        truncated: result.IsTruncated,
        nextKeyMarker: result.NextKeyMarker,
        nextVersionIdMarker: result.NextVersionIdMarker,
      };
    },
    async deleteVersion(key, versionId, signal) {
      if (!versionId || versionId === "null")
        throw new MaintenanceStorageFailure();
      await send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
          VersionId: versionId,
        }),
        signal,
      );
    },
    close() {
      if (closed) return;
      closed = true;
      client.destroy();
    },
  };
}
