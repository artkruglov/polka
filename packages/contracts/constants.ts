// Zod-free copies of contract constants for the browser's initial chunk.
// index.ts pulls in zod; tests/unit.test.ts keeps both definitions equal.
export const MAX_BYTES = 5 * 1024 * 1024;
/**
 * A project (docs/specs/PROJECTS.md): one work of many linked pages. Each
 * file stays within MAX_BYTES; the whole project within these.
 */
export const PROJECT_MAX_FILES = 400;
export const PROJECT_MAX_BYTES = 48 * 1024 * 1024;
/**
 * Video in a project (docs/specs/PROJECT_VIDEO.md): a file of these types may
 * be up to PROJECT_VIDEO_MAX_FILE_BYTES and a project's videos together up to
 * PROJECT_VIDEO_MAX_BYTES, apart from the 48 MiB of pages, pictures and text.
 */
export const VIDEO_MIME = ["video/mp4", "video/webm"] as const;
export const isVideoMime = (mime: string) => (VIDEO_MIME as readonly string[]).includes(mime);
export const PROJECT_VIDEO_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const PROJECT_VIDEO_MAX_BYTES = 400 * 1024 * 1024;
/** Longest stored title; every path that names a work uses this one limit. */
export const MAX_TITLE = 160;
/** Around a found word in Artifact.snippet; never part of a work's text. */
export const SEARCH_MATCH_START = "";
export const SEARCH_MATCH_END = "";
export const MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/html",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
] as const;
export type UploadMime = (typeof MIME)[number];
/**
 * How a single-file work of each format is shown (docs/specs/SINGLE_FILE_FORMATS.md):
 *   page      HTML: the static or the interactive view
 *   reading   plain text, typeset by the app
 *   markdown  drawn by Полка's Markdown renderer on the viewer domain
 *   table     CSV as a table drawn on the viewer domain
 *   code      JSON as preformatted code on the viewer domain
 *   image     the picture itself
 *   pdf       PDF pages drawn by pdf.js on the viewer domain
 */
export type SingleFileView = "page" | "reading" | "markdown" | "table" | "code" | "image" | "pdf";
export type SingleFileFormat = {
  /** The word for a work of this format: cards, the reader, the moderator. */
  label: string;
  /** File name endings, lowercase, the first one canonical. */
  extensions: readonly string[];
  /** UTF-8 without NUL (the server refuses anything else). */
  text: boolean;
  view: SingleFileView;
};
/**
 * One row per format a user saves as one file (MIME): the upload form, the
 * server's checks, search, the agent context and the viewer read it. A new
 * format is one more row and a `view`.
 */
export const SINGLE_FILE_FORMATS: Record<UploadMime, SingleFileFormat> = {
  "image/png": { label: "Изображение", extensions: [".png"], text: false, view: "image" },
  "image/jpeg": { label: "Изображение", extensions: [".jpg", ".jpeg"], text: false, view: "image" },
  "image/webp": { label: "Изображение", extensions: [".webp"], text: false, view: "image" },
  "text/plain": { label: "Текст", extensions: [".txt"], text: true, view: "reading" },
  "text/html": { label: "Страница", extensions: [".html", ".htm"], text: true, view: "page" },
  "text/markdown": { label: "Документ", extensions: [".md", ".markdown"], text: true, view: "markdown" },
  "text/csv": { label: "Таблица", extensions: [".csv"], text: true, view: "table" },
  "application/json": { label: "JSON", extensions: [".json"], text: true, view: "code" },
  "application/pdf": { label: "PDF", extensions: [".pdf"], text: false, view: "pdf" },
};
/** A PDF document: its text is read by pdf.js on the server (apps/server/pdf-reader.ts). */
export const PDF_MIME = "application/pdf";
export const isPdfMime = (mime: string) => mime === PDF_MIME;
/** The format of a single-file work, or null (a link, a project's other files). */
export const singleFileFormat = (mime: string): SingleFileFormat | null =>
  Object.hasOwn(SINGLE_FILE_FORMATS, mime) ? SINGLE_FILE_FORMATS[mime as UploadMime] : null;
/**
 * A text format other than an HTML page: its bytes are its text, for search,
 * the content filter, the moderator and the agent (text/plain, Markdown, CSV, JSON).
 */
export const isTextMime = (mime: string) => {
  const format = singleFileFormat(mime);
  return !!format && format.text && format.view !== "page";
};
/**
 * A text format Полка draws as a page of its own on the viewer domain
 * (Markdown, CSV, JSON). A PDF also opens on the viewer domain, but as pages
 * of pdf.js (isPdfMime), not as a drawn page.
 */
export const isDrawnMime = (mime: string) => {
  const view = singleFileFormat(mime)?.view;
  return view === "markdown" || view === "table" || view === "code";
};
/** The format a file name says, by its extension; null when none matches. */
export function mimeForFilename(name: string): UploadMime | null {
  const lower = name.toLowerCase();
  for (const mime of MIME)
    if (SINGLE_FILE_FORMATS[mime].extensions.some((extension) => lower.endsWith(extension))) return mime;
  return null;
}
/**
 * A work that is a link kept as it is («Сохранить как ссылку»): its one file
 * is a small JSON document ({v:1,url,note}); the service, badge and default
 * title come from packages/contracts/link-providers.ts. Not a file format a
 * user uploads, so not in MIME.
 */
export const LINK_MIME = "application/vnd.polka.link+json";
export const MAX_LINK_NOTE = 2000;
export const MAX_LINK_URL = 2048;
/** A link worth keeping: http(s), a host, no credentials. Null otherwise. */
export function savedLinkUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > MAX_LINK_URL) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password)
    return null;
  return url;
}
/** Whether text is an HTML page rather than prose; the server refuses text/html without it. */
export const looksLikeHtml = (source: string) =>
  /<(?:!doctype\s+html|html|head|body|main|div|p|h[1-6]|table|section|article|ul|ol|style)\b/i.test(source);
export const REPORT_REASONS = [
  "phishing",
  "malware",
  "personal_data",
  "illegal",
  "other",
  "child_sexual",
  "intimate_nonconsensual",
  "threat_to_life",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** A single report of one of these pauses the link at once. */
export const URGENT_REPORT_REASONS: readonly ReportReason[] = [
  "child_sexual",
  "intimate_nonconsensual",
  "threat_to_life",
];
export const AGENT_SCOPES = [
  "context",
  "read",
  "source:read",
  "capture",
  "revise",
  "share",
  "manage",
  "sign_in",
  /** Agent sessions (docs/specs/AGENT_SESSIONS.md): upload and read one's own. */
  "sessions",
] as const;
/** «Для компаний» (/enterprise): the request form's choices and limits. */
export const ENTERPRISE_TEAM_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;
export type EnterpriseTeamSize = (typeof ENTERPRISE_TEAM_SIZES)[number];
export const ENTERPRISE_INTERESTS = ["cloud", "self-hosted", "commercial-license", "other"] as const;
export type EnterpriseInterest = (typeof ENTERPRISE_INTERESTS)[number];
export const ENTERPRISE_LIMITS = {
  name: 100,
  company: 200,
  email: 254,
  comment: 2000,
} as const;
