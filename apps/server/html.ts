import type { HtmlProfile } from "../../packages/contracts/index.ts";

// The only HTML view this build supports: an opaque-origin sandbox with no
// scripts, forms, plugins or network. Inline styles and data: images still work.
export const STATIC_HTML_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; child-src 'none'; worker-src 'none'; manifest-src 'none'; navigate-to 'none'";

const interactive =
  /<script\b|<(?:iframe|frame|object|embed|applet|form)\b|<[^>]+\son[a-z]+\s*=|<[^>]+=\s*["']?\s*javascript:|<meta[^>]+http-equiv\s*=\s*["']?refresh/i;

// A page with a submission target, password field, script URL or remote asset
// is kept as an unsupported source in this build. CSP still protects the
// viewer, but refusing a link avoids presenting an unsafe page as a trusted
// copy on the Polka domain.
const unsafe =
  /<form\b|<input\b[^>]+type\s*=\s*["']?password\b|(?:src|action)\s*=\s*["']?(?:https?:|\/\/|javascript:)|<meta[^>]+http-equiv\s*=\s*["']?refresh/i;

// A conservative heuristic, not a safety verdict: it only decides how honestly
// the page can be shown without a runtime. Isolation comes from the CSP above.
export function classifyHtml(source: string): HtmlProfile {
  if (unsafe.test(source)) return "unsupported";
  if (!interactive.test(source)) return "static";
  const visible = source
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, " ")
    .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return visible.length >= 80 ? "limited" : "unsupported";
}

export const looksLikeHtml = (source: string) =>
  /<(?:!doctype\s+html|html|head|body|main|div|p|h[1-6]|table|section|article|ul|ol|style)\b/i.test(
    source,
  );
