import type { Viewer } from "../../../../../packages/contracts/index.ts";

/**
 * What the recipient's note says above a page opened by link
 * (docs/specs/CONTENT_FILTER.md, «Поля для секретов»; ABUSE_PROTECTION.md, 7).
 *
 * The warning about passwords, SMS codes and cards is shown only when there
 * is a reason: the page has fields for them (sensitiveInput true) or nobody
 * knows yet (null, a version saved before this was recorded). A page without
 * such fields gets a quiet line. «Проверила» is said only after the automatic
 * check answered and found nothing (autoChecked).
 */
export type RecipientNote = {
  tone: "editorial" | "quiet" | "warning";
  /** The one line always in view. */
  line: string;
  /** The first paragraph behind «Подробнее» (without «Автор недавно на Полке»). */
  details: string;
};

export const NOTE_UNKNOWN =
  "Страница пользователя Полки. Не вводите здесь пароли, коды из SMS и данные карт.";
export const NOTE_ASKS =
  "Страница пользователя Полки просит пароль, код или данные карты. Не вводите их здесь.";
export const NOTE_QUIET = "Опубликовал пользователь Полки";
export const CHECKED =
  "Полка проверила текст и код автоматически; человек страницу не проверял.";
export const NOT_CHECKED = "Полка её пока не проверила.";

export function recipientNote(
  viewer: Pick<Viewer, "publisher" | "sensitiveInput" | "autoChecked">,
): RecipientNote {
  if (viewer.publisher === "editorial")
    return {
      tone: "editorial",
      line: "Редакция Полки",
      details: "Эту страницу подготовила редакция Полки.",
    };
  const check = viewer.autoChecked ? CHECKED : NOT_CHECKED;
  const intro = "Эту страницу опубликовал пользователь Полки.";
  if (viewer.sensitiveInput === false)
    return { tone: "quiet", line: NOTE_QUIET, details: `${intro} ${check}` };
  return {
    tone: "warning",
    line: viewer.sensitiveInput ? NOTE_ASKS : NOTE_UNKNOWN,
    details: viewer.sensitiveInput
      ? `${intro} ${check} На ней есть поля для паролей, кодов или данных карт — не вводите их здесь.`
      : `${intro} ${check} Не вводите здесь пароли, коды из SMS и данные карт.`,
  };
}
