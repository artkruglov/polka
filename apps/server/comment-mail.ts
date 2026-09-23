// Letters about comments (docs/specs/COMMENTS.md, «Уведомления»): to the
// owner about every new comment (not reactions), to the people in a thread
// about replies while their link is still open, and to the operator about a
// suspicious comment or a report on one. Sent after the transaction that
// caused them commits; a lost letter is logged and never fails the action.
//
// Each address gets at most COMMENT_MAIL_PER_ADDRESS_PER_DAY such letters,
// counted in their own space: sign-in codes are never held up by them. A
// letter quotes at most COMMENT_MAIL_EXCERPT characters, names people by
// display name and carries no one else's address. Addresses in a comment are
// defanged (example[.]com), so a mail client does not make them links.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  COMMENT_MAIL_EXCERPT,
  COMMENT_MAIL_PER_ADDRESS_PER_DAY,
} from "../../packages/contracts/comments.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { LOCAL_COMMENT_MAIL_DIRECTORY, sendMail } from "./mailer.ts";
import { clean } from "./moderation.ts";

export type CommentNotice =
  | { kind: "comment"; commentId: string }
  | { kind: "suspicious"; commentId: string; held: boolean }
  | { kind: "report"; commentId: string; reportId: string };

// «Не присылать такие письма»: a signed link in every letter,
// APP_ORIGIN/mail-off#<token>. The token is in the fragment (no logs); the
// page asks before it acts (mail scanners open links), and only a POST turns
// the letters off. It names one account and lasts a year.
const OFF_PURPOSE = "polka/comment-mail-off/v1";
const OFF_TTL_S = 365 * 24 * 60 * 60;
const offKey = () =>
  createHmac("sha256", config.LINK_KEY).update(OFF_PURPOSE).digest();

export function commentMailOffToken(accountId: string, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ a: accountId, e: Math.floor(now / 1000) + OFF_TTL_S }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", offKey()).update(payload).digest("base64url")}`;
}

