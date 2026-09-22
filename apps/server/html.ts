import { parse } from "parse5";
import type { HtmlProfile } from "../../packages/contracts/index.ts";

// The only HTML view this build supports: an opaque-origin sandbox with no
// scripts, forms, plugins or network. Inline styles and data: images still work.
// Links open only in a new, unsandboxed tab (the view adds <base
// target="_blank">). There is no top navigation: a link with target=_top
// could otherwise replace the Полка tab with a look-alike page.
export const STATIC_HTML_SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox";
export const STATIC_HTML_CSP = `sandbox ${STATIC_HTML_SANDBOX}; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; child-src 'none'; worker-src 'none'; manifest-src 'none'`;

/**
 * The interactive viewer's sandbox, shared by its CSP and the app's iframe.
 * allow-forms lets a page's own submit handler run (React onSubmit with
 * preventDefault); form-action 'none' still blocks any real submission or
 * navigation. No allow-modals (see PRELUDE in bundle-inline.ts), popups,
 * top navigation or same-origin.
 */
export const LIVE_VIEWER_SANDBOX = "allow-scripts allow-forms";
export const liveViewerCsp = (appOrigin: string) =>
  `sandbox ${LIVE_VIEWER_SANDBOX}; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}`;

// View-only transform (downloads stay byte-exact): a plain link would try to
// load the external site inside Полка's frame, which the app forbids, so every
// link in the static view opens in a new tab instead. base-uri 'none' still
// blocks any <base href>; this element carries only a target.
const LINK_TARGET = Buffer.from('<base target="_blank">');
export function withNewTabLinks(html: Buffer): Buffer {
  const text = html.toString("latin1");
  // A <head> inside a comment is not the head: inserting there would leave the
  // element inert and every link would navigate this frame instead.
  const token = /<!--[\s\S]*?(?:-->|$)|<head(?:\s[^>]*)?>/gi;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match[0].startsWith("<!--")) continue;
    const at = match.index + match[0].length;
    return Buffer.concat([
      html.subarray(0, at),
      LINK_TARGET,
      html.subarray(at),
    ]);
  }
  return Buffer.concat([LINK_TARGET, html]);
}

const interactive =
  /<script\b|<(?:iframe|frame|object|embed|applet|form)\b|<[^>]+\son[a-z]+\s*=|<[^>]+=\s*["']?\s*javascript:|<meta[^>]+http-equiv\s*=\s*["']?refresh/i;

// A page with a submission target, password field, script URL or remote asset
// is kept as an unsupported source in this build. CSP still protects the
// viewer, but refusing a link avoids presenting an unsafe page as a trusted
// copy on the Polka domain.
const unsafe =
  /<form\b|<input\b[^>]+type\s*=\s*["']?password\b|(?:src|action)\s*=\s*["']?(?:https?:|\/\/|javascript:)|<meta[^>]+http-equiv\s*=\s*["']?refresh/i;

/**
 * Every start tag of the document, rewritten with the attribute values a
 * browser actually sees. Browsers resolve character references before acting
 * on an attribute, so `http-equiv="&#x72;efresh"` is a refresh; the patterns
 * above read the raw source, so they read this rendering too. Escaped text
 * such as `&lt;script&gt;` stays text here and is not mistaken for a tag.
 */
function decodedTags(source: string): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    const children = (node as { childNodes?: unknown[] }).childNodes ?? [];
    for (const child of children) {
      const element = child as {
        tagName?: string;
        attrs?: { name: string; value: string }[];
      };
      if (element.tagName)
        out.push(
          `<${element.tagName}${(element.attrs ?? [])
            .map((a) => ` ${a.name}="${a.value.replace(/"/g, "&quot;")}"`)
            .join("")}>`,
        );
      walk(child);
    }
  };
  walk(parse(source));
  return out.join("");
}

// A conservative heuristic, not a safety verdict: it only decides how honestly
// the page can be shown without a runtime. Isolation comes from the CSP above.
export function classifyHtml(source: string): HtmlProfile {
  const tags = decodedTags(source);
  if (unsafe.test(source) || unsafe.test(tags)) return "unsupported";
  if (!interactive.test(source) && !interactive.test(tags)) return "static";
  const visible = source
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, " ")
    .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return visible.length >= 80 ? "limited" : "unsupported";
}

// Shared with the web app, which decides whether pasted code is saved as HTML.
export { looksLikeHtml } from "../../packages/contracts/index.ts";
