import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createMaintenanceDatabase, createMaintenanceObjectStore } from "./maintenance-adapters.ts";
import { createErasureLedgerS3Transport } from "./erasure-ledger-s3.ts";
import type { AccountPurgeConfig } from "./account-purge-config.ts";

export function createAccountPurgeAdapters(config: AccountPurgeConfig) {
  const ledgerClient = new S3Client({
    endpoint: config.ERASURE_LEDGER_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: config.ERASURE_LEDGER_ACCESS_KEY,
      secretAccessKey: config.ERASURE_LEDGER_SECRET_KEY,
    },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 1_000,
      requestTimeout: 3_000,
    }),
  });
  const content = createMaintenanceObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: "us-east-1",
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  });
  return {
    database: createMaintenanceDatabase(config.MAINTENANCE_DATABASE_URL),
    content,
    ledger: createErasureLedgerS3Transport({
      client: ledgerClient,
      bucket: config.ERASURE_LEDGER_BUCKET,
      bodyTimeoutMs: 3_000,
    }),
    close() {
      content.close();
      ledgerClient.destroy();
    },
  };
}
