/**
 * What search engines and agents' browsers may index. Only public,
 * non-personal pages: the landing, the agent guides, the feed and the legal
 * texts. Shared works (/s#…), shelves, the API and operator pages stay
 * noindex, as they always were.
 */
const INDEXABLE = new Set([
  "/",
  "/connect",
  "/llms.txt",
  "/openapi.json",
  "/enterprise",
  "/pricing",
  "/discover",
  "/privacy",
  "/terms",
]);

export function indexable(pathname: string) {
  return INDEXABLE.has(pathname) || /^\/discover\/[a-z0-9-]+$/.test(pathname);
}

export function robotsTxt(origin: string) {
  return [
    "User-agent: *",
    ...[...INDEXABLE].map((path) => `Allow: ${path === "/" ? "/$" : path}`),
    "Allow: /discover/",
    "Allow: /.well-known/agent-skills",
    "Disallow: /",
    "",
    `# Agents: ${origin}/llms.txt`,
    "",
  ].join("\n");
}
