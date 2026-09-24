import type { Browser, BrowserContext } from "playwright-core";
import { renderable } from "../../packages/contracts/link-providers.ts";
import {
  RENDER_MAX_HTML,
  RENDER_TIMEOUT_MS,
  RENDERER_USER_AGENT,
  type RenderResult,
} from "../../packages/renderer-contract.ts";
import { detectChallenge } from "./challenge.ts";

/*
 * One page, one fresh browser context, one attempt. The page runs its own
 * JavaScript (that is why it is rendered at all), but cannot open a
 * WebSocket, WebRTC or WebTransport connection, register a service worker,
 * download a file or ask for a permission, and every byte it loads goes
 * through the egress proxy. Top-level navigation may only reach hosts of the
 * renderer allowlist (packages/contracts/link-providers.ts). The result is
 * the serialized DOM; nothing of the page is kept after the context closes.
 */

export type RenderOptions = {
  /** The renderer allowlist; tests pass their fixture host. */
  allow?: (url: string) => boolean;
  timeoutMs?: number;
  /** Test hook for the fixture's self-signed certificate. Never in production. */
  ignoreHTTPSErrors?: boolean;
};

// Runs before any script of the page, in every frame.
const DISABLE_APIS = `(() => {
  for (const name of ["WebSocket", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport", "SharedWorker"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined, configurable: false }); } catch {}
})();`;

// The DOM as the reader sees it: CSS-in-JS rules that live only in the CSSOM
// are written into their <style> elements, adopted sheets get one of their
// own, form fields keep their current values.
const SERIALIZE = `(() => {
  for (const style of document.querySelectorAll("style")) {
    let text = "";
    try { text = Array.from(style.sheet ? style.sheet.cssRules : [], (rule) => rule.cssText).join("\\n"); } catch { continue; }
    if (text.length > (style.textContent || "").length) style.textContent = text;
  }
  const adopted = document.adoptedStyleSheets || [];
  if (adopted.length) {
    const style = document.createElement("style");
    style.textContent = adopted.flatMap((sheet) => { try { return Array.from(sheet.cssRules, (rule) => rule.cssText); } catch { return []; } }).join("\\n");
    (document.head || document.documentElement).append(style);
  }
  for (const input of document.querySelectorAll("input")) if (input.type !== "password") input.setAttribute("value", input.value);
  for (const area of document.querySelectorAll("textarea")) area.textContent = area.value;
  return (document.doctype ? "<!doctype html>" : "") + document.documentElement.outerHTML;
})()`;

export async function renderPage(
  browser: Browser,
  url: string,
  { allow = renderable, timeoutMs = RENDER_TIMEOUT_MS, ignoreHTTPSErrors = false }: RenderOptions = {},
): Promise<RenderResult> {
  if (!allow(url)) return { error: "not_allowed" };
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  let context: BrowserContext | null = null;
  let refusedNavigation = false;
  const work = (async (): Promise<RenderResult> => {
    context = await browser.newContext({
      userAgent: RENDERER_USER_AGENT,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      ignoreHTTPSErrors,
      viewport: { width: 1280, height: 900 },
      locale: "ru-RU",
    });
    await context.addInitScript({ content: DISABLE_APIS });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route("**/*", (route) => {
      const request = route.request();
      // A top-level navigation (a link, a script redirect) may not leave the allowlist.
      if (request.isNavigationRequest() && !request.frame().parentFrame() && !allow(request.url())) {
        refusedNavigation = true;
        return route.abort("blockedbyclient");
      }
      if (request.resourceType() === "media") return route.abort("blockedbyclient");
      return route.continue();
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: left() });
    } catch (error) {
      if (refusedNavigation) return { error: "not_allowed" };
      return { error: isTimeout(error) ? "timeout" : "navigation_failed" };
    }
    // Let the SPA fetch its data; a page that never goes quiet is taken as it is.
    await page.waitForLoadState("networkidle", { timeout: Math.min(10_000, Math.max(0, left() - 4_000)) }).catch(() => {});
    await page.waitForTimeout(Math.min(1_500, Math.max(0, left() - 2_500)));
    const evidence = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      headers: response?.headers() ?? {},
      status: response?.status() ?? 0,
      frameUrls: page.frames().map((frame) => frame.url()),
      text: String(await page.evaluate("document.body ? document.body.innerText.trim() : ''").catch(() => "")),
    };
    const challenge = detectChallenge(evidence);
    if (challenge) return { error: "source_blocked", detail: challenge };
    if (refusedNavigation || !allow(page.url())) return { error: "not_allowed" };
    // A «Page not found» of the host is not the page the user meant to save.
    if (evidence.status >= 400) return { error: "navigation_failed", detail: `http_${evidence.status}` };
    const html = String(await page.evaluate(SERIALIZE));
    if (Buffer.byteLength(html) > RENDER_MAX_HTML) return { error: "too_large" };
    const frames: Array<{ url: string; html: string }> = [];
    let frameBytes = 0;
    for (const frame of page.frames().slice(1, 9)) {
      if (!/^https:/.test(frame.url()) || left() < 1_000) continue;
      const content = await frame.content().catch(() => null);
      if (!content || frameBytes + Buffer.byteLength(content) > RENDER_MAX_HTML) continue;
      frameBytes += Buffer.byteLength(content);
      frames.push({ url: frame.url(), html: content });
    }
    return { finalUrl: page.url(), title: evidence.title.slice(0, 300), html, frames };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<RenderResult>((resolve) => {
    timer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs + 1_000);
  });
  try {
    return await Promise.race([work.catch((): RenderResult => ({ error: "navigation_failed" })), expired]);
  } finally {
    clearTimeout(timer);
    // The context (cookies, storage, cache) dies with the request, and also
    // when the deadline won the race while the page was still working.
    const close = () => (context as BrowserContext | null)?.close().catch(() => {});
    await close();
    void work.finally(close).catch(() => {});
  }
}

function isTimeout(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}
