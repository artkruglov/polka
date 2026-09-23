// Operator moderation (scripts/moderation.ts): read share reports, close one
// share, disable or re-enable an account. Runs as the runtime database role
// and reuses the product's own locks and revoke paths:
// tenant → account → agent connections → artifacts → shares.
import type { PoolClient } from "pg";
import { z } from "zod";
import { lockTenantAccount } from "./account-deletion.ts";
import { audit, type Actor } from "./artifacts.ts";
import { db, transaction } from "./db.ts";
import { revokeConnectionInTransaction } from "./oauth.ts";
import {
  revokeLockedShareInTransaction,
  revokeShareInTransaction,
} from "./shares.ts";

export class ModerationError extends Error {}

const REPORT_LIMIT = 200;

export type ReportRow = {
  reportedAt: Date;
  reason: string;
  comment: string | null;
  shareId: string;
  shareActive: boolean;
  artifactId: string;
  title: string | null;
  ownerName: string;
  ownerEmail: string | null;
  ownerDisabled: boolean;
  shareReports: number;
  ownerReports: number;
};

export async function listReports(days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new ModerationError("--days must be a whole number from 1 to 365");
  const { rows } = await db.query(
    `SELECT report.created_at,report.reason,report.comment,report.share_id,
       (NOT share.revoked AND share.expires_at>now()) AS share_active,
       share.artifact_id,artifact.title,
       account.name,account.email,account.disabled,
       (SELECT count(*) FROM share_reports other
        WHERE other.share_id=report.share_id) AS share_reports,
       (SELECT count(*) FROM share_reports other
        WHERE other.tenant_id=report.tenant_id) AS owner_reports
     FROM share_reports report
     JOIN shares share ON share.id=report.share_id
     JOIN tenants tenant ON tenant.id=report.tenant_id
     JOIN accounts account ON account.id=tenant.owner_id
     LEFT JOIN artifacts artifact ON artifact.id=share.artifact_id
     WHERE report.created_at>now()-$1*interval '1 day'
     ORDER BY report.created_at DESC,report.id DESC
     LIMIT $2`,
    [days, REPORT_LIMIT + 1],
  );
  return {
    days,
    truncated: rows.length > REPORT_LIMIT,
    reports: rows.slice(0, REPORT_LIMIT).map((row): ReportRow => ({
      reportedAt: new Date(row.created_at),
      reason: row.reason,
      comment: row.comment,
      shareId: row.share_id,
      shareActive: row.share_active,
      artifactId: row.artifact_id,
      title: row.title,
      ownerName: row.name,
      ownerEmail: row.email,
      ownerDisabled: row.disabled,
      shareReports: Number(row.share_reports),
      ownerReports: Number(row.owner_reports),
    })),
  };
}

// Report comments and titles are untrusted: no control characters reach the
// operator's terminal, and long text is cut.
export function clean(value: string | null | undefined, max: number) {
  const text = (value ?? "")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : text;
}

const time = (value: Date) =>
  value.toISOString().slice(0, 16).replace("T", " ");

