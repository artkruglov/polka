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
export async function approveShareAsOperator(shareId: string, trust = false) {
  return transaction(async (c): Promise<OperatorOutcome> => {
    const { actor, account, share } = await lockOperatorShare(c, shareId);
    let changed = false;
    const notes: string[] = [];
    if (!share.live)
      notes.push("Ссылка уже закрыта или истекла; открывать нечего.");
    else if (share.moderation !== "none") {
      await c.query(
        "UPDATE shares SET moderation='none',moderated_at=now() WHERE id=$1",
        [shareId],
      );
      await audit(c, actor, "share.approved", shareId);
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
export async function unpauseShareAsOperator(shareId: string) {
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
): Promise<OperatorOutcome> {
  const result = await revokeShareAsOperator(shareId);
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
): Promise<OperatorOutcome> {
  const owner = await shareOwner(shareId);
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
     WHERE share.moderation<>'none' AND NOT share.revoked AND share.expires_at>now()
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
    body: row.body as string,
    quote: (row.anchor?.exact as string | undefined) ?? null,
    signals: row.signals as string[],
    state: row.deleted_at
      ? "deleted"
      : row.disabled
        ? "author-disabled"
        : row.held_at
          ? "held"
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
