// Letters to the operator (docs/specs/ABUSE_PROTECTION.md, 4–5): a link that
// waits for review, a suspicious page of a trusted author, every report, and
// an automatic pause. Sent after the transaction that caused them commits,
// and never allowed to fail that action: a lost letter is logged, and the
// scripts in scripts/moderation.ts still see the queue.
import { db } from "./db.ts";
import { config } from "./config.ts";
import { sendMail } from "./mailer.ts";
import { clean } from "./moderation.ts";
import { moderationUrl, type ModerationAction } from "./moderation-tokens.ts";
import { describeSignals } from "./phishing-signals.ts";
import {
  CATEGORY_LABEL,
  describeFindings,
  findingsOf,
  type ContentDecision,
} from "./content-filter/policy.ts";
import { modelView } from "./content-moderation.ts";
import {
  authorStanding,
  SIGNED_UP_SQL,
  type ModerationNotice,
} from "./share-moderation.ts";

const REPORT_REASON: Record<string, string> = {
  phishing: "фишинг или выдаёт себя за другого",
  malware: "вредоносное содержимое",
  personal_data: "чужие персональные данные",
  illegal: "незаконное содержимое",
  child_sexual: "сексуальное с участием детей",
  intimate_nonconsensual: "интимное без согласия",
  threat_to_life: "угроза жизни",
  other: "другое",
};

const HOLD_REASON: Record<string, string> = {
  suspicious: "похоже на фишинг, а автор ещё не доверенный",
  "new-account": "первая проверка ссылок нового аккаунта (SHARE_MODERATION=new-accounts)",
  "review-all": "проверка всех ссылок (SHARE_MODERATION=all)",
  reports: "приостановлена после жалоб",
  "image-unchecked":
    "изображение нового аккаунта ещё не проверила модель (SHARE_MODERATION=auto): ссылка откроется сама, если модель ничего не найдёт; без модели или при исчерпанном бюджете — ждёт вас",
  "model-unavailable":
    "автор ещё не доверенный, а модель-классификатор не ответила (таймаут, ошибка или дневной лимит)",
};

/** Why a link waits, for a reason stored by the content filter too. */
function holdReason(reason: string | null) {
  if (!reason) return "ссылка ждёт проверки";
  if (HOLD_REASON[reason]) return HOLD_REASON[reason];
  const [kind, category] = reason.split(":");
  const label = CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL] ?? category;
  if (kind === "spam")
    return `похоже на спам (${label}): автор видит «на проверке», получатели — ничего`;
  if (kind === "content") return `фильтр содержимого: ${label}`;
  return reason;
}

/** What the filter found: from the decision, or read back from the revision. */
function contentLine(content: ContentDecision | undefined, facts: any) {
  const findings =
    content?.findings ??
    findingsOf(facts.content_filter, modelView(facts.content_filter));
  return findings.length ? describeFindings(findings) : "";
}

/** A CSAM signal: no title, no text, no preview, anywhere. */
export const csamSignal = (content: ContentDecision | undefined, facts: any) =>
  !!content?.findings.some((finding) => finding.category === "csam") ||
  (facts?.content_filter?.hits?.csam?.score ?? 0) >= 6 ||
  facts?.moderation_reason === "blocked:csam";

export const ACTION_LABEL: Record<ModerationAction, string> = {
  preview: "Посмотреть",
  approve: "Одобрить ссылку",
  "approve-trust": "Одобрить и доверять автору",
  unpause: "Снять паузу",
  close: "Закрыть ссылку",
  "close-disable": "Закрыть и отключить автора",
  block: "Заблокировать",
};

const kindOf = (mime: string) =>
  mime === "text/html"
    ? "страница"
    : mime === "text/plain"
      ? "текст"
      : mime === "text/markdown"
        ? "документ"
        : "изображение";

const PROFILE: Record<string, string> = {
  static: "статичная",
  limited: "со скриптами, показывается статично",
  unsupported: "только интерактивная версия",
};

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );

function accountAge(createdAt: Date | null) {
  if (!createdAt) return "создан до 23.09.2026 (дата не записана)";
  const days = Math.floor((Date.now() - createdAt.getTime()) / 86_400_000);
  return days < 1 ? "создан сегодня" : `создан ${days} дн. назад`;
}

