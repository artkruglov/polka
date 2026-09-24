/*
 * robots.txt as RFC 9309 reads it, for PolkaRenderer (/bot). Pure and without
 * dependencies: the app (a page's title for «Сохранить как ссылку») and the
 * renderer (every /render and /fetch, from the machine that makes the
 * request) use the same rules; the renderer image copies this file.
 */

export type RobotsRule = { allow: boolean; pattern: string };
/** unreachable: 5xx or no answer, which RFC 9309 treats as «disallow all» for now. */
export type Robots = { rules: RobotsRule[] } | { unreachable: true };

export const ROBOTS_TOKEN = "polkarenderer";

/** The rules of the groups for our token, or of «*» when none names us. */
export function parseRobots(text: string, token = ROBOTS_TOKEN): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
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
  let best: RobotsRule | null = null;
  for (const rule of robots.rules) {
    if (!matches(normalize(rule.pattern), path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow))
      best = rule;
  }
  return !best || best.allow;
}

/** How an HTTP answer for /robots.txt becomes rules (RFC 9309 § 2.3.1). */
export function robotsFromAnswer(status: number | null, body: string): Robots {
  if (status !== null && status >= 200 && status < 300) return { rules: parseRobots(body) };
  if (status !== null && status >= 400 && status < 500) return { rules: [] };
  return { unreachable: true };
}

/** A per-host cache: an hour for answers, five minutes for failures. */
export function robotsCache(fetchRobots: (origin: string) => Promise<Robots>, max = 5000) {
  const cache = new Map<string, { robots: Robots; expires: number }>();
  return {
    async get(url: URL, now = Date.now()): Promise<Robots> {
      const key = url.host.toLowerCase();
      const cached = cache.get(key);
      if (cached && cached.expires > now) return cached.robots;
      const robots = await fetchRobots(`https://${key}`);
      cache.set(key, { robots, expires: now + ("unreachable" in robots ? 5 * 60_000 : 60 * 60_000) });
      if (cache.size > max) cache.delete(cache.keys().next().value!);
      return robots;
    },
    clear: () => cache.clear(),
  };
}
