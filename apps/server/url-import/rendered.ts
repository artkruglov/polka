import { renderable } from "../../../packages/contracts/link-providers.ts";
import type { RenderResult } from "../../../packages/renderer-contract.ts";
import { captureHtmlDocument, HtmlCaptureError, type Fetcher } from "./html-capture.ts";
import { fetchPublic, publicUrl } from "./public-fetch.ts";
import { rendererClient, type RenderCall } from "./renderer-client.ts";
import { robotsAllow, robotsFor, type Robots } from "./robots.ts";

/*
 * A page of an allowlisted SPA host, copied as a snapshot
 * (docs/specs/URL_IMPORT_SUPPORT.md, «Рендерер»):
 * robots.txt allows PolkaRenderer → the isolated renderer opens the page once
 * → its DOM without scripts goes through the usual localisation
 * (captureHtmlDocument: CSS, images and fonts via fetchPublic) → a bundle
 * with provenance renderer 'headless-snapshot-v1'. A bot check or consent
 * wall is source_blocked; nothing is retried.
 */

export const SNAPSHOT_WARNING = "Снимок страницы на момент сохранения: интерактив может не работать.";

const FAILURES: Record<Exclude<RenderResult, { finalUrl: string }>["error"], [string, string]> = {
  source_blocked: [
    "source_blocked",
    "Сайт показал проверку на бота или окно согласия вместо страницы. Полка такие проверки не проходит: сохраните страницу расширением, файлом или как ссылку.",
  ],
  timeout: ["timeout", "Страница не успела открыться за 25 секунд."],
  not_allowed: ["not_allowed", "Страница ведёт на сайт, который Полка не открывает."],
  navigation_failed: ["source_unavailable", "Страница не открылась: сайт недоступен или вернул ошибку."],
  too_large: ["too_large", "Страница больше 5 МБ."],
  busy: ["renderer_busy", "Сервис снимков сейчас занят. Повторите через минуту."],
  bad_request: ["renderer_unavailable", "Сервис снимков не принял запрос."],
  unauthorized: ["renderer_unavailable", "Сервис снимков не принял запрос."],
};

export type RenderedOptions = {
  render?: RenderCall;
  robots?: (origin: URL) => Promise<Robots>;
  fetcher?: Fetcher;
  /** Called once robots.txt allows the page, just before the renderer opens it. */
  onRendering?: () => Promise<void>;
  signal?: AbortSignal;
};

async function allowedByRobots(url: URL, robots: (origin: URL) => Promise<Robots>) {
  const answer = await robots(url);
  if ("unreachable" in answer)
    throw new HtmlCaptureError("robots_unavailable", "Сайт не отдал robots.txt, поэтому Полка его сейчас не открывает. Повторите позже.");
  if (!robotsAllow(answer, url))
    throw new HtmlCaptureError("robots_disallowed", "Сайт запрещает роботам открывать эту страницу (robots.txt). Сохраните её файлом или как ссылку.");
}

export async function captureRendered(
  input: string,
  { render = rendererClient(), robots = robotsFor, fetcher = fetchPublic, onRendering, signal }: RenderedOptions = {},
) {
  const target = publicUrl(input);
  if (!renderable(target)) throw new HtmlCaptureError("not_allowed", "Полка не открывает этот сайт в браузере.");
  await allowedByRobots(target, robots);
  await onRendering?.();
  let result: RenderResult;
  try {
    result = await render(target.href, signal);
  } catch {
    throw new HtmlCaptureError("renderer_unavailable", "Сервис снимков страниц недоступен. Повторите позже.");
  }
  if ("error" in result) {
    const [code, message] = FAILURES[result.error];
    throw new HtmlCaptureError(code, message);
  }
  const final = publicUrl(result.finalUrl);
  if (!renderable(final)) throw new HtmlCaptureError("not_allowed", "Страница перенаправила на сайт, который Полка не открывает.");
  if (final.host !== target.host) await allowedByRobots(final, robots);
  return captureHtmlDocument(
    { url: final.href, contentType: "text/html", bytes: Buffer.from(result.html, "utf8") },
    {
      fetcher,
      signal,
      renderer: "headless-snapshot-v1",
      stripScripts: true,
      warnings: [SNAPSHOT_WARNING],
      ...(result.title.trim() ? { title: result.title } : {}),
    },
  );
}
