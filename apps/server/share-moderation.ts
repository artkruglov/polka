// Who may hand out links, and when a link waits for the operator
// (docs/specs/ABUSE_PROTECTION.md, sections 1–3). Every share is created or
// re-pointed in shares.ts, which calls into here inside its transaction.
import type { Pool, PoolClient } from "pg";
import { Problem } from "./errors.ts";
import { config } from "./config.ts";
import { isSuspicious } from "./phishing-signals.ts";
import {
  NO_DECISION,
  contentReason,
  type ContentDecision,
} from "./content-filter/policy.ts";
import type { Category } from "./content-filter/lists.ts";

type Queryable = Pick<PoolClient | Pool, "query">;

export type ShareModeration = "none" | "held" | "paused" | "blocked";
/**
 * Why a link waits: stored in shares.moderation_reason. The content filter
 * adds content:<category> (held), spam:<category> (held, shown to nobody but
 * the owner as waiting) and blocked:<category>.
 */
export type ModerationReason =
  | "suspicious"
  | "new-account"
  | "review-all"
  | "reports"
  | "model-unavailable"
  | "image-unchecked"
  | `content:${string}`
  | `spam:${string}`
  | `blocked:${string}`;

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
  /** A work of this author is blocked and the block is not lifted. */
  blockedContent: boolean;
  /** Has a linked Яндекс ID or VK ID identity. */
  identityVerified: boolean;
  /** Saved revisions, none of them blocked. */
  cleanSaves: number;
  trusted: boolean;
};

/**
 * Self sign-up names an account `<way>-<its id>`: `email-` (email-auth.ts)
 * or a sign-in provider's `yandex-`, `vk-`, `google-`, `oidc-`
 * (account-identities.ts).
 * An operator login is 3–40 characters and can never take that form, so
 * only operator-created accounts escape the new-account rules.
 */
export const SIGNED_UP_SQL = (account: string) =>
  `(${account}.name IN ('email-' || ${account}.id::text, 'yandex-' || ${account}.id::text, 'vk-' || ${account}.id::text, 'google-' || ${account}.id::text, 'oidc-' || ${account}.id::text))`;

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
              WHERE report.tenant_id=tenant.id AND report.status='new'
                AND report.comment_id IS NULL) AS open_reports,
       EXISTS(SELECT 1 FROM shares share
              WHERE share.tenant_id=tenant.id AND share.moderation='paused'
                AND NOT share.revoked AND share.expires_at>now()) AS paused_links,
       EXISTS(SELECT 1 FROM moderation_blocks block
              WHERE block.tenant_id=tenant.id AND block.released_at IS NULL)
         AS blocked_content,
       -- Signed in through Яндекс ID or VK ID: the provider knows the person
       -- (docs/specs/SIGN_IN_PROVIDERS.md), a lower risk than a bare address.
       EXISTS(SELECT 1 FROM account_identities identity
              WHERE identity.account_id=account.id
                AND identity.provider IN ('yandex','vk')) AS identity_verified,
       (SELECT count(*)::int FROM revisions revision
        WHERE revision.tenant_id=tenant.id
          AND NOT EXISTS(SELECT 1 FROM moderation_blocks block
                         WHERE block.revision_id=revision.id)) AS clean_saves
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
    blockedContent: row.blocked_content,
    identityVerified: row.identity_verified,
    cleanSaves: row.clean_saves,
    // Under auto, trust by age also needs a few clean saves: nobody approves
    // a new author by hand. A block or a pause takes trust away.
    trusted:
      !row.paused_links &&
      !row.blocked_content &&
      (row.operator_created ||
        row.approved ||
        (row.aged &&
          !row.open_reports &&
          (config.SHARE_MODERATION !== "auto" ||
            row.clean_saves >= config.TRUST_MIN_CLEAN_SAVES))),
  };
}