/** The account a valid, unexpired token names; null otherwise. */
export function verifyCommentMailOffToken(token: string, now = Date.now()) {
  const match = /^([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = createHmac("sha256", offKey()).update(match[1]!).digest();
  const given = Buffer.from(match[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  try {
    const value = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
    if (
      typeof value.a !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.a) ||
      typeof value.e !== "number" ||
      value.e * 1000 <= now
    )
      return null;
    return value.a as string;
  } catch {
    return null;
  }
}

const offLine = (accountId: string) =>
  `Не присылать письма о комментариях: ${config.APP_ORIGIN}/mail-off#${commentMailOffToken(accountId)}`;

/** example.com → example[.]com, https://x → https[:]//x: text, not a link. */
export function defang(text: string) {
  return text.replace(
    /\S*(?:[a-z][a-z0-9+.-]{1,20}:\/\/|www\.|[\p{L}\p{N}-]\.[\p{L}]{2,})\S*/giu,
    (token) => token.replace(/:\/\//g, "[:]//").replace(/\.(?=[\p{L}\p{N}])/gu, "[.]"),
  );
}

/** A comment as a quote: control characters out, cut, defanged. */
export function excerpt(body: string, max = COMMENT_MAIL_EXCERPT) {
  const text = body
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .trim();
  const chars = [...text];
  return defang(
    chars.length > max ? chars.slice(0, max - 1).join("") + "\u2026" : text,
  );
}

/** One more letter to this address today, or false when its day is full. */
async function withinDailyQuota(email: string) {
  try {
    await limitAttempts(
      `comment-mail:${email.toLowerCase()}`,
      COMMENT_MAIL_PER_ADDRESS_PER_DAY,
      "24 hours",
    );
    return true;
  } catch {
    return false;
  }
}

async function facts(commentId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT comment.id,comment.body,comment.anchor,comment.parent_id,
       comment.author_account_id,comment.share_id,comment.artifact_id,
       comment.held_at,comment.deleted_at,comment.signals,
       COALESCE(author.display_name,author.name) AS author_name,
       author.name AS author_login,
       artifact.title,artifact.trashed_at,
       owner.id AS owner_id,owner.email AS owner_email,
       (NOT owner.disabled AND owner.deletion_requested_at IS NULL
         AND owner.comment_mail) AS owner_active,
       (NOT share.revoked AND share.expires_at>now() AND share.moderation='none'
         AND artifact.trashed_at IS NULL) AS share_open,
       revision.number AS revision_number
     FROM comments comment
     JOIN accounts author ON author.id=comment.author_account_id
     JOIN artifacts artifact ON artifact.id=comment.artifact_id
     JOIN shares share ON share.id=comment.share_id
     JOIN tenants tenant ON tenant.id=comment.tenant_id
     JOIN accounts owner ON owner.id=tenant.owner_id
     JOIN revisions revision ON revision.id=comment.revision_id
     WHERE comment.id=$1`,
    [commentId],
  );
  return row;
}

const workUrl = (artifactId: string) =>
  `${config.APP_ORIGIN}/works/${artifactId}`;

const title = (row: any) => clean(row.title, 120) || "Без названия";

function quoteLine(row: any) {
  const exact = row.anchor?.exact;
  return exact ? [`К фрагменту: \u00ab${excerpt(exact, 120)}\u00bb`] : [];
}

async function send(to: string, subject: string, text: string) {
  if (!(await withinDailyQuota(to))) return null;
  return sendMail({ to, subject, text }, LOCAL_COMMENT_MAIL_DIRECTORY);
}

/** A new comment: the owner, then the other people of the thread. */
async function sendCommentLetters(commentId: string) {
  const row = await facts(commentId);
  if (!row || row.deleted_at || row.held_at) return [];
  const sent: Array<string | boolean | null> = [];
  const who = clean(row.author_name, 60) || "Читатель";
  const reply = !!row.parent_id;
  if (
    row.author_account_id !== row.owner_id &&
    row.owner_email &&
    row.owner_active
  )
    sent.push(
      await send(
        row.owner_email,
        `Полка: ${reply ? "новый ответ" : "новый комментарий"} \u2014 \u00ab${clean(row.title, 60) || "Без названия"}\u00bb`,
        [
          `${who} ${reply ? "ответил(а) в обсуждении" : "оставил(а) комментарий к"} работе \u00ab${title(row)}\u00bb (версия ${row.revision_number}).`,
          "",
          ...quoteLine(row),
          `\u00ab${excerpt(row.body)}\u00bb`,
          "",
          `Открыть работу: ${workUrl(row.artifact_id)}`,
          "",
          `Писем о комментариях \u2014 не больше ${COMMENT_MAIL_PER_ADDRESS_PER_DAY} в сутки на адрес.`,
          offLine(row.owner_id),
        ].join("\n"),
      ),
    );
  // People of the thread learn about replies while their link is open. Not
  // the author of the reply, not the owner (told above), each address once.
  if (reply && row.share_open) {
    const { rows: people } = await db.query(
      `SELECT DISTINCT account.email,account.id
       FROM comments comment
       JOIN accounts account ON account.id=comment.author_account_id
       WHERE (comment.id=$1 OR comment.parent_id=$1)
         AND comment.share_id=$2 AND comment.deleted_at IS NULL
         AND comment.author_account_id<>$3 AND comment.author_account_id<>$4
         AND account.email IS NOT NULL AND account.comment_mail
         AND NOT account.disabled AND account.deletion_requested_at IS NULL`,
      [row.parent_id, row.share_id, row.author_account_id, row.owner_id],
    );
    for (const person of people)
      sent.push(
        await send(
          person.email,
          `Полка: новый ответ в обсуждении \u2014 \u00ab${clean(row.title, 60) || "Без названия"}\u00bb`,
          [
            `${who} ответил(а) в обсуждении работы \u00ab${title(row)}\u00bb, в котором вы участвуете.`,
            "",
            `\u00ab${excerpt(row.body)}\u00bb`,
            "",
            "Откройте работу по ссылке, которую вам прислали: ответ будет в обсуждении справа от текста.",
            "",
            `Писем о комментариях \u2014 не больше ${COMMENT_MAIL_PER_ADDRESS_PER_DAY} в сутки на адрес.`,
            offLine(person.id),
          ].join("\n"),
        ),
      );
  }
  return sent;
}

/** The operator: a suspicious comment or a report on one. Scripts only. */
async function sendOperatorLetter(notice: CommentNotice) {
  if (!config.OPERATOR_EMAIL) return null;
  const row = await facts(notice.commentId);
  if (!row) return null;
  let reason = "";
  if (notice.kind === "suspicious")
    reason = notice.held
      ? "похоже на фишинг, автор новый: комментарий скрыт от всех, кроме автора и владельца работы"
      : "похоже на фишинг, автор доверенный: комментарий виден";
  else if (notice.kind === "report") {
    const {
      rows: [report],
    } = await db.query(
      "SELECT reason,comment FROM share_reports WHERE id=$1",
      [notice.reportId],
    );
    reason = `жалоба (${report?.reason ?? "\u2014"})${report?.comment ? `: \u00ab${excerpt(report.comment, 300)}\u00bb` : ""}`;
  }
  const text = [
    notice.kind === "report"
      ? "Получатель пожаловался на комментарий."
      : "Комментарий похож на попытку выманить данные.",
    "",
    `Работа: \u00ab${title(row)}\u00bb, версия ${row.revision_number}`,
    `Автор комментария: ${clean(row.author_login, 60)}`,
    `Причина: ${reason}`,
    `Признаки: ${(row.signals ?? []).join(", ") || "\u2014"}`,
    `Текст: \u00ab${excerpt(row.body)}\u00bb`,
    "",
    "Решения \u2014 скриптами на сервере:",
    `  npm run moderation:comments -- ${row.share_id}`,
    `  npm run moderation:delete-comment -- ${row.id}`,
    ...(row.held_at
      ? [`  npm run moderation:release-comment -- ${row.id}`]
      : []),
    `  npm run moderation:disable -- ${clean(row.author_login, 60)}   (скрывает все комментарии автора)`,
  ].join("\n");
  return sendMail({
    to: config.OPERATOR_EMAIL,
    subject: `Полка: ${notice.kind === "report" ? "жалоба на комментарий" : "подозрительный комментарий"} \u2014 \u00ab${clean(row.title, 60) || "Без названия"}\u00bb`,
    text,
  });
}

export async function sendCommentNotice(notice: CommentNotice) {
  if (config.MAIL_MODE === "disabled") return null;
  try {
    return notice.kind === "comment"
      ? await sendCommentLetters(notice.commentId)
      : await sendOperatorLetter(notice);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "comment.mail_failed",
        kind: notice.kind,
        code:
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "internal",
      }),
    );
    return null;
  }
}

/** After commit, without holding up the response. */
export function dispatchCommentNotices(notices: CommentNotice[]) {
  return Promise.all(notices.map(sendCommentNotice)).then(() => undefined);
}