/** Everything the letter says about one link. */
async function shareFacts(shareId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT share.id,share.tenant_id,share.moderation,share.moderation_reason,share.created_by,
       (NOT share.revoked AND share.expires_at>now()) AS live,share.expires_at,
       artifact.title,revision.mime,revision.html_profile,revision.number,
       revision.storage_kind,revision.phishing_signals,revision.content_filter,
       revision.manifest->>'runtime' AS runtime,
       jsonb_array_length(revision.manifest->'files') AS file_count,
       revision.id AS revision_id,
       account.name,account.email,${SIGNED_UP_SQL("account")} AS signed_up,
       EXISTS(SELECT 1 FROM editorial_publications publication
              WHERE publication.share_id=share.id) AS editorial,
       (SELECT count(DISTINCT report.reporter_hash) FROM share_reports report
        WHERE report.share_id=share.id AND report.comment_id IS NULL
          AND report.created_at>now()-interval '7 days') AS reporters
     FROM shares share
     JOIN artifacts artifact ON artifact.id=share.artifact_id
     JOIN revisions revision ON revision.id=share.revision_id
     JOIN tenants tenant ON tenant.id=share.tenant_id
     JOIN accounts account ON account.id=COALESCE(tenant.owner_id,share.created_by)
     WHERE share.id=$1`,
    [shareId],
  );
  if (!row) return null;
  const standing = await authorStanding(db, row.tenant_id, row.created_by);
  return { ...row, standing };
}

type Letter = {
  subject: string;
  lead: string;
  reason: string;
  actions: ModerationAction[];
};

async function letterFor(
  notice: Exclude<ModerationNotice, { kind: "blocked" }>,
  facts: any,
): Promise<Letter> {
  const signals = describeSignals(facts.phishing_signals ?? []);
  const content =
    notice.kind === "report" ? contentLine(undefined, facts) : contentLine(notice.content, facts);
  const found = [
    signals ? `Признаки: ${signals}` : "",
    content ? `Фильтр содержимого: ${content}` : "",
  ]
    .filter(Boolean)
    .join(". ");
  if (notice.kind === "held")
    return {
      subject: "ссылка ждёт проверки",
      lead: "Новая ссылка ждёт вашей проверки. Получатели видят экран «на проверке», пока вы её не одобрите.",
      reason: holdReason(facts.moderation_reason) + (found ? `. ${found}` : ""),
      actions: ["approve", "approve-trust", "close", "block", "close-disable"],
    };
  if (notice.kind === "suspicious")
    return {
      subject: content ? "ссылка с признаками запрещённого" : "подозрительная страница",
      lead: content
        ? "Фильтр нашёл признаки запрещённого содержимого, но автор доверенный и счёт невысокий, поэтому ссылка уже работает. Посмотрите её."
        : "Страница похожа на фишинг, но автор доверенный, поэтому ссылка уже работает. Посмотрите её.",
      reason: content ? found : `похоже на фишинг. Признаки: ${signals}`,
      actions: ["close", "block", "close-disable"],
    };
  const {
    rows: [report],
  } = await db.query(
    "SELECT reason,comment,created_at FROM share_reports WHERE id=$1",
    [notice.reportId],
  );
  const complaint = `жалоба: ${REPORT_REASON[report?.reason] ?? report?.reason ?? "—"}${
    report?.comment ? ` — «${clean(report.comment, 500)}»` : ""
  }. Разных жалобщиков за 7 дней: ${facts.reporters}${
    config.MODERATION_AUTOPAUSE_REPORTS
      ? ` (пауза с ${config.MODERATION_AUTOPAUSE_REPORTS})`
      : ""
  }`;
  if (notice.paused)
    return {
      subject: "ссылка приостановлена после жалоб",
      lead: "На ссылку пожаловались несколько разных получателей, и Полка её приостановила. Автор перестал быть доверенным до вашего решения.",
      reason: complaint,
      actions: ["unpause", "approve-trust", "close", "close-disable"],
    };
  return {
    subject: "жалоба на ссылку",
    lead:
      facts.moderation === "paused"
        ? "Новая жалоба на уже приостановленную ссылку."
        : "Получатель пожаловался на ссылку. Она продолжает работать.",
    reason: complaint,
    actions:
      facts.moderation === "paused"
        ? ["unpause", "close", "block", "close-disable"]
        : ["approve", "close", "block", "close-disable"],
  };
}

function compose(
  notice: Exclude<ModerationNotice, { kind: "blocked" }>,
  facts: any,
  letter: Letter,
) {
  const csam = csamSignal("content" in notice ? notice.content : undefined, facts);
  // A CSAM signal: nothing of the work reaches the letter, and no preview.
  const title = csam ? "скрыто (сигнал CSAM)" : clean(facts.title, 120) || "Без названия";
  // No e-mail address in the letter: it may travel through a mail provider
  // abroad. The login identifies the account; moderation.ts shows the address
  // on the server when the operator needs it.
  const author = facts.signed_up
    ? `аккаунт ${clean(facts.name, 60)} (регистрация по почте)`
    : `логин ${clean(facts.name, 60)} (создан оператором)`;
  const standing = facts.standing.trusted ? "доверенный" : "новый";
  const rows: Array<[string, string]> = [
    ["Работа", `«${title}», версия ${facts.number}`],
    [
      "Тип",
      facts.runtime === "project-v1"
        ? `проект, ${facts.file_count} файлов (документы и страницы)`
        : facts.mime === "text/html"
        ? `${kindOf(facts.mime)}, ${PROFILE[facts.html_profile] ?? facts.html_profile}${facts.storage_kind === "bundle" ? ", пакет файлов" : ""}`
        : kindOf(facts.mime),
    ],
    ["Автор", `${author}; ${accountAge(facts.standing.createdAt)}; ${standing}`],
    ["Причина", letter.reason],
    [
      "Ссылка",
      !facts.live
        ? "уже закрыта или истекла"
        : facts.moderation === "none"
          ? "открыта для получателей"
          : facts.moderation === "held"
            ? "ждёт проверки"
            : facts.moderation === "blocked"
              ? "заблокирована"
              : "приостановлена",
    ],
  ];
  if (facts.editorial) rows.push(["Каталог", "это материал «Ленты»"]);
  const links = (
    [...(csam ? [] : ["preview"]), ...letter.actions] as ModerationAction[]
  ).map((action) => [ACTION_LABEL[action], moderationUrl(action, notice.shareId)]);
  const text = [
    letter.lead,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    ...links.map(([label, url]) => `${label}: ${url}`),
    "",
    "Каждая кнопка открывает страницу подтверждения: само открытие ничего не меняет. Ссылки действуют 7 дней, повтор безопасен.",
    `Без почты то же делают скрипты: moderation:queue, moderation:approve, moderation:revoke-share (share ${notice.shareId}).`,
  ].join("\n");
  const html = `<!doctype html><html lang="ru"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1d1d1f">
<p>${escape(letter.lead)}</p>
<table cellpadding="4" style="border-collapse:collapse">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="color:#6e6e73;vertical-align:top">${escape(label)}</td><td>${escape(value)}</td></tr>`,
    )
    .join("")}</table>
<p>${links
    .map(
      ([label, url], index) =>
        `<a href="${escape(url)}" style="display:inline-block;margin:4px 6px 4px 0;padding:8px 14px;border-radius:8px;text-decoration:none;${
          index === 0
            ? "border:1px solid #1d1d1f;color:#1d1d1f"
            : "background:#1d1d1f;color:#fff"
        }">${escape(label)}</a>`,
    )
    .join("")}</p>
