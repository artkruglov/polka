import { createHash, timingSafeEqual } from "node:crypto";
import { statfs } from "node:fs/promises";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { missing } from "./errors.ts";
import { runtimeStats } from "./runtime-stats.ts";
import { s3 } from "./storage.ts";

/**
 * What an operator's external monitor needs to know and cannot see from
 * outside: is the database answering, is maintenance still running, how old
 * is the newest backup, is the WAL archive current, is the disk filling up. No user data, no identifiers.
 */
export const OPS_LIMITS = {
  // Maintenance runs every few minutes (MAINTENANCE_INTERVAL_SECONDS) and
  // deletes expired rows; a row expired longer than this means the loop has
  // stopped or keeps failing early.
  maintenanceOverdueSeconds: 30 * 60,
  // Slack over the backup interval (OPS_BACKUP_INTERVAL_SECONDS, the backup
  // job's BACKUP_INTERVAL_SECONDS): a daily dump alarms after 26 hours, an
  // hourly one after 3.
  backupSlackHours: 2,
  // wal-archive (profile pitr) refreshes wal/heartbeat every five minutes
  // while its upload rounds succeed.
  walHeartbeatMinutes: 15,
  diskFreePercent: 10,
};

/** How old the newest dump may be before the backup check turns red. */
export function backupAgeLimitHours(intervalSeconds = config.OPS_BACKUP_INTERVAL_SECONDS) {
  return Math.round((intervalSeconds / 3600 + OPS_LIMITS.backupSlackHours) * 10) / 10;
}

/** How old the newest base backup may be before the WAL archive check turns red. */
export function baseBackupAgeLimitHours(intervalSeconds = config.OPS_BASE_BACKUP_INTERVAL_SECONDS) {
  return backupAgeLimitHours(intervalSeconds);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function authorizeOpsStatus(authorization: string | undefined) {
  const expected = config.OPS_STATUS_TOKEN;
  if (!expected) throw missing();
  const presented = authorization?.replace(/^Bearer /, "") ?? "";
  // Compare digests: equal length, and the token's length does not leak.
  if (!timingSafeEqual(digest(presented), digest(expected))) throw missing();
}

type Check = { ok: boolean | null; [detail: string]: unknown };

async function database(): Promise<Check> {
  try {
    await db.query("SELECT 1");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function maintenance(): Promise<Check> {
  try {
    const {
      rows: [row],
    } = await db.query(
      `SELECT COALESCE(extract(epoch FROM now()-min(expires_at))::int, 0) AS overdue
       FROM (
         SELECT expires_at FROM sessions WHERE expires_at<now()
         UNION ALL SELECT expires_at FROM grants WHERE expires_at<now()
         UNION ALL SELECT expires_at FROM viewer_grants WHERE expires_at<now()
         UNION ALL SELECT expires_at FROM project_view_grants WHERE expires_at<now()
       ) expired`,
    );
    const overdueSeconds = Number(row.overdue);
    return {
      ok: overdueSeconds < OPS_LIMITS.maintenanceOverdueSeconds,
      overdueSeconds,
    };
  } catch {
    return { ok: false };
  }
}

/** When the newest object under `Prefix` was written, 0 if there is none. */
async function newestObject(Bucket: string, Prefix: string) {
  let newest = 0;
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const object of page.Contents ?? []) newest = Math.max(newest, object.LastModified?.getTime() ?? 0);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return newest;
}

async function backup(): Promise<Check> {
  const Bucket = config.OPS_BACKUP_BUCKET;
  if (!Bucket) return { ok: null, reason: "not configured" };
  try {
    const newest = await newestObject(Bucket, "postgres/");
    if (!newest) return { ok: false, reason: "no dumps" };
    const ageHours = Math.round(((Date.now() - newest) / 3_600_000) * 10) / 10;
    const limitHours = backupAgeLimitHours();
    return { ok: ageHours < limitHours, ageHours, limitHours };
  } catch {
    return { ok: false, reason: "cannot list" };
  }
}

/**
 * The archive for a restore to any minute (profile pitr): wal-archive's
 * heartbeat shows its upload rounds succeed, the newest base backup that a
 * restore can start from.
 */
async function walArchive(): Promise<Check> {
  const Bucket = config.OPS_BACKUP_BUCKET;
  if (!Bucket || !config.OPS_COMPOSE_PROFILES.includes("pitr")) return { ok: null, reason: "not configured" };
  try {
    const [heartbeat, base] = await Promise.all([newestObject(Bucket, "wal/heartbeat"), newestObject(Bucket, "base/")]);
    if (!heartbeat) return { ok: false, reason: "no heartbeat" };
    if (!base) return { ok: false, reason: "no base backup" };
    const heartbeatMinutes = Math.round((Date.now() - heartbeat) / 60_000);
    const baseAgeHours = Math.round(((Date.now() - base) / 3_600_000) * 10) / 10;
    const baseLimitHours = baseBackupAgeLimitHours();
    return {
      ok: heartbeatMinutes < OPS_LIMITS.walHeartbeatMinutes && baseAgeHours < baseLimitHours,
      heartbeatMinutes,
      baseAgeHours,
      baseLimitHours,
    };
  } catch {
    return { ok: false, reason: "cannot list" };
  }
}

async function disk(): Promise<Check> {
  try {
    const stats = await statfs("/");
    const freePercent = Math.round((stats.bavail / stats.blocks) * 1000) / 10;
    return { ok: freePercent >= OPS_LIMITS.diskFreePercent, freePercent };
  } catch {
    return { ok: null, reason: "unavailable" };
  }
}

export async function opsStatus(version: string) {
  const [db_, maintenance_, backup_, wal_, disk_] = await Promise.all([
    database(),
    maintenance(),
    backup(),
    walArchive(),
    disk(),
  ]);
  const checks = {
    database: db_,
    maintenance: maintenance_,
    backup: backup_,
    walArchive: wal_,
    disk: disk_,
  };
  // A check that is not configured (null) does not fail the status.
  const ok = Object.values(checks).every((check) => check.ok !== false);
  // Not part of ok: numbers to watch (memory, event loop, pool, queues).
  return { ok, version, checks, runtime: runtimeStats() };
}
