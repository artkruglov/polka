import { fetchable } from "../../packages/contracts/link-providers.ts";
import { RENDER_MAX_HTML, type FetchResult, type RenderError } from "../../packages/renderer-contract.ts";
import { robotsAllow, robotsCache, robotsFromAnswer, type Robots } from "../../packages/robots.ts";
import { detectChallenge } from "./challenge.ts";
import { FetchFailure, type ProxiedGet } from "./proxied-fetch.ts";

/*
 * POST /fetch: a page whose content is already in its server-rendered HTML
 * (ChatGPT share and canvas pages, packages/contracts/link-providers.ts
 * «server-fetch») is read with one plain GET — no browser, one attempt.
 * robots.txt is read from here, the machine that makes the request.
 */

export type RobotsSource = { get(url: URL): Promise<Robots> };

/** robots.txt through the same egress, following up to three redirects. */
export function robotsVia(get: ProxiedGet): RobotsSource {
  return robotsCache(async (origin) => {
    let url = `${origin}/robots.txt`;
    for (let hop = 0; hop < 4; hop++) {
      let answer;
      try {
        answer = await get(url, { maxBytes: 512 * 1024, timeoutMs: 8_000, accept: "text/plain" });
      } catch (error) {
        // Too large: RFC 9309 reads the first 500 KiB; here it counts as unreachable.
        return robotsFromAnswer(null, "");
      }
      const location = answer.headers.location;
      if (answer.status >= 300 && answer.status < 400 && typeof location === "string") {
        // Whatever the site sends as a Location: an unparseable one is no robots.txt.
        try {
          url = new URL(location, url).href;
        } catch {
          return robotsFromAnswer(null, "");
        }
        continue;
      }
      return robotsFromAnswer(answer.status, answer.body.toString("utf8"));
    }
    return robotsFromAnswer(null, "");
  });
}

/** The robots.txt verdict for a page, as an error code or null (allowed). */
export async function robotsVerdict(robots: RobotsSource, url: URL): Promise<RenderError | null> {
  const answer = await robots.get(url);
  if ("unreachable" in answer) return "robots_unavailable";
  return robotsAllow(answer, url) ? null : "robots_disallowed";
}

/** Where a page's <title> is looked for: a real one is near the top. */
export const TITLE_SCAN_CHARS = 32 * 1024;
const isTagEnd = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32 || c === 47 || c === 62;
const startsWithCi = (text: string, at: number, lower: string) =>
  text.slice(at, at + lower.length).toLowerCase() === lower;

/**
 * The text of the first <title>…</title> (up to 300 characters, no markup)
 * in the first 32 KB, or "". A hand-written scan, linear in that prefix: a
 * regex like /<title[^>]*>…/ rescans the rest of the page from every
 * "<title", and this page is whatever the address serves.
 */
export function readTitle(source: string): string {
  const text = source.length > TITLE_SCAN_CHARS ? source.slice(0, TITLE_SCAN_CHARS) : source;
  for (let lt = text.indexOf("<"); lt !== -1; lt = text.indexOf("<", lt + 1)) {
    if (!startsWithCi(text, lt + 1, "title") || !isTagEnd(text.charCodeAt(lt + 6))) continue;
    const open = text.indexOf(">", lt + 6);
    if (open === -1) return "";
    const close = text.indexOf("<", open + 1);
    if (close === -1) return "";
    if (close - open - 1 <= 300 && startsWithCi(text, close, "</title>")) return text.slice(open + 1, close);
    lt = close - 1;
  }
  return "";
}

export async function fetchPage(
  get: ProxiedGet,
  robots: RobotsSource,
  input: string,
  { allow = fetchable }: { allow?: (url: string) => boolean } = {},
): Promise<FetchResult> {
  let url = new URL(input);
  if (!allow(url.href)) return { error: "not_allowed" };
  for (let hop = 0; hop < 4; hop++) {
    const verdict = await robotsVerdict(robots, url);
    if (verdict) return { error: verdict };
    let answer;
    try {
      answer = await get(url.href, { maxBytes: RENDER_MAX_HTML });
    } catch (error) {
      const reason = error instanceof FetchFailure ? error.reason : "network";
      return { error: reason === "too_large" ? "too_large" : reason === "timeout" ? "timeout" : "navigation_failed", detail: reason };
    }
    const header = (name: string) => {
      const value = answer.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const location = header("location");
    if (answer.status >= 300 && answer.status < 400 && location) {
      const next = new URL(location, url);
      // A redirect may only lead to another page of the same kind (a trailing slash, a locale).
      if (next.protocol !== "https:" || !allow(next.href)) return { error: "not_allowed", detail: "redirect" };
      url = next;
      continue;
    }
    const html = answer.body.toString("utf8");
    const title = readTitle(html);
    const headers = Object.fromEntries(Object.entries(answer.headers).map(([key, value]) => [key, String(Array.isArray(value) ? value[0] : value ?? "")]));
    const challenge = detectChallenge({ url: url.href, title, headers, status: answer.status, frameUrls: [], text: html.length > 5_000 ? "x".repeat(500) : "" });
    if (challenge) return { error: "source_blocked", detail: challenge };
    if (answer.status >= 400) return { error: "navigation_failed", detail: `http_${answer.status}` };
    if (!/^text\/html/i.test(header("content-type") ?? "")) return { error: "navigation_failed", detail: "not_html" };
    return { finalUrl: url.href, status: answer.status, html };
  }
  return { error: "navigation_failed", detail: "redirects" };
}