/** Why the author is not trusted, as the end of a sentence for them. */
function untrustedBecause(standing: AuthorStanding) {
  if (standing.blockedContent)
    return "пока одна из ваших работ заблокирована модератором Полки";
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
  const daily = config.NEW_ACCOUNT_DAILY_LINKS;
  if (daily) {
    const {
      rows: [{ today, retry_after }],
    } = await c.query(
      `SELECT count(*)::int AS today,
         extract(epoch FROM min(created_at)+interval '1 day'-now())::float8 AS retry_after
       FROM shares WHERE tenant_id=$1 AND created_at>now()-interval '1 day'`,
      [tenantId],
    );
    if (today >= daily)
      throw new Problem(
        429,
        "quota",
        `За сутки вы уже создали ${today} ${linksWord(today)}: ${untrustedBecause(standing)}, в сутки можно создать не больше ${daily}. Продолжите завтра.`,
      ).retryIn(retry_after ?? 86_400);
  }
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
  /** The content filter blocks the revision (docs/specs/CONTENT_FILTER.md). */
  block?: Category | null;
  /** ...and disables its author. */
  freeze?: boolean;
  /** What the content filter found, for the journal and the letter. */
  content?: ContentDecision;
};

/**
 * SHARE_MODERATION: off never holds; auto holds only what the content filter
 * flags (and a new account's images while no image model checks them);
 * flagged holds a suspicious page of an author who is not trusted;
 * new-accounts holds any link of such an author; all holds any link of an
 * account that signed up by email. A suspicious page that opens anyway is
 * reported to the operator.
 */
export function decideModeration(
  standing: AuthorStanding,
  signals: readonly string[],
  mode = config.SHARE_MODERATION,
  content: ContentDecision = NO_DECISION,
  /**
   * The revision shows images (an image file, a bundle image, data: images)
   * that no model has checked (none configured, not yet, failed, or out of
   * budget).
   */
  images = false,
): ModerationDecision {
  // The content filter first: it has its own switch (CONTENT_FILTER_MODE).
  if (content.action === "block")
    return {
      hold: null,
      notify: false,
      block: content.category,
      freeze: content.freeze,
      content,
    };
  const legacy = decideLegacy(standing, signals, mode, images);
  if (content.action === "hold")
    return {
      // A phishing page keeps its familiar reason.
      hold:
        content.category === "fraud" && legacy.hold === "suspicious"
          ? "suspicious"
          : (contentReason(content) as ModerationReason),
      notify: false,
      content,
    };
  return {
    ...legacy,
    notify: legacy.notify || (!legacy.hold && content.action === "notify"),
    ...(content.findings.length ? { content } : {}),
  };
}

function decideLegacy(
  standing: AuthorStanding,
  signals: readonly string[],
  mode: typeof config.SHARE_MODERATION,
  images: boolean,
): ModerationDecision {
  if (mode === "off") return { hold: null, notify: false };
  if (mode === "auto") {
    // Nobody reviews authors by hand. Images are the one thing rules cannot
    // read: without an image model, a young account's images wait.
    const young =
      !standing.operatorCreated &&
      !standing.approved &&
      !standing.identityVerified &&
      !standing.aged;
    const unchecked = images && young;
    return {
      hold: unchecked ? "image-unchecked" : null,
      notify: false,
    };
  }
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
  blocked:
    "Ссылка заблокирована модератором Полки: получатели видят экран «Ссылка недоступна». Работу нельзя отправить заново; обжаловать решение можно письмом оператору.",
  held: "Ссылка создана, но пока на проверке у модератора Полки: получатели увидят работу после одобрения. Передайте ссылку с этим пояснением или дождитесь проверки; владелец видит состояние на полке.",
  paused:
    "Ссылка приостановлена после жалоб получателей и ждёт решения модератора Полки. Получатели сейчас видят экран проверки вместо работы.",
};

export type ModerationNotice =
  | { kind: "held"; shareId: string; content?: ContentDecision }
  | { kind: "suspicious"; shareId: string; content?: ContentDecision }
  | { kind: "report"; shareId: string; reportId: string; paused: boolean }
  | {
      kind: "blocked";
      shareId: string | null;
      revisionId: string;
      category: Category | "other";
      frozen: boolean;
      /** Who blocked: the filter or the operator. */
      by: "filter" | "operator";
      content?: ContentDecision;
    };
