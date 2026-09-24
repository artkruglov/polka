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
        url = new URL(location, url).href;
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
    const title = /<title[^>]*>([^<]{0,300})<\/title>/i.exec(html)?.[1] ?? "";
    const headers = Object.fromEntries(Object.entries(answer.headers).map(([key, value]) => [key, String(Array.isArray(value) ? value[0] : value ?? "")]));
    const challenge = detectChallenge({ url: url.href, title, headers, status: answer.status, frameUrls: [], text: html.length > 5_000 ? "x".repeat(500) : "" });
    if (challenge) return { error: "source_blocked", detail: challenge };
    if (answer.status >= 400) return { error: "navigation_failed", detail: `http_${answer.status}` };
    if (!/^text\/html/i.test(header("content-type") ?? "")) return { error: "navigation_failed", detail: "not_html" };
    return { finalUrl: url.href, status: answer.status, html };
  }
  return { error: "navigation_failed", detail: "redirects" };
}
