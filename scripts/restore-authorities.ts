// The authorities of one restore (deploy/RESTORE.md, deploy/hosted/README.md
// «Восстановление из дампа»): after the dump is restored and migrated, this
// writes the backup descriptor and prints the values restore-target.ts checks
// before it reconciles the erasure ledger with the restored database:
//
//   RESTORE_RUN_ID=<fresh uuid>
//   RESTORE_BACKUP_SHA256=<sha256 of the descriptor bytes>
//   RESTORE_LEDGER_MANIFEST_SHA256=<sha256 of the ledger as read now>
//
// The descriptor declares this release's migration list (the restored
// database must be migrated to it), the installation's ledger and no local
// mail spool (a hosted installation sends mail over SMTP only). The ledger is
// read with a read-only key; restore-target reads it again and refuses if it
// changed in between.
//
//   restore-authorities.ts --descriptor /restore/input/backup.json [--source <dump name>]
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { z } from "zod";
import { EXPECTED_MIGRATION_VERSIONS } from "../packages/migrations.ts";
import { ledgerManifestSha256, sha256Hex } from "../packages/restore-receipt.ts";
import { createErasureLedgerS3Transport } from "./erasure-ledger-s3.ts";
import type { ErasureLedgerTransport } from "./erasure-ledger-adapter.ts";
import { loadErasureRestorePlan } from "./erasure-restore.ts";

const envSchema = z.object({
  ERASURE_LEDGER_ID: z.string().uuid(),
  ERASURE_LEDGER_ENDPOINT: z.string().url(),
  ERASURE_LEDGER_REGION: z.string().min(1).default("us-east-1"),
  ERASURE_LEDGER_ACCESS_KEY: z.string().min(1),
  ERASURE_LEDGER_SECRET_KEY: z.string().min(16),
  ERASURE_LEDGER_BUCKET: z.string().min(3),
});

/** The descriptor bytes: stable key order, one trailing newline. */
export function backupDescriptor(input: { ledgerId: string; source?: string; createdAt: string }) {
  return Buffer.from(
    `${JSON.stringify(
      {
        formatVersion: 1,
        schemaMigrations: [...EXPECTED_MIGRATION_VERSIONS],
        erasureLedgerId: input.ledgerId,
        localMailSpool: "absent",
        ...(input.source ? { source: input.source } : {}),
        createdAt: input.createdAt,
      },
      null,
      2,
    )}\n`,
  );
}

export async function restoreAuthorities(input: {
  ledger: ErasureLedgerTransport;
  ledgerId: string;
  source?: string;
  signal: AbortSignal;
  now?: Date;
}) {
  const plan = await loadErasureRestorePlan(input.ledger, input.ledgerId, input.signal);
  const descriptor = backupDescriptor({
    ledgerId: input.ledgerId,
    source: input.source,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  return {
    descriptor,
    restoreRunId: randomUUID(),
    backupSha256: sha256Hex(descriptor),
    ledgerManifestSha256: ledgerManifestSha256(plan.records),
    /** Deletion requests in the ledger: accounts the reconciliation erases again. */
    requests: plan.entries.length,
  };
}

export async function runRestoreAuthorities(argv: string[], env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { descriptor: { type: "string" }, source: { type: "string" } },
    strict: true,
  });
  if (!values.descriptor || !isAbsolute(values.descriptor)) {
    console.error("Usage: restore-authorities.ts --descriptor <absolute path> [--source <dump name>]");
    return 2;
  }
  const config = envSchema.parse(env);
  const client = new S3Client({
    endpoint: config.ERASURE_LEDGER_ENDPOINT,
    region: config.ERASURE_LEDGER_REGION,
    forcePathStyle: true,
    maxAttempts: 3,
    credentials: {
      accessKeyId: config.ERASURE_LEDGER_ACCESS_KEY,
      secretAccessKey: config.ERASURE_LEDGER_SECRET_KEY,
    },
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 10_000 }),
  });
  try {
    const result = await restoreAuthorities({
      ledger: createErasureLedgerS3Transport({
        client,
        bucket: config.ERASURE_LEDGER_BUCKET,
        bodyTimeoutMs: 10_000,
      }),
      ledgerId: config.ERASURE_LEDGER_ID,
      source: values.source,
      signal: AbortSignal.timeout(60_000),
    });
    // A new file only: a descriptor of an earlier restore is never replaced.
    await writeFile(values.descriptor, result.descriptor, { flag: "wx", mode: 0o444 });
    console.log(`RESTORE_RUN_ID=${result.restoreRunId}`);
    console.log(`RESTORE_BACKUP_SHA256=${result.backupSha256}`);
    console.log(`RESTORE_LEDGER_MANIFEST_SHA256=${result.ledgerManifestSha256}`);
    console.error(
      `${result.requests} deletion request(s) in the erasure ledger; the descriptor is ${values.descriptor}.`,
    );
    return 0;
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runRestoreAuthorities(process.argv.slice(2));
