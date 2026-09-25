import type { Browser, BrowserContext } from "playwright-core";
import {
  SNAPSHOT_MAX_IMAGE,
  SNAPSHOT_SCALE,
  SNAPSHOT_TIMEOUT_MS,
  SNAPSHOT_VIEWPORT,
  type SnapshotResult,
} from "../../packages/renderer-contract.ts";

/*
 * A shelf cover (docs/specs/SHELF_COVERS.md): the first screen of a page the
 * app sends, as a JPEG. The page is served to Chromium from a reserved
 * address (.invalid, RFC 6761) and nothing else loads: every other request,
 * WebSocket, service worker, download and permission is refused, so a script
 * of the page can draw but cannot reach anyone. One fresh context per page;
 * nothing is kept after it closes.
 */

const PAGE_URL = "https://cover.polka.invalid/";

const DISABLE_APIS = `(() => {
  for (const name of ["WebSocket", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport", "SharedWorker", "EventSource"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined, configurable: false }); } catch {}
})();`;

// Whether the first screen holds anything: text, a canvas, a drawing, an
// image, or a background that is not plain white.
const PAINTED = `(() => {
  const body = document.body;
  if (!body) return false;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 24 && r.top < innerHeight && r.bottom > 0; };
  if ((body.innerText || "").trim().length > 20) return true;
  for (const el of document.querySelectorAll("canvas,svg,img,video,picture")) if (visible(el)) return true;
  const bg = getComputedStyle(body).backgroundColor + getComputedStyle(document.documentElement).backgroundColor + getComputedStyle(body).backgroundImage;
  return /gradient|url\\(/.test(bg) || /rgb\\((?!255, 255, 255)/.test(bg);
})()`;

export async function snapshotPage(
  browser: Browser,
  html: string,
  { script = true, timeoutMs = SNAPSHOT_TIMEOUT_MS }: { script?: boolean; timeoutMs?: number } = {},
): Promise<SnapshotResult> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  let context: BrowserContext | null = null;
  const work = (async (): Promise<SnapshotResult> => {
    context = await browser.newContext({
      viewport: SNAPSHOT_VIEWPORT,
      deviceScaleFactor: SNAPSHOT_SCALE,
      javaScriptEnabled: script,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      locale: "ru-RU",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await context.addInitScript({ content: DISABLE_APIS });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route("**/*", (route) => {
      const request = route.request();
      if (request.url() === PAGE_URL && request.isNavigationRequest() && !request.frame().parentFrame())
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    try {
      await page.goto(PAGE_URL, { waitUntil: "load", timeout: Math.max(1_000, left() - 3_000) });
    } catch {
      // A page that never finishes loading is taken as it is.
    }
    // Charts animate in and fonts settle; a short, bounded pause.
    await page.waitForTimeout(Math.min(1_200, Math.max(0, left() - 2_000)));
    const painted = await page.evaluate(PAINTED).catch(() => false);
    if (!painted) return { blank: true };
    let image: Buffer | null = null;
    for (const quality of [72, 55, 40]) {
      image = await page.screenshot({
        type: "jpeg",
        quality,
        animations: "disabled",
        caret: "hide",
        timeout: Math.max(1_000, left()),
      });
      if (image.length <= SNAPSHOT_MAX_IMAGE) break;
    }
    if (!image || image.length > SNAPSHOT_MAX_IMAGE) return { error: "too_large" };
    return { image: image.toString("base64"), blank: false };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SnapshotResult>((resolve) => {
    timer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs + 1_000);
  });
  try {
    return await Promise.race([work.catch((): SnapshotResult => ({ error: "navigation_failed" })), expired]);
  } finally {
    clearTimeout(timer);
    const close = () => (context as BrowserContext | null)?.close().catch(() => {});
    await close();
    void work.finally(close).catch(() => {});
  }
}
