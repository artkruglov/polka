import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  RESTORE_DATABASE_URL: z.string().url(),
  RESTORE_RUN_ID: z.string().uuid(),
  RESTORE_BACKUP_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
  RESTORE_LEDGER_MANIFEST_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
  RESTORE_BACKUP_DESCRIPTOR: z.string().min(1),
  RESTORE_RECEIPT_PATH: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(16),
  S3_BUCKET: z.string().min(3),
  ERASURE_LEDGER_ID: z.string().uuid(),
  ERASURE_LEDGER_ENDPOINT: z.string().url(),
  ERASURE_LEDGER_ACCESS_KEY: z.string().min(1),
  ERASURE_LEDGER_SECRET_KEY: z.string().min(16),
  ERASURE_LEDGER_BUCKET: z.string().min(3),
});

function plainUrl(value: string, label: string) {
  const url = new URL(value);
  if (url.search || url.hash)
    throw new Error(
      `${label} must not contain routing parameters or fragments`,
    );
  return url;
}

export function parseRestoreTargetConfig(input: NodeJS.ProcessEnv) {
  const value = schema.parse(input);
  const runtime = plainUrl(value.DATABASE_URL, "DATABASE_URL");
  const restore = plainUrl(value.RESTORE_DATABASE_URL, "RESTORE_DATABASE_URL");
  plainUrl(value.S3_ENDPOINT, "S3_ENDPOINT");
  plainUrl(value.ERASURE_LEDGER_ENDPOINT, "ERASURE_LEDGER_ENDPOINT");
  const runtimeLogin = decodeURIComponent(runtime.username);
  const restoreLogin = decodeURIComponent(restore.username);
  if (!runtimeLogin || !restoreLogin || runtimeLogin === restoreLogin)
    throw new Error("Restore worker must use a distinct named database login");
  if (
    runtime.protocol !== restore.protocol ||
    runtime.hostname !== restore.hostname ||
    (runtime.port || "5432") !== (restore.port || "5432") ||
    decodeURIComponent(runtime.pathname) !==
      decodeURIComponent(restore.pathname)
  )
    throw new Error(
      "Restore worker must target the runtime database endpoint and name",
    );
  if (value.S3_BUCKET === value.ERASURE_LEDGER_BUCKET)
    throw new Error(
      "Erasure ledger bucket must be separate from content storage",
    );
  if (value.S3_ACCESS_KEY === value.ERASURE_LEDGER_ACCESS_KEY)
    throw new Error("Erasure ledger must use separate read-only credentials");
  if (
    !isAbsolute(value.RESTORE_BACKUP_DESCRIPTOR) ||
    !isAbsolute(value.RESTORE_RECEIPT_PATH)
  )
    throw new Error("Restore descriptor and receipt paths must be absolute");
  const backupDirectory = resolve(dirname(value.RESTORE_BACKUP_DESCRIPTOR));
  const receipt = resolve(value.RESTORE_RECEIPT_PATH);
  const withinBackup = relative(backupDirectory, receipt);
  if (
    withinBackup === "" ||
    (!isAbsolute(withinBackup) &&
      withinBackup !== ".." &&
      !withinBackup.startsWith(`..${sep}`))
  )
    throw new Error(
      "Restore receipt must be stored outside the backup directory",
    );
  return Object.freeze(value);
}

export type RestoreTargetConfig = ReturnType<typeof parseRestoreTargetConfig>;
