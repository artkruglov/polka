import { z } from "zod";

const schema = z.object({
  ACCOUNT_DELETION_ENABLED: z.literal("true"),
  MAINTENANCE_DATABASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
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

const loopback = new Set(["127.0.0.1", "localhost", "::1"]);

function localUrl(value: string, label: string) {
  const url = new URL(value);
  if (!loopback.has(url.hostname))
    throw new Error(`${label} must use loopback for the local deletion experiment`);
  if (url.search || url.hash)
    throw new Error(`${label} must not contain routing parameters or fragments`);
  return url;
}

export function parseAccountPurgeConfig(input: NodeJS.ProcessEnv) {
  const value = schema.parse(input);
  const appDatabase = localUrl(value.DATABASE_URL, "DATABASE_URL");
  const workerDatabase = localUrl(
    value.MAINTENANCE_DATABASE_URL,
    "MAINTENANCE_DATABASE_URL",
  );
  localUrl(value.S3_ENDPOINT, "S3_ENDPOINT");
  localUrl(value.ERASURE_LEDGER_ENDPOINT, "ERASURE_LEDGER_ENDPOINT");
  if (!appDatabase.username || !workerDatabase.username)
    throw new Error("Database URLs must name their login roles");
  if (appDatabase.username === workerDatabase.username)
    throw new Error("Purge worker must use a distinct database role");
  if (
    appDatabase.protocol !== workerDatabase.protocol ||
    appDatabase.hostname !== workerDatabase.hostname ||
    appDatabase.port !== workerDatabase.port ||
    appDatabase.pathname !== workerDatabase.pathname
  )
    throw new Error("Purge worker must target the same database endpoint and name");
  if (value.S3_BUCKET === value.ERASURE_LEDGER_BUCKET)
    throw new Error("Erasure ledger bucket must be separate from content storage");
  if (value.S3_ACCESS_KEY === value.ERASURE_LEDGER_ACCESS_KEY)
    throw new Error("Erasure ledger must use separate credentials");
  return Object.freeze(value);
}

export type AccountPurgeConfig = ReturnType<typeof parseAccountPurgeConfig>;
