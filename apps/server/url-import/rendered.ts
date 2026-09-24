import { matchLink, renderable } from "../../../packages/contracts/link-providers.ts";
import type { RenderError, RenderResult } from "../../../packages/renderer-contract.ts";
import { captureHtmlDocument, HtmlCaptureError, type Fetcher } from "./html-capture.ts";
import { fetchPublic, publicUrl } from "./public-fetch.ts";
import { rendererClient, type RenderCall } from "./renderer-client.ts";

/*
 * A page opened by the isolated renderer (docs/specs/URL_IMPORT_SUPPORT.md,
 * «Рендерер»): an allowlisted SPA host (server-render) or a Claude artifact
 * (server-try). The renderer checks robots.txt for PolkaRenderer from its own
 * network, opens the page once, and answers the DOM or an error code. The DOM
 * without scripts goes through the usual localisation (captureHtmlDocument:
 * CSS, images and fonts via fetchPublic) → a bundle with provenance renderer
 * 'headless-snapshot-v1'. A bot check or consent wall is source_blocked;
 * nothing is retried or worked around.
 */

export const SNAPSHOT_WARNING = "Снимок страницы на момент сохранения: интерактив может не работать.";

const FAILURES: Record<RenderError, [string, string]> = {
  source_blocked: [
    "source_blocked",
    "Сайт показал проверку на бота или окно согласия вместо страницы. Полка такие проверки не проходит: сохраните страницу другим способом.",
  ],
  robots_disallowed: [
    "robots_disallowed",
    "Сайт запрещает роботам открывать эту страницу (robots.txt). Сохраните её файлом или как ссылку.",
  ],
  robots_unavailable: [
    "robots_unavailable",
    "Сайт не отдал robots.txt, поэтому Полка его сейчас не открывает. Повторите позже.",
  ],
  timeout: ["timeout", "Страница не успела открыться за 25 секунд."],
  not_allowed: ["not_allowed", "Страница ведёт на сайт, который Полка не открывает."],
  navigation_failed: ["source_unavailable", "Страница не открылась: сайт недоступен или вернул ошибку."],
  too_large: ["too_large", "Страница больше 5 МБ."],
  busy: ["renderer_busy", "Сервис снимков сейчас занят. Повторите через минуту."],
  bad_request: ["renderer_unavailable", "Сервис снимков не принял запрос."],
  unauthorized: ["renderer_unavailable", "Сервис снимков не принял запрос."],
};

/** A renderer error as the job's error code and message. */
export function rendererFailure(error: RenderError): HtmlCaptureError {
  const [code, message] = FAILURES[error];
  return new HtmlCaptureError(code, message);
}

export const rendererUnavailable = () =>
  new HtmlCaptureError("renderer_unavailable", "Сервис снимков страниц недоступен. Повторите позже.");

export type RenderedOptions = {
  render?: RenderCall;
  fetcher?: Fetcher;
  /** Called just before the renderer opens the page. */
  onRendering?: () => Promise<void>;
  signal?: AbortSignal;
};

/** The document to keep from a render: the page, or for a Claude artifact its frame. */
function documentOf(url: URL, result: Extract<RenderResult, { finalUrl: string }>) {
  if (matchLink(url)?.route !== "server-try") return { url: result.finalUrl, html: result.html, title: result.title };
  // Claude: the artifact is drawn in a frame on *.claudeusercontent.com (or its srcdoc child); the page around it is the chat app.
  const frames = result.frames.filter((frame) => frame.url === "about:srcdoc" || /^https:\/\/[^/]*\.claudeusercontent\.com\//.test(frame.url));
  const best = frames.sort((a, b) => b.html.length - a.html.length)[0];
  if (!best || best.html.replace(/<[^>]+>/g, "").trim().length < 20)
    throw new HtmlCaptureError("source_blocked", "Артефакт не отрисовался для сервера Полки. Сохраните его другим способом.");
  return { url: result.finalUrl, html: best.html, title: result.title.replace(/\s*[|–-]\s*Claude\s*$/i, "") };
}

export async function captureRendered(
  input: string,
  { render = rendererClient(), fetcher = fetchPublic, onRendering, signal }: RenderedOptions = {},
) {
  const target = publicUrl(input);
  if (!renderable(target)) throw new HtmlCaptureError("not_allowed", "Полка не открывает этот сайт в браузере.");
  await onRendering?.();
  let result: RenderResult;
  try {
    result = await render(target.href, signal);
  } catch {
    throw rendererUnavailable();
  }
  if ("error" in result) throw rendererFailure(result.error);
  const final = publicUrl(result.finalUrl);
  if (!renderable(final)) throw new HtmlCaptureError("not_allowed", "Страница перенаправила на сайт, который Полка не открывает.");
  const document = documentOf(target, result);
  return captureHtmlDocument(
    { url: final.href, contentType: "text/html", bytes: Buffer.from(document.html, "utf8") },
    {
      fetcher,
      signal,
      renderer: "headless-snapshot-v1",
      stripScripts: true,
      warnings: [SNAPSHOT_WARNING],
      sourceUrl: target.href,
      ...(document.title.trim() ? { title: document.title } : {}),
    },
  );
}
