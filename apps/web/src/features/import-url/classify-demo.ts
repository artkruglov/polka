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
  // Artifacts shared from Claude/ChatGPT open only inside the provider's app and
  // answer servers with a bot-protection page, so Полка cannot fetch a copy.
  const provider = providerArtifact(host, path);
  if (provider)
    return {
      status: "provider",
      source: provider,
      host,
      title: provider === "claude" ? "Артефакт Claude" : "Работа из ChatGPT",
      explain: `${provider === "claude" ? "Claude" : "ChatGPT"} показывает такую ссылку только в своём приложении, а на запросы сервера отвечает защитной страницей, поэтому Полка не может сама забрать копию. Скачайте работу в чате (меню ⋯ → Download) и перетащите файл сюда — ссылка на Полке будет готова сразу.`,
    };
  const loginPath = /(^|\/)(login|signin|sign-in|auth|oauth)(\/|$)/.test(path);
  if (loginPath || (sourceOf(host) && !isPublic(host, path)))
    return {
      status: "closed",
      source: sourceOf(host),
      host,
      title: "Ссылка похожа на закрытую",
      explain: `Такая страница открывается только после входа, и Полка её не обходит. Скачайте работу из чата как HTML. ${FILE_NEXT}`,
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
    explain: `Узнаём ссылки на артефакты Claude и ChatGPT и прямые ссылки на HTML. ${FILE_NEXT}`,
  };
}

function providerArtifact(host: string, path: string): ImportSource {
  if (host === "claude.site" || host.endsWith(".claude.site")) return "claude";
  if (host === "claude.ai" && /^\/(artifact|public\/artifacts)\/[^/]+/.test(path))
    return "claude";
  if ((host === "chatgpt.com" || host === "chat.openai.com") && /^\/(share|canvas\/shared)\/[^/]+/.test(path))
    return "chatgpt";
  return null;
}

function sourceOf(host: string): ImportSource {
  return host === "claude.ai" ? "claude" : host === "chatgpt.com" || host === "chat.openai.com" ? "chatgpt" : null;
}

function isPublic(host: string, path: string) {
  return providerArtifact(host, path) !== null;
}
