import type { ImportStatus } from "../../../../../packages/contracts/index.ts";

export type ImportSource = "claude" | "chatgpt" | "html" | "zip" | null;

export type ImportClassification = {
  status: ImportStatus;
  source: ImportSource;
  /** Host for display; null when the input is not a URL at all. */
  host: string | null;
  title: string;
  explain: string;
};

// Client-only recognition of a pasted link. Nothing is fetched: the server has no URL importer yet,
// so every outcome ends with the same real next step — save the page as a file.
const FILE_NEXT = "Импорт по ссылке ещё не подключён: сохраните страницу файлом.";

export function classify(input: string): ImportClassification {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return {
      status: "not_https",
      source: null,
      host: null,
      title: "Это не ссылка",
      explain: `Вставьте адрес целиком, начиная с https://. ${FILE_NEXT}`,
    };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:")
    return {
      status: "not_https",
      source: null,
      host,
      title: "Нужна ссылка https://",
      explain: `Полка принимает только защищённые адреса. ${FILE_NEXT}`,
    };
  const path = url.pathname.toLowerCase();
  const loginPath = /(^|\/)(login|signin|sign-in|auth|oauth)(\/|$)/.test(path);
  if (loginPath || (sourceOf(host) && !isPublic(host, path)))
    return {
      status: "closed",
      source: sourceOf(host),
      host,
      title: "Ссылка похожа на закрытую",
      explain: `Такая страница открывается только после входа, и Полка её не обходит. Скачайте работу из чата как HTML. ${FILE_NEXT}`,
    };
  if (host === "claude.ai" && /^\/public\/artifacts\/[^/]+/.test(path))
    return {
      status: "ready",
      source: "claude",
      host,
      title: "Публичная ссылка Claude",
      explain: `Ссылку узнали. Скачивать её копию Полка пока не умеет. ${FILE_NEXT}`,
    };
  if ((host === "chatgpt.com" || host === "chat.openai.com") && /^\/(share|canvas\/shared)\/[^/]+/.test(path))
    return {
      status: "ready",
      source: "chatgpt",
      host,
      title: "Публичная ссылка ChatGPT",
      explain: `Ссылку узнали. Скачивать её копию Полка пока не умеет. ${FILE_NEXT}`,
    };
  if (/\.html?$/.test(path))
    return {
      status: "ready",
      source: "html",
      host,
      title: "Прямая ссылка на HTML",
      explain: `Похоже на HTML-файл. Откройте его, сохраните на компьютер и загрузите. ${FILE_NEXT}`,
    };
  if (/\.zip$/.test(path))
    return {
      status: "unsupported_host",
      source: "zip",
      host,
      title: "ZIP пока не поддерживается",
      explain: "Архивы эта сборка не принимает. Сохраните из архива один HTML-файл без внешних ресурсов и загрузите его.",
    };
  return {
    status: "unsupported_host",
    source: null,
    host,
    title: "Этот сайт не распознан",
    explain: `Узнаём публичные ссылки Claude и ChatGPT и прямые ссылки на HTML. ${FILE_NEXT}`,
  };
}

function sourceOf(host: string): ImportSource {
  return host === "claude.ai" ? "claude" : host === "chatgpt.com" || host === "chat.openai.com" ? "chatgpt" : null;
}

function isPublic(host: string, path: string) {
  return (host === "claude.ai" && path.startsWith("/public/")) || ((host === "chatgpt.com" || host === "chat.openai.com") && /^\/(share|canvas\/shared)\//.test(path));
}
