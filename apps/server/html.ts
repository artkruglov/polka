import { decodeHTMLAttribute } from "entities";
import { parse } from "parse5";
import type { HtmlProfile } from "../../packages/contracts/index.ts";

// The only HTML view this build supports: an opaque-origin sandbox with no
// scripts, forms, plugins or network. Inline styles and data: images still work.
// Links open only in a new, unsandboxed tab (the view adds <base
// target="_blank">). There is no top navigation: a link with target=_top
// could otherwise replace the Полка tab with a look-alike page.
export const STATIC_HTML_SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox";
export const staticHtmlCsp = (frameAncestors: string) =>
  `sandbox ${STATIC_HTML_SANDBOX}; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}; child-src 'none'; worker-src 'none'; manifest-src 'none'`;
/** The static view on the app origin: only a single-domain install uses it. */
export const STATIC_HTML_CSP = staticHtmlCsp("'self'");

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

/**
 * CSP cannot stop WebRTC (Chrome ignores webrtc 'block'), so a page in the
 * interactive viewer could reach any STUN/TURN server and send out what the
 * reader types, and the reader's IP, despite connect-src 'none'. The viewer
 * puts this script before anything the page runs: it removes the WebRTC
 * constructors for good (non-configurable). A fresh realm cannot bring them
 * back: the sandbox makes any iframe a different opaque origin, workers are
 * refused by CSP, and popups by the sandbox.
 */
export const VIEWER_GUARD = `<script>(()=>{"use strict";for(const n of["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel","RTCIceTransport","RTCDtlsTransport","RTCSctpTransport","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCIceCandidate","RTCSessionDescription"])try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch{}})();</script>`;
const VIEWER_GUARD_BYTES = Buffer.from(VIEWER_GUARD);

/**
 * The guard goes first: after a leading doctype (so the page keeps standards
 * mode), otherwise at the very start. Not after <head>: a page may put a
 * script before its head, and that script would run first.
 */
export function withViewerGuard(html: Buffer): Buffer {
  const text = html.toString("latin1");
  let at = 0;
  // Skip a byte-order mark, whitespace and comments before a doctype.
  for (;;) {
    const rest = text.slice(at, at + 4);
    if (at === 0 && text.startsWith("\u00ef\u00bb\u00bf")) at = 3;
    else if (/^\s/.test(rest)) at += 1;
    else if (rest === "<!--") {
      const end = text.indexOf("-->", at + 4);
      if (end === -1) break;
      at = end + 3;
    } else break;
  }
  if (text.slice(at, at + 9).toLowerCase() === "<!doctype") {
    const end = text.indexOf(">", at);
    if (end !== -1)
      return Buffer.concat([
        html.subarray(0, end + 1),
        VIEWER_GUARD_BYTES,
        html.subarray(end + 1),
      ]);
  }
  return Buffer.concat([VIEWER_GUARD_BYTES, html]);
}

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

// ---------------------------------------------------------------------------
// External links in the static view (view-only, downloads stay byte-exact).
//
// Every <a>/<area> href that leaves the serving origin over http(s) becomes a
// link to Полка's signed "you are leaving" page. The scan follows the HTML
// tokenizer closely enough to find each href the browser would see (comments
// ending in "--!>", raw-text elements, quoted ">" in attributes, the first of
// duplicate attributes, character references) and changes nothing else: every
// other byte is copied as is. Where it has to approximate (foreign content,
// script escapes) it errs towards reading more markup, so a link is rewritten
// rather than missed.
//
// Linear in the page size: each byte is looked at a bounded number of times;
// an unterminated comment, tag or raw-text element ends the scan, as it ends
// markup in the browser. parse5's tree builder is not used here: deep nesting
// makes it quadratic, and this runs on each view of a shared page.

