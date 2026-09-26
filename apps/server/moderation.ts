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
import { config } from "./config.ts";
import {
  blockRevisionInTransaction,
  purgeBlock,
  recordEvent,
  retentionText,
  type EventActor,
} from "./content-moderation.ts";
import { dispatchModerationNotices } from "./moderation-mail.ts";
import { rememberApproval } from "./share-moderation.ts";
import type { Category } from "./content-filter/lists.ts";
import { CATEGORY_LABEL } from "./content-filter/policy.ts";

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
    await settleReports(c, shareId, "actioned");
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
        // Every shelf's agents of the account, its own and department shelves'.
        `SELECT id,tenant_id,account_id,oauth_client_id,revoked_at
         FROM agent_connections WHERE account_id=$1 ORDER BY id FOR UPDATE`,
        [actor.id],
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
    if (!account.disabled) {
      await audit(c, actor, "account.disabled", actor.id);
      await recordEvent(c, {
        actor: "operator-script",
        action: "account.disabled",
        accountId: actor.id,
        tenantId: actor.tenant,
        reason: reason?.trim() || null,
      });
    }
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
      await recordEvent(c, {
        actor: "operator-script",
        action: "account.enabled",
        accountId: actor.id,
        tenantId: actor.tenant,
      });
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

/** The operator has looked at this link: its open reports are settled. */
async function settleReports(
  c: Pick<PoolClient, "query">,
  shareId: string,
  status: "dismissed" | "actioned",
) {
  return c.query(
    "UPDATE share_reports SET status=$2 WHERE share_id=$1 AND status='new'",
    [shareId, status],
  );
}

export type OperatorOutcome = {
  shareId: string;
  /** False when the request found everything already done. */
  changed: boolean;
  message: string;
};

