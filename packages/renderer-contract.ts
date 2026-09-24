import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/*
 * The app ↔ renderer contract (docs/specs/URL_IMPORT_SUPPORT.md, «Рендерер»).
 * The renderer may run on its own VM (deploy/renderer), so every request is
 * signed: HMAC-SHA256 with RENDERER_SECRET over the timestamp, method, path
 * and the body's SHA-256. A request older or newer than 60 s is refused.
 * No dependencies beyond node:crypto: the renderer image copies this file.
 */

/** The renderer's honest User-Agent; /bot describes it, robots.txt addresses it as PolkaRenderer. */
export const RENDERER_USER_AGENT = "PolkaRenderer/1.0 (+https://polochka.app/bot)";
/** The robots.txt product token (RFC 9309 matches it case-insensitively). */
export const RENDERER_TOKEN = "polkarenderer";
export const RENDER_SKEW_SECONDS = 60;
/** The largest document (and, separately, all frames together) the renderer returns. */
export const RENDER_MAX_HTML = 5 * 1024 * 1024;
export const RENDER_TIMEOUT_MS = 25_000;

export type RenderRequest = { url: string };
export type RenderError =
  | "source_blocked"
  | "robots_disallowed"
  | "robots_unavailable"
  | "timeout"
  | "not_allowed"
  | "navigation_failed"
  | "too_large"
  | "busy"
  | "bad_request"
  | "unauthorized";
export type RenderResult =
  | {
      finalUrl: string;
      title: string;
      html: string;
      frames: Array<{ url: string; html: string }>;
    }
  | { error: RenderError; detail?: string };
/** POST /fetch: one plain HTTP GET of a server-fetch page (no browser). */
export type FetchResult =
  | { finalUrl: string; status: number; html: string }
  | { error: RenderError; detail?: string };
export const FETCH_TIMEOUT_MS = 15_000;

const payload = (timestamp: string, method: string, path: string, body: string) =>
  `${timestamp}\n${method.toUpperCase()}\n${path}\n${createHash("sha256").update(body).digest("hex")}`;

export function signRenderRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    "x-polka-timestamp": timestamp,
    "x-polka-signature": createHmac("sha256", secret)
      .update(payload(timestamp, method, path, body))
      .digest("hex"),
  };
}

export function verifyRenderRequest(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): boolean {
  const timestamp = headers["x-polka-timestamp"];
  const signature = headers["x-polka-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string") return false;
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > RENDER_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret)
    .update(payload(timestamp, method, path, body))
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