const RAW_TEXT_END: Record<string, RegExp> = Object.fromEntries(
  [
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
  ].map((name) => [name, new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi")]),
);
// "-->" and "--!>" both close a comment; "<!-->" and "<!--->" are empty ones.
const COMMENT_END = /--!?>/g;
const isSpace = (c: number) =>
  c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isAlpha = (c: number) => (c | 32) >= 97 && (c | 32) <= 122;

type Tag = {
  name: string;
  end: number;
  selfClosing: boolean;
  /** First href and xlink:href values: [start, end, quoted]. */
  links: [number, number, boolean][];
};

/** Reads a tag from its name to past ">"; null when the input ends inside it. */
function readTag(text: string, from: number): Tag | null {
  const n = text.length;
  let i = from;
  let c = 0;
  while (i < n && !isSpace((c = text.charCodeAt(i))) && c !== 47 && c !== 62)
    i++;
  if (i >= n) return null;
  const name = text.slice(from, i).toLowerCase();
  const links: Tag["links"] = [];
  const seen = new Set<string>();
  for (;;) {
    while (i < n && isSpace(text.charCodeAt(i))) i++;
    if (i >= n) return null;
    c = text.charCodeAt(i);
    if (c === 62) return { name, end: i + 1, selfClosing: false, links };
    if (c === 47) {
      if (text.charCodeAt(i + 1) === 62)
        return { name, end: i + 2, selfClosing: true, links };
      i++;
      continue;
    }
    // The first character of a name may be "=", as in the tokenizer.
    const nameStart = i++;
    while (
      i < n &&
      !isSpace((c = text.charCodeAt(i))) &&
      c !== 47 &&
      c !== 62 &&
      c !== 61
    )
      i++;
    const attr = text.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(text.charCodeAt(i))) i++;
    if (i >= n) return null;
    let value: [number, number, boolean] | null = null;
    if (text.charCodeAt(i) === 61) {
      i++;
      while (i < n && isSpace(text.charCodeAt(i))) i++;
      if (i >= n) return null;
      c = text.charCodeAt(i);
      if (c === 34 || c === 39) {
        const close = text.indexOf(c === 34 ? '"' : "'", i + 1);
        if (close === -1) return null;
        value = [i, close + 1, true];
        i = close + 1;
      } else if (c !== 62) {
        const start = i;
        while (i < n && !isSpace((c = text.charCodeAt(i))) && c !== 62) i++;
        if (i >= n) return null;
        value = [start, i, false];
      }
    }
    // A repeated attribute is dropped by the browser: only the first counts.
    if ((attr === "href" || attr === "xlink:href") && !seen.has(attr)) {
      seen.add(attr);
      if (value) links.push(value);
    }
  }
}

/** The absolute http(s) address an href leaves `base` for, or null. */
function externalTarget(value: string, base: URL) {
  let target: URL;
  try {
    // The URL parser drops tabs and newlines and trims C0 and spaces, as
    // browsers do, and resolves "//host" and "/\host" against the base.
    target = new URL(value, base);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  return target.origin === base.origin ? null : target.href;
}

/**
 * Rewrites the value of each external <a>/<area> href to `away(url)` (an
 * ASCII URL without quotes). `documentUrl` is where the page is served, the
 * base its relative links resolve against. Returns the input when nothing
 * changes.
 */
export function withAwayLinks(
  html: Buffer,
  documentUrl: string,
  away: (url: string) => string,
): Buffer {
  const text = html.toString("latin1");
  if (!/href/i.test(text)) return html;
  const base = new URL(documentUrl);
  const edits: [number, number, string][] = [];
  const signed = new Map<string, string>();
  const n = text.length;
  // Inside <svg>/<math> the raw-text names are ordinary elements.
  let foreign = 0;
  let at = 0;
  const skipTo = (from: number, char: string) => {
    const end = text.indexOf(char, from);
    return end === -1 ? -1 : end + 1;
  };
  while (at < n) {
    const lt = text.indexOf("<", at);
    if (lt === -1) break;
    const c = text.charCodeAt(lt + 1);
    if (c === 33) {
      // <!-- comment -->, or <!doctype>, <![CDATA[...]]> and other bogus
      // comments, which end at the first ">" (CDATA may end later: reading
      // on from there only reads more).
      if (text.startsWith("--", lt + 2)) {
        COMMENT_END.lastIndex = lt + 2;
        const m = COMMENT_END.exec(text);
        if (!m) break;
        at = m.index + m[0].length;
      } else if ((at = skipTo(lt + 2, ">")) === -1) break;
      continue;
    }
    if (c === 63) {
      if ((at = skipTo(lt + 2, ">")) === -1) break;
      continue;
    }
    if (c === 47) {
      const next = text.charCodeAt(lt + 2);
      if (isAlpha(next)) {
        const tag = readTag(text, lt + 2);
        if (!tag) break;
        if ((tag.name === "svg" || tag.name === "math") && foreign > 0)
          foreign--;
        at = tag.end;
      } else if (next === 62) at = lt + 3;
      else if ((at = skipTo(lt + 2, ">")) === -1) break;
      continue;
    }
    if (!isAlpha(c)) {
      at = lt + 1;
      continue;
    }
    const tag = readTag(text, lt + 1);
    // The input ends inside a tag: the browser drops it, and there is no
    // markup after it.
    if (!tag) break;
    at = tag.end;
    if (tag.name === "a" || tag.name === "area")
      for (const [start, end, quoted] of tag.links) {
        const raw = html
          .subarray(quoted ? start + 1 : start, quoted ? end - 1 : end)
          .toString("utf8");
        const target = externalTarget(decodeHTMLAttribute(raw), base);
        if (!target) continue;
        let href = signed.get(target);
        if (href === undefined) signed.set(target, (href = away(target)));
        edits.push([start, end, `"${href}"`]);
      }
    if (tag.name === "svg" || tag.name === "math") {
      if (!tag.selfClosing) foreign++;
    } else if (foreign === 0) {
      // Scripts never run in the static view, so <noscript> is markup.
      if (tag.name === "plaintext") break;
      const close = RAW_TEXT_END[tag.name];
      if (close) {
        close.lastIndex = at;
        const m = close.exec(text);
        if (!m) break;
        at = m.index;
      }
    }
  }
  if (!edits.length) return html;
  const parts: Buffer[] = [];
  let copied = 0;
  for (const [start, end, value] of edits) {
    parts.push(html.subarray(copied, start), Buffer.from(value, "latin1"));
    copied = end;
  }
  parts.push(html.subarray(copied));
  return Buffer.concat(parts);
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
