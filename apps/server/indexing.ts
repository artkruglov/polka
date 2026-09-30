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
  // What PolkaRenderer is: its User-Agent points here.
  "/bot",
]);

export function indexable(pathname: string) {
  return INDEXABLE.has(pathname) || /^\/discover\/[a-z0-9-]+$/.test(pathname);
}

/** The pages of the sitemap: HTML pages a person reads, not the machine files. */
const SITEMAP_PAGES = ["/", "/connect", "/discover", "/enterprise", "/pricing", "/privacy", "/terms"];

/** sitemap.xml: the public pages and the feed's materials (by slug). */
export function sitemapXml(origin: string, slugs: string[]) {
  const urls = [...SITEMAP_PAGES, ...slugs.filter((slug) => /^[a-z0-9-]+$/.test(slug)).map((slug) => `/discover/${slug}`)];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((path) => `  <url><loc>${origin}${path === "/" ? "/" : path}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

export function robotsTxt(origin: string) {
  return [
    "User-agent: *",
    ...[...INDEXABLE].map((path) => `Allow: ${path === "/" ? "/$" : path}`),
    "Allow: /discover/",
    "Allow: /.well-known/agent-skills",
    "Disallow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    `# Agents: ${origin}/llms.txt`,
    "",
  ].join("\n");
}