async function lockOperatorShare(c: PoolClient, shareId: string) {
  const actor = await shareOwner(shareId);
  const { account } = await lockTenantAccount(c, actor);
  const {
    rows: [share],
  } = await c.query(
    `SELECT *,(NOT revoked AND expires_at>now()) AS live
     FROM shares WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
    [shareId, actor.tenant],
  );
  if (!share) throw new ModerationError(`No share ${shareId}`);
  return { actor, account, share };
}

/**
 * Let a held or paused link open, and settle its reports. With trust, the
 * author is approved too: their next links open without review (except
 * under SHARE_MODERATION=all). Repeating it changes nothing.
 */
export async function approveShareAsOperator(
  shareId: string,
  trust = false,
  journalActor: EventActor = "operator-script",
) {
  return transaction(async (c): Promise<OperatorOutcome> => {
    const { actor, account, share } = await lockOperatorShare(c, shareId);
    let changed = false;
    const notes: string[] = [];
    if (share.moderation === "blocked")
      return {
        shareId,
        changed: false,
        message:
          "Ссылка заблокирована; одобрение её не откроет. Снять блокировку — moderation:unblock.",
      };
    if (!share.live)
      notes.push("Ссылка уже закрыта или истекла; открывать нечего.");
    else if (share.moderation !== "none") {
      await c.query(
        "UPDATE shares SET moderation='none',moderated_at=now() WHERE id=$1",
        [shareId],
      );
      await audit(c, actor, "share.approved", shareId);
      // Later versions with the same or fewer phishing signals are not held
      // for fraud again (share-moderation.ts, approvedSignalsCover).
      const approvedSignals = await rememberApproval(c, share.revision_id);
      await recordEvent(c, {
        actor: journalActor,
        action: "share.approved",
        accountId: actor.id,
        tenantId: actor.tenant,
        artifactId: share.artifact_id,
        revisionId: share.revision_id,
        shareId,
        details: approvedSignals ? { approvedSignals } : {},
      });
      changed = true;
      notes.push("Ссылка одобрена: получатели видят работу.");
    } else notes.push("Ссылка уже открыта для получателей.");
    const settled = await settleReports(c, shareId, "dismissed");
    if (settled.rowCount) {
      changed = true;
      notes.push(`Жалобы отмечены рассмотренными: ${settled.rowCount}.`);
    }
    if (trust) {
      if (account.disabled) notes.push("Автор отключён; доверие не выдаётся.");
      else if (!account.trusted_at) {
        await c.query("UPDATE accounts SET trusted_at=now() WHERE id=$1", [
          actor.id,
        ]);
        await audit(c, actor, "account.trusted", actor.id);
        changed = true;
        notes.push(
          "Автор теперь доверенный: его ссылки открываются без проверки.",
        );
      } else notes.push("Автор уже доверенный.");
    }
    return { shareId, changed, message: notes.join(" ") };
  });
}

/** Lift a pause after reports. A held link stays held: approve it instead. */
export async function unpauseShareAsOperator(
  shareId: string,
  journalActor: EventActor = "operator-script",
) {
  return transaction(async (c): Promise<OperatorOutcome> => {
    const { actor, share } = await lockOperatorShare(c, shareId);
    if (!share.live)
      return {
        shareId,
        changed: false,
        message: "Ссылка уже закрыта или истекла; снимать паузу не с чего.",
      };
    if (share.moderation !== "paused")
      return {
        shareId,
        changed: false,
        message:
          share.moderation === "held"
            ? "Ссылка не на паузе, а ждёт первой проверки: одобрите её."
            : "Ссылка не на паузе; ничего не изменилось.",
      };
    await c.query(
      "UPDATE shares SET moderation='none',moderated_at=now() WHERE id=$1",
      [shareId],
    );
    await settleReports(c, shareId, "dismissed");
    await audit(c, actor, "share.unpaused", shareId);
    await recordEvent(c, {
      actor: journalActor,
      action: "share.unpaused",
      accountId: actor.id,
      tenantId: actor.tenant,
      shareId,
    });
    return {
      shareId,
      changed: true,
      message:
        "Пауза снята: получатели снова видят работу. Жалобы отмечены рассмотренными.",
    };
  });
}

/** Close the link for good (the owner's revoke path). */
export async function closeShareAsOperator(
  shareId: string,
  journalActor: EventActor = "operator-script",
): Promise<OperatorOutcome> {
  const result = await revokeShareAsOperator(shareId);
  const owner = await shareOwner(shareId);
  await recordEvent(db, {
    actor: journalActor,
    action: "share.closed",
    accountId: owner.id,
    tenantId: owner.tenant,
    artifactId: result.artifactId,
    shareId,
  });
  return {
    shareId,
    changed: !result.alreadyRevoked,
    message: result.alreadyRevoked
      ? "Ссылка уже была закрыта; ничего не изменилось."
      : "Ссылка закрыта навсегда. Работа осталась на полке автора.",
  };
}

/** Close the link and disable its author (disableAccount closes all links). */
export async function closeAndDisableAsOperator(
  shareId: string,
  journalActor: EventActor = "operator-script",
): Promise<OperatorOutcome> {
  const owner = await shareOwner(shareId);
  await recordEvent(db, {
    actor: journalActor,
    action: "share.closed",
    accountId: owner.id,
    tenantId: owner.tenant,
    shareId,
  });
  const {
    rows: [account],
  } = await db.query("SELECT name FROM accounts WHERE id=$1", [owner.id]);
  const disabled = await disableAccount(account.name, "moderation mail");
  await transaction((c) => settleReports(c, shareId, "actioned"));
  return {
    shareId,
    changed: !disabled.alreadyDisabled,
    message: disabled.alreadyDisabled
      ? "Автор уже был отключён, его ссылки закрыты; ничего не изменилось."
      : `Автор отключён: сессии завершены, подключения агентов отозваны, закрыто ссылок: ${disabled.liveShares + disabled.expiredShares}. Данные не удалены; вернуть доступ — moderation:enable.`,
  };
}

/** Approve an author without a link at hand (scripts). */
export async function trustAccount(login: string) {
  const actor = await accountActor(db, login);
  return transaction(async (c) => {
    const { account } = await lockTenantAccount(c, actor);
    if (account.disabled)
      throw new ModerationError(`${account.name} is disabled; enable it first`);
    if (!account.trusted_at) {
      await c.query("UPDATE accounts SET trusted_at=now() WHERE id=$1", [
        actor.id,
      ]);
      await audit(c, actor, "account.trusted", actor.id);
    }
    return {
      name: account.name as string,
      email: account.email as string | null,
      alreadyTrusted: !!account.trusted_at,
    };
  });
}

export function formatTrusted(
  result: Awaited<ReturnType<typeof trustAccount>>,
) {
  return `${clean(result.name + (result.email ? ` <${result.email}>` : ""), 120)} ${
    result.alreadyTrusted
      ? "was already trusted; nothing changed."
      : "is trusted: new links open without review (except SHARE_MODERATION=all)."
  }`;
}

/** Links waiting for the operator: held before their first open, or paused. */
export async function listModerationQueue() {
  const { rows } = await db.query(
    `SELECT share.id,share.moderation,share.moderation_reason,share.moderated_at,
       share.created_at,artifact.title,account.name,account.email,
       (SELECT count(*) FROM share_reports report
        WHERE report.share_id=share.id AND report.status='new') AS open_reports
     FROM shares share
     JOIN artifacts artifact ON artifact.id=share.artifact_id
     JOIN tenants tenant ON tenant.id=share.tenant_id
     JOIN accounts account ON account.id=tenant.owner_id
     WHERE share.moderation IN ('held','paused') AND NOT share.revoked AND share.expires_at>now()
     ORDER BY COALESCE(share.moderated_at,share.created_at),share.id
     LIMIT $1`,
    [REPORT_LIMIT],
  );
  return rows.map((row) => ({
    shareId: row.id as string,
    state: row.moderation as "held" | "paused",
    reason: row.moderation_reason as string | null,
    since: new Date(row.moderated_at ?? row.created_at),
    title: row.title as string | null,
    ownerName: row.name as string,
    ownerEmail: row.email as string | null,
    openReports: Number(row.open_reports),
  }));
}

export function formatModerationQueue(
  queue: Awaited<ReturnType<typeof listModerationQueue>>,
) {
  if (!queue.length) return "No links wait for review.";
  return [
    ...queue.map((item) =>
      [
        time(item.since),
        item.state.toUpperCase(),
        item.reason ?? "-",
        item.shareId,
        `reports ${item.openReports}`,
        clean(
          item.ownerName + (item.ownerEmail ? ` <${item.ownerEmail}>` : ""),
          60,
        ),
        clean(item.title, 40),
      ].join("  "),
    ),
    "",
    `${queue.length} link(s) wait. Approve: moderation:approve -- <shareId> [--trust]; unpause: moderation:unpause -- <shareId>; close: moderation:revoke-share -- <shareId>.`,
  ].join("\n");
}

// Comments (docs/specs/COMMENTS.md, «Модерация»). Disabling an author hides
// all their comments and reactions (every read filters on accounts.disabled);
// these act on one link's comments or on one comment.

const commentId = (value: string) => {
  if (!z.string().uuid().safeParse(value).success)
    throw new ModerationError(`Not a comment id: ${clean(value, 60)}`);
  return value;
};

/** Every comment of one link, hidden ones included, oldest first. */
export async function listShareComments(shareId: string) {
  if (!z.string().uuid().safeParse(shareId).success)
    throw new ModerationError(`Not a share id: ${clean(shareId, 60)}`);
  const { rows } = await db.query(
    `SELECT comment.id,comment.parent_id,comment.body,comment.anchor,
       comment.signals,comment.held_at,comment.deleted_at,comment.resolved_at,
       comment.blocked_at,comment.shadow,comment.content_filter,
       comment.created_at,author.name,author.email,author.disabled,
       (SELECT count(*) FROM share_reports report
        WHERE report.comment_id=comment.id AND report.status='new') AS open_reports
     FROM comments comment
     JOIN accounts author ON author.id=comment.author_account_id
     WHERE comment.share_id=$1
     ORDER BY comment.created_at,comment.id
     LIMIT $2`,
    [shareId, REPORT_LIMIT],
  );
  return rows.map((row) => ({
    id: row.id as string,
    parentId: row.parent_id as string | null,
    // A blocked comment's text is never shown, the operator included.
    body: row.blocked_at ? "" : (row.body as string),
    quote: row.blocked_at ? null : ((row.anchor?.exact as string | undefined) ?? null),
    signals: row.signals as string[],
    state: row.blocked_at
      ? "blocked"
      : row.deleted_at
      ? "deleted"
      : row.disabled
        ? "author-disabled"
        : row.held_at
          ? row.shadow
            ? "held-spam"
            : "held"
          : row.resolved_at
            ? "resolved"
            : "open",
    createdAt: new Date(row.created_at),
    author: row.name as string,
    authorEmail: row.email as string | null,
    openReports: Number(row.open_reports),
  }));
}

export function formatShareComments(
  comments: Awaited<ReturnType<typeof listShareComments>>,
) {
  if (!comments.length) return "No comments on this link.";
  return [
    ...comments.map((comment) =>
      [
        time(comment.createdAt),
        comment.state.toUpperCase(),
        comment.id,
        comment.parentId ? `reply to ${comment.parentId}` : "thread",
        `reports ${comment.openReports}`,
        clean(
          comment.author +
            (comment.authorEmail ? ` <${comment.authorEmail}>` : ""),
          60,
        ),
        comment.signals.length ? `[${comment.signals.join(",")}]` : "",
        comment.quote ? `«${clean(comment.quote, 40)}»` : "",
        clean(comment.body, 120),
      ]
        .filter(Boolean)
        .join("  "),
    ),
    "",
    `${comments.length} comment(s). Delete: moderation:delete-comment -- <id>; show a held one: moderation:release-comment -- <id>; hide all of an author's: moderation:disable -- <login>.`,
  ].join("\n");
}

