import type { ImportStatus } from "../../../../../packages/contracts/index.ts";
import {
  matchLink,
  type LinkProvider,
  type LinkProviderId,
  type LinkRoute,
} from "../../../../../packages/contracts/link-providers.ts";

export type ImportSource = LinkProviderId | "html" | "zip" | null;

export type ImportClassification = {
  status: ImportStatus;
  source: ImportSource;
  /** Host for display; null when the input is not a URL at all. */
  host: string | null;
  title: string;
  explain: string;
  /** The service from the provider table (packages/contracts/link-providers.ts). */
  provider: LinkProvider | null;
  route: LinkRoute | null;
};

// Client-only recognition of a pasted link. Nothing is fetched: used when server
// import is off, and for links of services the server never opens. The routes
// come from the same provider table the server uses.
const FILE_NEXT = "Импорт по ссылке ещё не подключён: сохраните страницу файлом.";

/**
 * @param sources what this installation's server import copies
 *   (/api/capabilities urlImportSources); empty when import is off.
 */
export function classify(input: string, sources: readonly string[] = []): ImportClassification {
  const base = { provider: null, route: null } as const;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return {
      ...base,
      status: "not_https",
      source: null,
      host: null,
      title: "Это не ссылка",
      explain: `Вставьте адрес целиком, начиная с https://. ${FILE_NEXT}`,
    };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const match = matchLink(url);
  if (!match)
    return {
      ...base,
      status: "not_https",
      source: null,
      host,
      title: "Нужна ссылка https://",
      explain: `Полка принимает только защищённые адреса. ${FILE_NEXT}`,
    };
  const { provider, route } = match;
  const path = url.pathname.toLowerCase();
  const loginPath = /(^|\/)(login|signin|sign-in|auth|oauth)(\/|$)/.test(path);
  if (loginPath || match.closed)
    return {
      provider,
      route,
      status: "closed",
      source: provider?.id ?? null,
      host,
      title: "Ссылка похожа на закрытую",
      explain: `Такая страница открывается только после входа, и Полка её не обходит. Скачайте артефакт из чата как HTML. ${FILE_NEXT}`,
    };
  if (provider && route === "extension")
    return {
      provider,
      route,
      status: "provider",
      source: provider.id,
      host,
      title: provider.title(url.pathname, host),
      explain: `${provider.name} запрещает автоматическое извлечение, поэтому сервер Полки такие ссылки не открывает. Сохраните её из своего браузера расширением, попросите агента или загрузите скачанный файл — ссылка будет готова сразу.`,
    };
  if (provider && route === "server-api" && sources.includes("github-gist"))
    return {
      provider,
      route,
      status: "ready",
      source: provider.id,
      host,
      title: "GitHub Gist",
      explain: "Полка прочитает gist через официальный API GitHub и сохранит копию.",
    };
  if (provider && route === "server-render" && sources.includes("rendered-spa"))
    return {
      provider,
      route,
      status: "ready",
      source: provider.id,
      host,
      title: `Сайт на ${provider.name}`,
      explain:
        "Полка откроет страницу в изолированном браузере и сохранит снимок: интерактив может не работать.",
    };
  if (/\.html?$/.test(path))
    return {
      provider,
      route,
      status: "ready",
      source: "html",
      host,
      title: "Прямая ссылка на HTML",
      explain: `Похоже на HTML-файл. Откройте его, сохраните на компьютер и загрузите. ${FILE_NEXT}`,
    };
  if (/\.zip$/.test(path))
    return {
      provider,
      route,
      status: "unsupported_host",
      source: "zip",
      host,
      title: "ZIP пока не поддерживается",
      explain: "Архивы эта сборка не принимает. Сохраните из архива один HTML-файл без внешних ресурсов и загрузите его.",
    };
  return {
    provider,
    route,
    status: "unsupported_host",
    source: provider?.id ?? null,
    host,
    title: provider ? `Сайт на ${provider.name}` : "Этот сайт не распознан",
    explain: provider
      ? `Эта установка пока не сохраняет такие страницы сама. ${FILE_NEXT}`
      : `Узнаём ссылки на артефакты AI-сервисов и прямые ссылки на HTML. ${FILE_NEXT}`,
  };
}
