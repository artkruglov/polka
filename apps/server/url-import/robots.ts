import { RENDERER_TOKEN, RENDERER_USER_AGENT } from "../../../packages/renderer-contract.ts";
import { fetchPublic, ImportFetchError, type PublicResponse } from "./public-fetch.ts";

/*
 * robots.txt before the renderer opens a page (RFC 9309). The renderer is a
 * bot acting on a user's click, and it asks as PolkaRenderer: a site that
 * disallows it (or everyone) is not rendered, the user gets robots_disallowed.
 * Per RFC 9309: a missing robots.txt (4xx) allows everything; an unreachable
 * one (5xx, network) disallows everything for now. Answers are cached per
 * host for an hour, failures for five minutes.
 */

type Rule = { allow: boolean; pattern: string };
export type Robots = { rules: Rule[] } | { unreachable: true };

const HOUR = 60 * 60 * 1000;
const FAILURE = 5 * 60 * 1000;
const cache = new Map<string, { robots: Robots; expires: number }>();

/** The rules of the groups for our token, or of «*» when none names us. */
export function parseRobots(text: string, token = RENDERER_TOKEN): Rule[] {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== "allow" && key !== "disallow")) continue;
    // An empty Disallow allows everything; an empty Allow says nothing.
    if (!value) continue;
    current.rules.push({ allow: key === "allow", pattern: value });
  }
  const ours = groups.filter((g) => g.agents.some((agent) => agent === token));
  return (ours.length ? ours : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}

function matches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    "^" + body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return regex.test(path);
}

const normalize = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** RFC 9309: the longest matching rule wins; Allow wins a tie. */
export function robotsAllow(robots: Robots, url: URL): boolean {
  if ("unreachable" in robots) return false;
  const path = normalize(url.pathname + url.search);
  let best: Rule | null = null;
  for (const rule of robots.rules) {
    if (!matches(normalize(rule.pattern), path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow))
      best = rule;
  }
  return !best || best.allow;
}

type Fetch = (url: string) => Promise<PublicResponse>;
const defaultFetch: Fetch = (url) =>
  fetchPublic(url, { maxBytes: 512 * 1024, timeoutMs: 8_000, maxRedirects: 5, accept: "text/plain", userAgent: RENDERER_USER_AGENT });

export async function robotsFor(origin: URL, { fetcher = defaultFetch, now = Date.now() }: { fetcher?: Fetch; now?: number } = {}): Promise<Robots> {
  const key = origin.host.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.robots;
  let robots: Robots;
  let ttl = HOUR;
  try {
    const answer = await fetcher(`https://${key}/robots.txt`);
    robots = { rules: parseRobots(answer.bytes.toString("utf8")) };
  } catch (error) {
    const status = error instanceof ImportFetchError ? error.http?.status : undefined;
    if (status && status >= 400 && status < 500) robots = { rules: [] };
    else {
      robots = { unreachable: true };
      ttl = FAILURE;
    }
  }
  cache.set(key, { robots, expires: now + ttl });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return robots;
}

/** For tests: forget cached answers. */
export function clearRobotsCache() {
  cache.clear();
}
