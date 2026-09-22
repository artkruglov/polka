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
  // A hand-written scan, linear in the page size: a regex that restarts at
  // every "<" is quadratic, and this runs on each view of a shared page.
  const text = html.toString("latin1");
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
    // A <head> inside a comment is not the head: inserting there would leave
    // the element inert and every link would navigate this frame instead.
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      if (end === -1) break;
      at = end + 2;
      continue;
    }
    if (
      text.slice(at + 1, at + 5).toLowerCase() === "head" &&
      /^[\s/>]$/.test(text[at + 5] ?? "")
    ) {
      const close = text.indexOf(">", at);
      if (close === -1) break;
      return Buffer.concat([
        html.subarray(0, close + 1),
        LINK_TARGET,
        html.subarray(close + 1),
      ]);
    }
  }
  return Buffer.concat([LINK_TARGET, html]);
}

type Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
};

// Browsers drop tabs and newlines anywhere in a URL and leading control
// characters and spaces, so "\tjava\nscript:" still runs.
const url = (value: string) =>
  value.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "");
const SCRIPT_URL = /^javascript:/i;
const REMOTE_URL = /^(?:https?:|[\\/]{2})/i;
const ACTIVE_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "object",
  "embed",
  "applet",
]);
const HIDDEN_TEXT = new Set(["script", "style", "template"]);

// A conservative heuristic, not a safety verdict: it only decides how honestly
// the page can be shown without a runtime. Isolation comes from the CSP above.
//
// It reads the document the way a browser does: parse5 resolves character
// references, so `http-equiv="&#x72;efresh"` is a refresh, while escaped text
// such as `&lt;script&gt;` stays text. One walk of the tree keeps the cost
// linear in the page size; this runs on the request thread for every save.
export function classifyHtml(source: string): HtmlProfile {
  // A page with a submission target, password field, script URL or remote
  // asset is kept as an unsupported source. CSP still protects the viewer, but
  // refusing a link avoids presenting an unsafe page as a trusted copy.
  let unsafe = false;
  let interactive = false;
  const text: string[] = [];
  const walk = (node: Node, hidden: boolean) => {
    if (unsafe) return;
    if (node.nodeName === "#text") {
      if (!hidden) text.push(node.value ?? "");
      return;
    }
    const tag = node.tagName?.toLowerCase();
    if (tag) {
      if (tag === "form") unsafe = true;
      if (ACTIVE_ELEMENTS.has(tag)) interactive = true;
      for (const { name, value } of node.attrs ?? []) {
        const attr = name.toLowerCase();
        const target = url(value);
        if (attr.startsWith("on")) interactive = true;
        if (SCRIPT_URL.test(target)) interactive = true;
        if (
          (attr.endsWith("src") || attr.endsWith("action")) &&
          (REMOTE_URL.test(target) || SCRIPT_URL.test(target))
        )
          unsafe = true;
        if (
          tag === "input" &&
          attr === "type" &&
          value.trim().toLowerCase() === "password"
        )
          unsafe = true;
        if (
          tag === "meta" &&
          attr === "http-equiv" &&
          value.trim().toLowerCase() === "refresh"
        )
          unsafe = true;
      }
    }
    const inner = hidden || (tag !== undefined && HIDDEN_TEXT.has(tag));
    for (const child of node.childNodes ?? []) walk(child, inner);
    if (node.content) walk(node.content, true);
  };
  walk(parse(source) as unknown as Node, false);
  if (unsafe) return "unsupported";
  if (!interactive) return "static";
  const visible = text.join(" ").replace(/\s+/g, " ").trim();
  return visible.length >= 80 ? "limited" : "unsupported";
}

// Shared with the web app, which decides whether pasted code is saved as HTML.
export { looksLikeHtml } from "../../packages/contracts/index.ts";
