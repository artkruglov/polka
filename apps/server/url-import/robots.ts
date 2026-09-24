import {
  parseRobots,
  robotsAllow,
  robotsCache,
  robotsFromAnswer,
  type Robots,
} from "../../../packages/robots.ts";
import { RENDERER_USER_AGENT } from "../../../packages/renderer-contract.ts";
import { fetchPublic, ImportFetchError, type PublicResponse } from "./public-fetch.ts";

/*
 * robots.txt for requests the app itself makes as PolkaRenderer (a page's
 * title for «Сохранить как ссылку»). Pages the renderer opens or fetches are
 * checked by the renderer, from its own network (apps/renderer/server.ts).
 * Rules: packages/robots.ts (RFC 9309); cached per host for an hour.
 */

export { parseRobots, robotsAllow, type Robots };

type Fetch = (url: string) => Promise<PublicResponse>;
const defaultFetch: Fetch = (url) =>
  fetchPublic(url, { maxBytes: 512 * 1024, timeoutMs: 8_000, maxRedirects: 5, accept: "text/plain", userAgent: RENDERER_USER_AGENT });

async function answer(fetcher: Fetch, origin: string): Promise<Robots> {
  try {
    const response = await fetcher(`${origin}/robots.txt`);
    return robotsFromAnswer(200, response.bytes.toString("utf8"));
  } catch (error) {
    return robotsFromAnswer(error instanceof ImportFetchError ? (error.http?.status ?? null) : null, "");
  }
}

let fetcherInUse: Fetch = defaultFetch;
const cache = robotsCache((origin) => answer(fetcherInUse, origin));

export async function robotsFor(origin: URL, { fetcher = defaultFetch, now = Date.now() }: { fetcher?: Fetch; now?: number } = {}): Promise<Robots> {
  fetcherInUse = fetcher;
  return cache.get(origin, now);
}

/** For tests: forget cached answers. */
export function clearRobotsCache() {
  cache.clear();
}
