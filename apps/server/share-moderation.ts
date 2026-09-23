// Who may hand out links, and when a link waits for the operator
// (docs/specs/ABUSE_PROTECTION.md, sections 1–3). Every share is created or
// re-pointed in shares.ts, which calls into here inside its transaction.
import type { Pool, PoolClient } from "pg";
import { Problem } from "./errors.ts";
import { config } from "./config.ts";
import { isSuspicious } from "./phishing-signals.ts";

type Queryable = Pick<PoolClient | Pool, "query">;

export type ShareModeration = "none" | "held" | "paused";
/** Why a link waits: stored in shares.moderation_reason. */
export type ModerationReason =
  | "suspicious"
  | "new-account"
  | "review-all"
  | "reports";

/** A link longer than this is refused to an author who is not trusted yet. */
export const NEW_ACCOUNT_MAX_DAYS = 7;

export type AuthorStanding = {
  accountId: string;
  name: string;
  email: string | null;
  createdAt: Date | null;
  disabled: boolean;
  /** Created by the operator (password login), not by email sign-up. */
  operatorCreated: boolean;
  approved: boolean;
  aged: boolean;
  openReports: boolean;
  pausedLinks: boolean;
  trusted: boolean;
};

/**
 * Email sign-up names an account `email-<its id>` (email-auth.ts); an
 * operator login is 3–40 characters and can never take that form.
 */
export const SIGNED_UP_SQL = (account: string) =>
  `(${account}.name = 'email-' || ${account}.id::text)`;

/**
 * Trusted: not holding a paused link, and created by the operator, approved
 * by the operator, or older than NEW_ACCOUNT_DAYS without open reports.
 * Everyone else is new.
 */
export async function authorStanding(
  c: Queryable,
  tenantId: string,
): Promise<AuthorStanding> {
  const {
    rows: [row],
  } = await c.query(
    `SELECT account.id,account.name,account.email,account.created_at,
       account.disabled,account.trusted_at IS NOT NULL AS approved,
       NOT ${SIGNED_UP_SQL("account")} AS operator_created,
       (account.created_at IS NULL
         OR account.created_at<=now()-$2*interval '1 day') AS aged,
       EXISTS(SELECT 1 FROM share_reports report
              WHERE report.tenant_id=tenant.id AND report.status='new') AS open_reports,
       EXISTS(SELECT 1 FROM shares share
              WHERE share.tenant_id=tenant.id AND share.moderation='paused'
                AND NOT share.revoked AND share.expires_at>now()) AS paused_links
     FROM tenants tenant JOIN accounts account ON account.id=tenant.owner_id
     WHERE tenant.id=$1`,
    [tenantId, config.NEW_ACCOUNT_DAYS],
  );
  if (!row) throw new Error("Share owner not found");
  return {
    accountId: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    disabled: row.disabled,
    operatorCreated: row.operator_created,
    approved: row.approved,
    aged: row.aged,
    openReports: row.open_reports,
    pausedLinks: row.paused_links,
    trusted:
      !row.paused_links &&
      (row.operator_created ||
        row.approved ||
        (row.aged && !row.open_reports)),
  };
}

/** Why the author is not trusted, as the end of a sentence for them. */
function untrustedBecause(standing: AuthorStanding) {
  if (standing.pausedLinks)
    return "пока одна из ваших ссылок приостановлена и ждёт решения модератора Полки";
  if (standing.aged && standing.openReports)
    return "пока на ваши ссылки есть жалобы, которые модератор ещё не рассмотрел";
  return `первые ${config.NEW_ACCOUNT_DAYS} ${daysWord(config.NEW_ACCOUNT_DAYS)} после регистрации, пока модератор не одобрит одну из ваших ссылок`;
}

const daysWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "день"
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
      ? "дня"
      : "дней";

/**
 * New accounts: at most NEW_ACCOUNT_MAX_LINKS live links (0: no limit), each
 * for at most 7 days. The refusal says why and what to do.
 */
export async function assertNewAccountLimits(
  c: Queryable,
  standing: AuthorStanding,
  tenantId: string,
  expiresInDays: number,
) {
  if (standing.trusted) return;
  if (expiresInDays > NEW_ACCOUNT_MAX_DAYS)
    throw new Problem(
      422,
      "quota",
      `Ссылка на ${expiresInDays} ${daysWord(expiresInDays)} пока недоступна: ${untrustedBecause(standing)}, ссылки выдаются не больше чем на ${NEW_ACCOUNT_MAX_DAYS} дней. Выберите срок 1 или 7 дней.`,
    );
  const max = config.NEW_ACCOUNT_MAX_LINKS;
  if (!max) return;
  const {
    rows: [{ count }],
  } = await c.query(
    `SELECT count(*)::int AS count FROM shares
     WHERE tenant_id=$1 AND NOT revoked AND expires_at>now()`,
    [tenantId],
  );
  if (count >= max)
    throw new Problem(
      429,
      "quota",
      `Сейчас у вас открыто ${count} ${linksWord(count)}: ${untrustedBecause(standing)}, одновременно можно держать открытыми не больше ${max}. Закройте ссылку, которая больше не нужна (на полке: «Поделиться» → «Только я»), и повторите.`,
    );
}

const linksWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "ссылка"
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
      ? "ссылки"
      : "ссылок";

export type ModerationDecision = {
  /** The link waits for the operator before its first open. */
  hold: ModerationReason | null;
  /** The link opens, but the operator gets a letter about it. */
  notify: boolean;
};

/**
 * SHARE_MODERATION: off never holds; flagged holds a suspicious page of an
 * author who is not trusted; new-accounts holds any link of such an author;
 * all holds any link of an account that signed up by email. A suspicious
 * page that opens anyway is reported to the operator.
 */
export function decideModeration(
  standing: AuthorStanding,
  signals: readonly string[],
  mode = config.SHARE_MODERATION,
): ModerationDecision {
  if (mode === "off") return { hold: null, notify: false };
  const suspicious = isSuspicious(signals);
  const hold: ModerationReason | null =
    suspicious && !standing.trusted
      ? "suspicious"
      : mode === "new-accounts" && !standing.trusted
        ? "new-account"
        : mode === "all" && !standing.operatorCreated
          ? "review-all"
          : null;
  return { hold, notify: suspicious && !hold };
}

/** What recipients' tools and the owner are told while a link waits. */
export const MODERATION_MESSAGE: Record<Exclude<ShareModeration, "none">, string> = {
  held: "Ссылка создана, но пока на проверке у модератора Полки: получатели увидят работу после одобрения. Передайте ссылку с этим пояснением или дождитесь проверки; владелец видит состояние на полке.",
  paused:
    "Ссылка приостановлена после жалоб получателей и ждёт решения модератора Полки. Получатели сейчас видят экран проверки вместо работы.",
};

export type ModerationNotice =
  | { kind: "held"; shareId: string }
  | { kind: "suspicious"; shareId: string }
  | { kind: "report"; shareId: string; reportId: string; paused: boolean };
