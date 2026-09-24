/*
 * The one table of link sources Полка recognises (docs/specs/URL_IMPORT_SUPPORT.md,
 * docs/research/HEADLESS_PUBLIC_LINKS.md). Server, web and the renderer read it,
 * so «which links the server may open» cannot drift between them. No
 * dependencies: the renderer image copies this file as it is.
 *
 * Each source has one route:
 * - extension: never opened by Полка's servers. The provider's terms forbid
 *   automated extraction (Claude, ChatGPT, v0, Perplexity) or robots.txt
 *   closes the path (AI Studio apps). The user's own browser (the «На Полку»
 *   extension), an agent over MCP, or a downloaded file brings the content.
 * - server-api: read through the provider's official API (GitHub Gist).
 * - server-render: a public site whose HTML is an empty SPA shell; the
 *   isolated renderer opens it once, after robots.txt allows it, and saves a
 *   DOM snapshot. Only these hosts: never «any URL into a browser».
 * - html: any other public HTTPS page, downloaded without running its code.
 */

export type LinkRoute = "extension" | "server-api" | "server-render" | "html";
export type LinkProviderId =
  | "claude"
  | "chatgpt"
  | "v0"
  | "perplexity"
  | "aistudio"
  | "gemini"
  | "gist"
  | "lovable"
  | "bolt"
  | "replit"
  | "github-pages";

export type LinkProvider = {
  id: LinkProviderId;
  /** The service's name as people say it. */
  name: string;
  route: LinkRoute;
  /** The badge shown for the service: letters on a colour, no brand logo. */
  mark: string;
  color: string;
  /** Exact hosts (lower case, no www.). */
  hosts: readonly string[];
  /** Any subdomain of these (".lovable.app" matches "x.lovable.app", not "lovable.app"). */
  suffixes?: readonly string[];
  /** Paths of public share links. A matching host with another path is a page behind a login. */
  publicPath?: RegExp;
  /** The default title of a link saved as a bookmark. */
  title: (path: string, host: string) => string;
};

const byPath =
  (entries: Array<[RegExp, string]>, fallback: string) => (path: string) =>
    entries.find(([pattern]) => pattern.test(path))?.[1] ?? fallback;
const hostTitle = (_path: string, host: string) => host;

export const LINK_PROVIDERS: readonly LinkProvider[] = [
  {
    id: "claude",
    name: "Claude",
    route: "extension",
    mark: "Cl",
    color: "#c96442",
    hosts: ["claude.ai", "claude.site"],
    suffixes: [".claude.site"],
    publicPath: /^\/(?:artifact|public\/artifacts|share|code\/artifact)\/[^/]+|^\/artifacts?\//,
    title: byPath([[/^\/share\//, "Чат Claude"]], "Артефакт Claude"),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    route: "extension",
    mark: "GP",
    color: "#10a37f",
    hosts: ["chatgpt.com", "chat.openai.com"],
    publicPath: /^\/(?:share|canvas\/shared)\/[^/]+/,
    title: byPath([[/^\/canvas\//, "Canvas ChatGPT"]], "Чат ChatGPT"),
  },
  {
    id: "v0",
    name: "v0",
    route: "extension",
    mark: "v0",
    color: "#111111",
    hosts: ["v0.app", "v0.dev"],
    title: () => "Чат v0",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    route: "extension",
    mark: "Px",
    color: "#1f6f78",
    hosts: ["perplexity.ai"],
    title: () => "Страница Perplexity",
  },
  {
    id: "aistudio",
    name: "Google AI Studio",
    route: "extension",
    mark: "AI",
    color: "#3367d6",
    hosts: ["aistudio.google.com"],
    title: () => "Приложение AI Studio",
  },
  {
    id: "gemini",
    name: "Gemini",
    route: "server-render",
    mark: "Ge",
    color: "#4f6bed",
    hosts: ["gemini.google.com", "g.co"],
    publicPath: /^\/(?:gemini\/)?share\/[A-Za-z0-9_-]+\/?$/,
    title: () => "Чат Gemini",
  },
  {
    id: "gist",
    name: "GitHub Gist",
    route: "server-api",
    mark: "Gi",
    color: "#24292f",
    hosts: ["gist.github.com", "gistpreview.github.io"],
    title: () => "Gist",
  },
  {
    id: "lovable",
    name: "Lovable",
    route: "server-render",
    mark: "Lo",
    color: "#e0457b",
    hosts: [],
    suffixes: [".lovable.app"],
    title: hostTitle,
  },
  {
    id: "bolt",
    name: "Bolt",
    route: "server-render",
    mark: "Bo",
    color: "#1b64f2",
    hosts: [],
    suffixes: [".bolt.host"],
    title: hostTitle,
  },
  {
    id: "replit",
    name: "Replit",
    route: "server-render",
    mark: "Re",
    color: "#f26207",
    hosts: [],
    suffixes: [".replit.app"],
    title: hostTitle,
  },
  {
    id: "github-pages",
    name: "GitHub Pages",
    route: "server-render",
    mark: "GH",
    color: "#24292f",
    hosts: [],
    suffixes: [".github.io"],
    title: hostTitle,
  },
];

export type LinkMatch = {
  url: URL;
  /** Lower case, without www. */
  host: string;
  provider: LinkProvider | null;
  /** html for an unknown host; the provider's route otherwise. */
  route: LinkRoute;
  /** A known provider's host with a path that is not a public share link. */
  closed: boolean;
};

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, "");

/** Which provider a link belongs to and how Полка may bring it. Null: not an https URL. */
export function matchLink(input: string | URL): LinkMatch | null {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input.trim()) : new URL(input.href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = hostOf(url);
  // Exact hosts win over suffixes: gistpreview.github.io is a gist, not a GitHub Pages site.
  const provider =
    LINK_PROVIDERS.find((p) => p.hosts.includes(host)) ??
    LINK_PROVIDERS.find((p) => p.suffixes?.some((s) => host.endsWith(s) && host.length > s.length)) ??
    null;
  if (!provider) return { url, host, provider: null, route: "html", closed: false };
  const closed = !!provider.publicPath && !provider.publicPath.test(url.pathname);
  // g.co is a Google short-link host: only its Gemini share path belongs to Gemini.
  if (host === "g.co" && closed) return { url, host, provider: null, route: "html", closed: false };
  return { url, host, provider, route: provider.route, closed };
}

/** Hosts the renderer may open at all, whatever redirects lead there. */
export function renderable(input: string | URL): boolean {
  const match = matchLink(input);
  return !!match && match.route === "server-render" && !match.closed;
}

/** A bookmark's default title: «Артефакт Claude», «Чат ChatGPT», or the host. */
export function defaultLinkTitle(input: string | URL): string {
  const match = matchLink(input);
  if (!match) return "Ссылка";
  return match.provider ? match.provider.title(match.url.pathname, match.host) : match.host;
}