export function formatReports(result: Awaited<ReturnType<typeof listReports>>) {
  if (!result.reports.length)
    return `No reports in the last ${result.days} day(s).`;
  const header = [
    "REPORTED (UTC)",
    "REASON",
    "SHARE",
    "LIVE",
    "N SHARE",
    "N OWNER",
    "OWNER",
    "ARTIFACT",
    "TITLE",
    "COMMENT",
  ];
  const rows = result.reports.map((report) => [
    time(report.reportedAt),
    report.reason,
    report.shareId,
    report.shareActive ? "yes" : "no",
    String(report.shareReports),
    String(report.ownerReports),
    clean(
      report.ownerName +
        (report.ownerEmail ? ` <${report.ownerEmail}>` : "") +
        (report.ownerDisabled ? " [disabled]" : ""),
      60,
    ),
    report.artifactId,
    clean(report.title, 40),
    clean(report.comment, 60),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => [...row[column]].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1
          ? cell
          : cell + " ".repeat(widths[column] - [...cell].length),
      )
      .join("  ")
      .trimEnd();
  return [
    line(header),
    ...rows.map(line),
    "",
    `${result.reports.length} report(s) in the last ${result.days} day(s), newest first` +
      (result.truncated ? `; only the newest ${REPORT_LIMIT} are shown.` : "."),
  ].join("\n");
}

async function shareOwner(shareId: string) {
  if (!z.string().uuid().safeParse(shareId).success)
    throw new ModerationError(`Not a share id: ${clean(shareId, 60)}`);
  const {
    rows: [row],
  } = await db.query(
    `SELECT share.tenant_id,tenant.owner_id FROM shares share
     JOIN tenants tenant ON tenant.id=share.tenant_id WHERE share.id=$1`,
    [shareId],
  );
  if (!row) throw new ModerationError(`No share ${shareId}`);
  return { id: row.owner_id, tenant: row.tenant_id } as Actor;
}

/** Close one share through the owner's revoke path, active owner or not. */
export async function revokeShareAsOperator(shareId: string) {
  const actor = await shareOwner(shareId);
  return transaction(async (c) => {
    const { account } = await lockTenantAccount(c, actor);
    const {
      rows: [before],
    } = await c.query(
      `SELECT share.artifact_id,share.revoked,share.expires_at>now() AS unexpired,
         artifact.title
       FROM shares share LEFT JOIN artifacts artifact ON artifact.id=share.artifact_id
       WHERE share.id=$1`,
      [shareId],
    );
    await revokeShareInTransaction(c, actor, shareId);
    return {
      shareId,
      artifactId: before.artifact_id as string,
      title: before.title as string | null,
      ownerName: account.name as string,
      ownerEmail: account.email as string | null,
      wasActive: !before.revoked && before.unexpired,
      alreadyRevoked: before.revoked as boolean,
    };
  });
}

export function formatRevokedShare(
  result: Awaited<ReturnType<typeof revokeShareAsOperator>>,
) {
  const state = result.alreadyRevoked
    ? "was already closed; nothing changed"
    : result.wasActive
      ? "was live and is now closed"
      : "had expired and is now closed";
  return [
    `Share ${result.shareId} ${state}.`,
    `Artifact: ${result.artifactId} «${clean(result.title, 80)}»`,
    `Owner: ${clean(result.ownerName + (result.ownerEmail ? ` <${result.ownerEmail}>` : ""), 120)}`,
  ].join("\n");
}

async function accountActor(c: Pick<PoolClient, "query">, login: string) {
  const key = (login ?? "").trim().toLowerCase();
  if (!key) throw new ModerationError("Give a login or an email address");
  const {
    rows: [row],
  } = await c.query(
    `SELECT account.id,tenant.id AS tenant FROM accounts account
     JOIN tenants tenant ON tenant.owner_id=account.id
     WHERE ${key.includes("@") ? "account.email" : "account.name"}=$1`,
    [key],
  );
  if (!row) throw new ModerationError(`No account ${clean(key, 80)}`);
  return { id: row.id, tenant: row.tenant } as Actor;
}

/**
 * Disable an account the way the product understands it: every owner check
 * (lockActiveOwnerTenant, assertActiveOwner, session and share lookups) reads
 * accounts.disabled. Sessions end, agent connections (tokens and OAuth grants)
 * are revoked and all shares close in one transaction. No data is deleted.
 */
export async function disableAccount(login: string, reason?: string) {
  const actor = await accountActor(db, login);
  return transaction(async (c) => {
    const { account } = await lockTenantAccount(c, actor);
    if (account.deletion_requested_at)
      throw new ModerationError(
        `${account.name} is being deleted; it is already disabled`,
      );
    const connections = (
      await c.query(
        `SELECT id,tenant_id,account_id,oauth_client_id,revoked_at
         FROM agent_connections WHERE tenant_id=$1 ORDER BY id FOR UPDATE`,
        [actor.tenant],
      )
    ).rows;
    await c.query(
      "SELECT id FROM artifacts WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
      [actor.tenant],
    );
    const shares = (
      await c.query(
        `SELECT *,expires_at>now() AS unexpired FROM shares
         WHERE tenant_id=$1 ORDER BY id FOR UPDATE`,
        [actor.tenant],
      )
    ).rows;

    await c.query("UPDATE accounts SET disabled=true WHERE id=$1", [actor.id]);
    const sessions = await c.query("DELETE FROM sessions WHERE account_id=$1", [
      actor.id,
    ]);
    let tokenConnections = 0,
      oauthConnections = 0;
    for (const connection of connections) {
      if (connection.revoked_at) continue;
      await revokeConnectionInTransaction(c, connection);
      if (connection.oauth_client_id) oauthConnections++;
      else tokenConnections++;
    }
    let liveShares = 0,
      expiredShares = 0;
    for (const share of shares) {
      if (share.revoked) continue;
      await revokeLockedShareInTransaction(c, actor, share);
      if (share.unexpired) liveShares++;
      else expiredShares++;
    }
    if (!account.disabled) await audit(c, actor, "account.disabled", actor.id);
    return {
      name: account.name as string,
      email: account.email as string | null,
      alreadyDisabled: account.disabled as boolean,
      reason: reason?.trim() || null,
      sessions: sessions.rowCount ?? 0,
      tokenConnections,
      oauthConnections,
      liveShares,
      expiredShares,
    };
  });
}

export function formatDisabled(
  result: Awaited<ReturnType<typeof disableAccount>>,
) {
  return [
    `${clean(result.name + (result.email ? ` <${result.email}>` : ""), 120)} ${
      result.alreadyDisabled ? "was already disabled" : "is disabled"
    }.`,
    ...(result.reason ? [`Reason: ${clean(result.reason, 200)}`] : []),
    `Sessions ended: ${result.sessions}`,
    `Agent connections revoked: ${result.tokenConnections + result.oauthConnections} (token ${result.tokenConnections}, OAuth ${result.oauthConnections})`,
    `Shares closed: ${result.liveShares + result.expiredShares} (live ${result.liveShares}, expired ${result.expiredShares})`,
    "No data was deleted. Closed shares stay closed after enable.",
  ].join("\n");
}

/** Lift a disable. Closed shares and revoked connections stay closed. */
export async function enableAccount(login: string) {
  const actor = await accountActor(db, login);
  return transaction(async (c) => {
    const { account } = await lockTenantAccount(c, actor);
    if (account.deletion_requested_at)
      throw new ModerationError(
        `${account.name} is being deleted and cannot be enabled`,
      );
    if (account.disabled) {
      await c.query("UPDATE accounts SET disabled=false WHERE id=$1", [
        actor.id,
      ]);
      await audit(c, actor, "account.enabled", actor.id);
    }
    return {
      name: account.name as string,
      email: account.email as string | null,
      alreadyEnabled: !account.disabled,
    };
  });
}

export function formatEnabled(
  result: Awaited<ReturnType<typeof enableAccount>>,
) {
  return `${clean(result.name + (result.email ? ` <${result.email}>` : ""), 120)} ${
    result.alreadyEnabled
      ? "was not disabled; nothing changed."
      : "is enabled. Closed shares and revoked agent connections stay closed."
  }`;
}
