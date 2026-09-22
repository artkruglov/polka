import { createHash, timingSafeEqual } from "node:crypto";
import { statfs } from "node:fs/promises";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { missing } from "./errors.ts";
import { s3 } from "./storage.ts";

/**
 * What an operator's external monitor needs to know and cannot see from
 * outside: is the database answering, is maintenance still running, how old
 * is the newest backup, is the disk filling up. No user data, no identifiers.
 */
export const OPS_LIMITS = {
  // Maintenance runs every minute and deletes expired rows; a row expired
  // longer than this means the loop has stopped or keeps failing early.
  maintenanceOverdueSeconds: 30 * 60,
  // A daily backup plus two hours of slack.
  backupAgeHours: 26,
  diskFreePercent: 10,
};

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

async function backup(): Promise<Check> {
  const Bucket = config.OPS_BACKUP_BUCKET;
  if (!Bucket) return { ok: null, reason: "not configured" };
  try {
    let newest = 0;
    let ContinuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket, Prefix: "postgres/", ContinuationToken }),
      );
      for (const object of page.Contents ?? [])
        newest = Math.max(newest, object.LastModified?.getTime() ?? 0);
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    if (!newest) return { ok: false, reason: "no dumps" };
    const ageHours = Math.round(((Date.now() - newest) / 3_600_000) * 10) / 10;
    return { ok: ageHours < OPS_LIMITS.backupAgeHours, ageHours };
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
  const [db_, maintenance_, backup_, disk_] = await Promise.all([
    database(),
    maintenance(),
    backup(),
    disk(),
  ]);
  const checks = {
    database: db_,
    maintenance: maintenance_,
    backup: backup_,
    disk: disk_,
  };
  // A check that is not configured (null) does not fail the status.
  const ok = Object.values(checks).every((check) => check.ok !== false);
  return { ok, version, checks };
}
