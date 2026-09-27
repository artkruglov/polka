/**
 * The web app's pages: the one list the server (apps/server/frontend.ts,
 * which serves the shell with 200 for these and 404 for anything else) and
 * the client router (apps/web/src/app/routing) both read.
 */
export const APP_PAGES = [
  "/",
  "/s",
  "/signup",
  "/signup/choose",
  "/signup/linked",
  "/claim",
  "/enter",
  "/signin",
  "/privacy",
  "/terms",
  "/bot",
  "/pricing",
  "/enterprise",
  "/start",
  "/away",
  "/mail-off",
  "/settings/agents",
  "/settings/company",
  "/bring",
  "/bring/receive",
  "/bookmarklet",
  "/landing",
  "/connections",
  "/trash",
  "/templates",
  "/library-invite",
  "/oauth/consent",
  "/moderation",
] as const;

const PAGES: ReadonlySet<string> = new Set(APP_PAGES);

/** A saved work's page; any other /works/… is not a page. */
export const WORK_PATH = /^\/works\/[a-f0-9-]{36}$/;
/** The editorial feed and its collections. */
export const DISCOVER_PATH = /^\/discover(?:\/[a-z0-9-]+)?$/;

/** Whether the app has a page at this path (no query, no fragment). */
export function isAppPage(path: string) {
  return PAGES.has(path) || WORK_PATH.test(path) || DISCOVER_PATH.test(path);
}

/** Prefixes that answer machines, never with the app shell. */
export const MACHINE_PREFIXES = ["/api", "/mcp", "/oauth", "/.well-known"] as const;

export const isMachinePath = (path: string) =>
  MACHINE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