<p style="color:#6e6e73;font-size:13px">Каждая кнопка открывает страницу подтверждения: само открытие ничего не меняет. Ссылки действуют 7 дней, повтор безопасен. Share ${escape(notice.shareId)}.</p>
</body></html>`;
  return {
    subject: `Полка: ${letter.subject} — «${clean(title, 60)}»`,
    text,
    html,
  };
}

/**
 * A block (by the filter or the operator). For CSAM only ids and what was
 * done: no title, no text, no terms, no preview.
 */
async function composeBlocked(notice: Extract<ModerationNotice, { kind: "blocked" }>) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT revision.id,revision.number,revision.mime,revision.sha256,
       revision.size,revision.content_filter,revision.artifact_id,
       artifact.title,account.id AS account_id,account.name,
       ${SIGNED_UP_SQL("account")} AS signed_up,
       block.legal_hold,block.delete_after
     FROM revisions revision
     JOIN artifacts artifact ON artifact.id=revision.artifact_id
     JOIN tenants tenant ON tenant.id=revision.tenant_id
     JOIN accounts account ON account.id=COALESCE(tenant.owner_id,revision.created_by)
     LEFT JOIN moderation_blocks block ON block.revision_id=revision.id
     WHERE revision.id=$1`,
    [notice.revisionId],
  );
  if (!row) return null;
  const csam = notice.category === "csam";
  const label = CATEGORY_LABEL[notice.category];
  const deleted = row.legal_hold
    ? `хранится по legal hold: ${clean(row.legal_hold, 200)}`
    : !row.delete_after || new Date(row.delete_after).getTime() <= Date.now() + 60_000
      ? "удаляется сейчас (все версии объектов в хранилище); остаются sha256 и метаданные"
      : `будет удалено ${new Date(row.delete_after).toISOString().slice(0, 10)}`;
  const rows: Array<[string, string]> = [
    ["Категория", label],
    ["Кто", notice.by === "filter" ? "фильтр содержимого (автоматически)" : "оператор"],
    ...(csam
      ? []
      : ([
          ["Работа", `«${clean(row.title, 120) || "Без названия"}», версия ${row.number}`],
          ["Найдено", contentLine(notice.content, { content_filter: row.content_filter }) || "—"],
        ] as Array<[string, string]>)),
    [
      "Автор",
      `${row.signed_up ? "аккаунт" : "логин"} ${clean(row.name, 60)}${notice.frozen ? " — отключён" : ""}`,
    ],
    ["Содержимое", deleted],
    [
      "Идентификаторы",
      `работа ${row.artifact_id}, версия ${row.id}${notice.shareId ? `, ссылка ${notice.shareId}` : ""}, аккаунт ${row.account_id}, sha256 ${row.sha256}, ${row.size} байт, ${row.mime}`,
    ],
  ];
  const lead = csam
    ? "Сработал признак CSAM. Работа заблокирована для всех, автор отключён, содержимое не показывается нигде, в том числе вам."
    : "Работа заблокирована: получатели видят «Ссылка недоступна».";
  const lines = [
    lead,
    "",
    ...rows.map(([name, value]) => `${name}: ${value}`),
    "",
    `Снять блокировку: npm run moderation:unblock -- ${row.id}`,
    `Сохранить доказательства (legal hold): npm run moderation:hold -- ${row.id} --authority "…"`,
    ...(notice.frozen
      ? [`Вернуть доступ автору: npm run moderation:enable -- ${clean(row.name, 60)}`]
      : []),
    `Журнал: npm run moderation:events -- ${row.artifact_id}`,
  ];
  return {
    subject: csam
      ? "Полка: сигнал CSAM — работа заблокирована"
      : `Полка: заблокировано (${label})`,
    text: lines.join("\n"),
    html: `<!doctype html><html lang="ru"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1d1d1f">${lines
      .map((line) => (line ? `<p style="margin:4px 0">${escape(line)}</p>` : "<br>"))
      .join("")}</body></html>`,
  };
}

/** One letter; errors are logged, never thrown into the caller. */
export async function sendModerationNotice(notice: ModerationNotice) {
  if (!config.OPERATOR_EMAIL || config.MAIL_MODE === "disabled") return null;
  try {
    if (notice.kind === "blocked") {
      const letter = await composeBlocked(notice);
      return letter ? await sendMail({ to: config.OPERATOR_EMAIL, ...letter }) : null;
    }
    const facts = await shareFacts(notice.shareId);
    if (!facts) return null;
    const letter = compose(notice, facts, await letterFor(notice, facts));
    return await sendMail({ to: config.OPERATOR_EMAIL, ...letter });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "moderation.mail_failed",
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

/**
 * Send after commit, without holding up the response: SMTP may take seconds.
 * The returned promise settles when every letter is written or given up.
 */
export function dispatchModerationNotices(notices: ModerationNotice[]) {
  return Promise.all(notices.map(sendModerationNotice)).then(() => undefined);
}