/** Empty and hide one comment; its reports are settled. Idempotent. */
export async function deleteCommentAsOperator(id: string) {
  commentId(id);
  return transaction(async (c) => {
    const {
      rows: [comment],
    } = await c.query(
      "SELECT id,deleted_at FROM comments WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!comment) throw new ModerationError(`No comment ${id}`);
    await c.query(
      "UPDATE share_reports SET status='actioned' WHERE comment_id=$1 AND status='new'",
      [id],
    );
    if (comment.deleted_at)
      return { id, changed: false, message: "Комментарий уже удалён." };
    await c.query(
      `UPDATE comments SET body='',anchor=NULL,signals='{}',held_at=NULL,
         deleted_at=clock_timestamp() WHERE id=$1`,
      [id],
    );
    return { id, changed: true, message: "Комментарий удалён." };
  });
}

/** Show a held comment to every reader; the owner then gets the letter. */
export async function releaseCommentAsOperator(id: string) {
  commentId(id);
  const result = await transaction(async (c) => {
    const {
      rows: [comment],
    } = await c.query(
      "SELECT id,held_at,deleted_at FROM comments WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!comment) throw new ModerationError(`No comment ${id}`);
    if (comment.deleted_at)
      return {
        id,
        changed: false,
        message: "Комментарий удалён; показывать нечего.",
      };
    if (!comment.held_at)
      return {
        id,
        changed: false,
        message: "Комментарий не скрыт; ничего не изменилось.",
      };
    await c.query("UPDATE comments SET held_at=NULL WHERE id=$1", [id]);
    await c.query(
      "UPDATE share_reports SET status='dismissed' WHERE comment_id=$1 AND status='new'",
      [id],
    );
    return {
      id,
      changed: true,
      message: "Комментарий виден всем читателям ссылки.",
    };
  });
  if (result.changed) {
    // Loaded here: comment-mail.ts itself uses this module's clean().
    const { dispatchCommentNotices } = await import("./comment-mail.ts");
    await dispatchCommentNotices([{ kind: "comment", commentId: id }]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Blocking (docs/specs/CONTENT_FILTER.md): the operator's «Заблокировать»,
// takedowns after a request of an authority or a rights holder, legal hold,
// lifting a block, and the journal.

export type BlockOptions = {
  actor: EventActor;
  reason: string;
  category?: Category | "other";
  authority?: string | null;
  /** Keep the objects as evidence (for an investigation) until lifted. */
  legalHold?: string | null;
  /** Disable the author too. In strict mode a block always does. */
  disable?: boolean;
};

async function shareRow(shareId: string) {
  if (!z.string().uuid().safeParse(shareId).success)
    throw new ModerationError(`Not a share id: ${clean(shareId, 60)}`);
  const {
    rows: [row],
  } = await db.query(
    `SELECT share.id,share.tenant_id,share.artifact_id,share.revision_id,
       tenant.owner_id
     FROM shares share JOIN tenants tenant ON tenant.id=share.tenant_id
     WHERE share.id=$1`,
    [shareId],
  );
  if (!row) throw new ModerationError(`No share ${shareId}`);
  return row;
}

/**
 * Block the revision a link shows: the link (and every other link to it)
 * shows «Ссылка недоступна», the objects are deleted after
 * MODERATION_EVIDENCE_DAYS unless a legal hold keeps them. Idempotent.
 */
export async function blockShareAsOperator(
  shareId: string,
  options: BlockOptions,
): Promise<OperatorOutcome & { revisionId: string; frozen: boolean }> {
  const share = await shareRow(shareId);
  const freeze = options.disable === true || config.CONTENT_FILTER_MODE === "strict";
  const outcome = await transaction(async (c) => {
    await lockTenantAccount(c, { id: share.owner_id, tenant: share.tenant_id });
    const result = await blockRevisionInTransaction(c, {
      tenantId: share.tenant_id,
      accountId: share.owner_id,
      artifactId: share.artifact_id,
      revisionId: share.revision_id,
      category: options.category ?? "other",
      actor: options.actor,
      reason: options.reason,
      authority: options.authority ?? null,
      legalHold: options.legalHold ?? null,
      freeze,
    });
    await settleReports(c, shareId, "actioned");
    return result;
  });
  if (outcome.created)
    void dispatchModerationNotices([
      {
        kind: "blocked",
        shareId,
        revisionId: share.revision_id,
        category: options.category ?? "other",
        frozen: outcome.frozen,
        by: "operator",
      },
    ]);
  const kept = retentionText(options.category ?? "other", !!options.legalHold);
  return {
    shareId,
    revisionId: share.revision_id,
    frozen: outcome.frozen,
    changed: outcome.created || outcome.frozen,
    message: outcome.created
      ? `Заблокировано: получатели видят «Ссылка недоступна». ${kept}${outcome.frozen ? " Автор отключён." : ""}`
      : "Уже заблокировано; ничего не изменилось.",
  };
}

/** What a takedown target names: a link, a share id, a work or an account. */
export async function resolveTarget(target: string) {
  const value = target.trim();
  const token = /#([A-Za-z0-9_-]{20,})$/.exec(value)?.[1];
  if (token) {
    const { sha256 } = await import("./storage.ts");
    const {
      rows: [row],
    } = await db.query("SELECT id FROM shares WHERE token_hash=$1", [sha256(token)]);
    if (!row) throw new ModerationError("No share for this link");
    return { kind: "share" as const, shareIds: [row.id as string] };
  }
  if (z.string().uuid().safeParse(value).success) {
    const share = await db.query("SELECT id FROM shares WHERE id=$1", [value]);
    if (share.rowCount) return { kind: "share" as const, shareIds: [value] };
    const artifact = await db.query(
      // A department shelf has no owner: the author answers for the work.
      `SELECT artifact.id,artifact.tenant_id,artifact.latest_revision_id,
              COALESCE(tenant.owner_id,artifact.created_by) AS owner_id,
              tenant.owner_id IS NULL AS team
       FROM artifacts artifact JOIN tenants tenant ON tenant.id=artifact.tenant_id
       WHERE artifact.id=$1`,
      [value],
    );
    if (artifact.rowCount) return { kind: "artifact" as const, artifact: artifact.rows[0] };
    const revision = await db.query(
      `SELECT revision.id AS latest_revision_id,revision.artifact_id AS id,
         revision.tenant_id,COALESCE(tenant.owner_id,revision.created_by) AS owner_id,
         tenant.owner_id IS NULL AS team
       FROM revisions revision JOIN tenants tenant ON tenant.id=revision.tenant_id
       WHERE revision.id=$1`,
      [value],
    );
    if (revision.rowCount) return { kind: "artifact" as const, artifact: revision.rows[0] };
    const account = await db.query("SELECT name FROM accounts WHERE id=$1", [value]);
    if (account.rowCount) return { kind: "account" as const, login: account.rows[0].name as string };
    throw new ModerationError(`Nothing with id ${value}`);
  }
  return { kind: "account" as const, login: value };
}

export type TakedownReceipt = {
  at: string;
  category: Category | "other";
  target: string;
  reason: string;
  authority: string | null;
  blocked: Array<{ revisionId: string; shareId: string | null }>;
  disabled: string | null;
  legalHold: boolean;
};

/**
 * A request of an authority or a rights holder: block what the target names
 * (a link, a work: its latest revision, or every work of an account), and
 * optionally disable the account. Journaled; returns a receipt.
 */
export async function takedown(
  target: string,
  options: {
    reason: string;
    authority?: string | null;
    disable?: boolean;
    legalHold?: boolean;
    category?: Category | "other";
  },
): Promise<TakedownReceipt> {
  if (!options.reason?.trim()) throw new ModerationError("--reason is required");
  const resolved = await resolveTarget(target);
  const legalHold = options.legalHold
    ? (options.authority?.trim() || options.reason).slice(0, 500)
    : null;
  const common = {
    actor: "operator-script" as const,
    reason: options.reason.trim(),
    authority: options.authority?.trim() || null,
    legalHold,
    category: options.category ?? "other",
  };
  const blocked: TakedownReceipt["blocked"] = [];
  let disabled: string | null = null;
  const blockRevision = async (row: {
    tenant_id: string;
    owner_id: string;
    id: string;
    latest_revision_id: string | null;
    team?: boolean;
  }) => {
    if (!row.latest_revision_id) return;
    // Every revision of the work that a link shows, and the latest one.
    const revisions = new Set<string>([row.latest_revision_id]);
    for (const share of (
      await db.query(
        "SELECT DISTINCT revision_id FROM shares WHERE artifact_id=$1 AND NOT revoked",
        [row.id],
      )
    ).rows)
      revisions.add(share.revision_id);
    for (const revisionId of revisions) {
      const outcome = await transaction(async (c) => {
        if (row.team) {
          // A department shelf: the shelf, then its author (no owner to match).
          await c.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [row.tenant_id]);
          await c.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [row.owner_id]);
        } else await lockTenantAccount(c, { id: row.owner_id, tenant: row.tenant_id });
        return blockRevisionInTransaction(c, {
          tenantId: row.tenant_id,
          accountId: row.owner_id,
          artifactId: row.id,
          revisionId,
          freeze: false,
          ...common,
        });
      });
      blocked.push({ revisionId, shareId: outcome.shareIds[0] ?? null });
      if (outcome.created)
        void dispatchModerationNotices([
          {
            kind: "blocked",
            shareId: outcome.shareIds[0] ?? null,
            revisionId,
            category: common.category,
            frozen: false,
            by: "operator",
          },
        ]);
    }
  };
  if (resolved.kind === "share")
    for (const shareId of resolved.shareIds) {
      const share = await shareRow(shareId);
      const outcome = await blockShareAsOperator(shareId, { ...common, disable: false });
      blocked.push({ revisionId: outcome.revisionId, shareId });
      if (options.disable) disabled = (
        await db.query("SELECT name FROM accounts WHERE id=$1", [share.owner_id])
      ).rows[0].name;
    }
  else if (resolved.kind === "artifact") {
    await blockRevision(resolved.artifact);
    if (options.disable)
      disabled = (
        await db.query("SELECT name FROM accounts WHERE id=$1", [resolved.artifact.owner_id])
      ).rows[0].name;
  } else {
    const actor = await accountActor(db, resolved.login);
    for (const artifact of (
      await db.query(
        `SELECT artifact.id,artifact.tenant_id,artifact.latest_revision_id,tenant.owner_id
         FROM artifacts artifact JOIN tenants tenant ON tenant.id=artifact.tenant_id
         WHERE artifact.tenant_id=$1 AND EXISTS(
           SELECT 1 FROM shares share WHERE share.artifact_id=artifact.id AND NOT share.revoked)`,
        [actor.tenant],
      )
    ).rows)
      await blockRevision(artifact);
    if (options.disable)
      disabled = (await db.query("SELECT name FROM accounts WHERE id=$1", [actor.id])).rows[0].name;
  }
  if (disabled) await disableAccount(disabled, `takedown: ${common.reason}`);
  const at = new Date().toISOString();
  await recordEvent(db, {
    actor: "operator-script",
    action: "takedown",
    category: common.category,
    reason: common.reason,
    authority: common.authority,
    details: {
      target: clean(target, 200),
      blocked,
      disabled: !!disabled,
      legalHold: !!legalHold,
    },
  });
  return {
    at,
    category: common.category,
    target: clean(target, 200),
    reason: common.reason,
    authority: common.authority,
    blocked,
    disabled,
    legalHold: !!legalHold,
  };
}

export function formatTakedown(receipt: TakedownReceipt) {
  return [
    "КВИТАНЦИЯ О БЛОКИРОВКЕ",
    `Время (UTC): ${receipt.at}`,
    `Цель: ${receipt.target}`,
    `Основание: ${clean(receipt.reason, 500)}`,
    ...(receipt.authority ? [`Орган / заявитель: ${clean(receipt.authority, 500)}`] : []),
    receipt.blocked.length
      ? `Заблокировано версий: ${receipt.blocked.length}`
      : "Нечего блокировать: открытых ссылок нет.",
    ...receipt.blocked.map(
      (item) => `  версия ${item.revisionId}${item.shareId ? `, ссылка ${item.shareId}` : ""}`,
    ),
    retentionText(receipt.category, receipt.legalHold),
    receipt.disabled ? `Аккаунт отключён: ${clean(receipt.disabled, 80)}` : "Аккаунт не отключался.",
    "Запись в журнале модерации: moderation:events.",
  ].join("\n");
}

async function blocksOf(target: string) {
  const value = target.trim();
  if (!z.string().uuid().safeParse(value).success)
    throw new ModerationError(`Not an id: ${clean(value, 60)}`);
  const { rows } = await db.query(
    `SELECT block.* FROM moderation_blocks block
     WHERE (block.revision_id=$1 OR block.artifact_id=$1 OR block.comment_id=$1
            OR block.revision_id=(SELECT revision_id FROM shares WHERE id=$1))
       AND block.released_at IS NULL`,
    [value],
  );
  if (!rows.length) throw new ModerationError(`No live block for ${value}`);
  return rows;
}

/**
 * The operator handed the evidence to the police: the content is deleted now
 * (a legal hold, if any, is lifted first by the operator).
 */
export async function handedOver(target: string, note: string) {
  const blocks = await blocksOf(target);
  const notes: string[] = [];
  for (const block of blocks) {
    if (block.legal_hold) {
      notes.push(`${block.revision_id ?? block.comment_id}: legal hold is on; lift it first (legal-hold <id> off)`);
      continue;
    }
    await transaction(async (c) => {
      await c.query(
        "UPDATE moderation_blocks SET handed_over_at=now(),delete_after=now() WHERE id=$1",
        [block.id],
      );
      await recordEvent(c, {
        actor: "operator-script",
        action: "evidence.handed_over",
        category: block.category,
        tenantId: block.tenant_id,
        artifactId: block.artifact_id,
        revisionId: block.revision_id,
        commentId: block.comment_id,
        reason: note?.trim() || null,
      });
    });
    const result = await purgeBlock(block.id, { now: true, actor: "operator-script" });
    notes.push(
      `${block.revision_id ?? block.comment_id}: handed over; ${result.purged ? `deleted (${result.versions} object versions)` : "already deleted"}`,
    );
  }
  return notes.join("\n");
}

/** Delete a blocked work's content now, whatever its schedule. */
export async function purgeArtifactNow(target: string, reason: string) {
  const blocks = await blocksOf(target);
  const notes: string[] = [];
  for (const block of blocks) {
    if (block.legal_hold) {
      notes.push(`${block.revision_id ?? block.comment_id}: legal hold is on; nothing deleted`);
      continue;
    }
    const result = await purgeBlock(block.id, {
      now: true,
      actor: "operator-script",
      reason: reason?.trim() || "удаление по решению оператора",
    });
    notes.push(
      `${block.revision_id ?? block.comment_id}: ${result.purged ? `deleted (${result.versions} object versions)` : "already deleted"}`,
    );
  }
  return notes.join("\n");
}

/** Keep a block's objects as evidence until the hold is lifted. */
export async function setLegalHold(target: string, authority: string, on = true) {
  if (on && !authority?.trim()) throw new ModerationError("--authority is required");
  const blocks = await blocksOf(target);
  const notes: string[] = [];
  await transaction(async (c) => {
    for (const block of blocks) {
      if (on && block.purged_at) {
        notes.push(`${block.revision_id ?? block.comment_id}: already deleted, only metadata remain`);
        continue;
      }
      await c.query(
        on
          ? "UPDATE moderation_blocks SET legal_hold=$2 WHERE id=$1"
          : "UPDATE moderation_blocks SET legal_hold=NULL WHERE id=$1",
        on ? [block.id, authority.trim().slice(0, 500)] : [block.id],
      );
      await recordEvent(c, {
        actor: "operator-script",
        action: on ? "legal_hold.set" : "legal_hold.released",
        category: block.category,
        tenantId: block.tenant_id,
        artifactId: block.artifact_id,
        revisionId: block.revision_id,
        commentId: block.comment_id,
        authority: on ? authority.trim() : null,
      });
      notes.push(
        `${block.revision_id ?? block.comment_id}: ${on ? "kept as evidence" : "hold lifted"}`,
      );
    }
  });
  if (!on) {
    const { purgeDueBlocks } = await import("./content-moderation.ts");
    await purgeDueBlocks();
  }
  return notes.join("\n");
}

/**
 * Lift a block (a mistake, or an appeal granted). Links open again if the
 * content still exists; deleted content cannot come back.
 */
export async function unblock(target: string, reason: string) {
  const blocks = await blocksOf(target);
  const notes: string[] = [];
  await transaction(async (c) => {
    for (const block of blocks) {
      await c.query("UPDATE moderation_blocks SET released_at=now() WHERE id=$1", [block.id]);
      if (block.revision_id && !block.purged_at) {
        const opened = await c.query(
          `UPDATE shares SET moderation='none',moderation_reason=NULL,moderated_at=now()
           WHERE revision_id=$1 AND moderation='blocked' RETURNING id`,
          [block.revision_id],
        );
        notes.push(`${block.revision_id}: unblocked, links reopened: ${opened.rowCount}`);
      } else if (block.comment_id && !block.purged_at) {
        await c.query("UPDATE comments SET blocked_at=NULL WHERE id=$1", [block.comment_id]);
        notes.push(`${block.comment_id}: comment visible again`);
      } else
        notes.push(
          `${block.revision_id ?? block.comment_id}: unblocked, but the content was deleted; links stay unavailable`,
        );
      await recordEvent(c, {
        actor: "operator-script",
        action: "block.released",
        category: block.category,
        tenantId: block.tenant_id,
        artifactId: block.artifact_id,
        revisionId: block.revision_id,
        commentId: block.comment_id,
        reason: reason?.trim() || null,
      });
    }
  });
  return notes.join("\n");
}

/** The journal, newest first, for an id (account, work, revision, link, comment) or all. */
export async function listEvents(target?: string, limit = 100) {
  const id = target?.trim();
  if (id && !z.string().uuid().safeParse(id).success)
    throw new ModerationError(`Not an id: ${clean(id, 60)}`);
  const { rows } = await db.query(
    `SELECT * FROM moderation_events
     WHERE $1::uuid IS NULL OR $1 IN (account_id,tenant_id,artifact_id,revision_id,share_id,comment_id)
     ORDER BY created_at DESC LIMIT $2`,
    [id ?? null, limit],
  );
  return rows;
}

export function formatEvents(rows: Awaited<ReturnType<typeof listEvents>>) {
  if (!rows.length) return "No moderation events.";
  return rows
    .map((row) =>
      [
        time(new Date(row.created_at)),
        row.actor,
        row.action,
        row.category ? CATEGORY_LABEL[row.category as Category] ?? row.category : "-",
        row.share_id ? `share ${row.share_id}` : "",
        row.revision_id ? `revision ${row.revision_id}` : "",
        row.account_id ? `account ${row.account_id}` : "",
        row.authority ? `authority «${clean(row.authority, 80)}»` : "",
        row.reason ? `«${clean(row.reason, 80)}»` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}
