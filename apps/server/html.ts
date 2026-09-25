import { decodeHTMLAttribute } from "entities";
import { parse } from "parse5";
import { SearchText, addScriptText } from "./search-text.ts";
import type { HtmlProfile } from "../../packages/contracts/index.ts";
import {
  fraudScore,
  scanText,
  type FilterResult,
} from "./content-filter/scanner.ts";
import {
  SCAN_INCOMPLETE,
  SECRET_AUTOCOMPLETE,
  SignalCollector,
  scanScript,
} from "./phishing-signals.ts";
import {
  sensitiveFields,
  type SensitiveInput,
} from "./content-filter/sensitive-input.ts";

// The only HTML view this build supports: an opaque-origin sandbox with no
// scripts, forms, plugins or network. Inline styles and data: images still work.
// Links open only in a new, unsandboxed tab (the view adds <base
// target="_blank">). There is no top navigation: a link with target=_top
// could otherwise replace the Полка tab with a look-alike page.
export const STATIC_HTML_SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox";
/**
 * With comments (docs/specs/COMMENTS.md) the static view runs exactly one
 * script of Полка's, the comment overlay: the sandbox gains allow-scripts
 * and script-src admits only this response's random nonce. The page's own
 * <script>, inline handlers and javascript: URLs stay blocked (no
 * 'unsafe-inline'), and so does the network, for the overlay too.
 */
export const STATIC_OVERLAY_SANDBOX = `allow-scripts ${STATIC_HTML_SANDBOX}`;
export const staticHtmlCsp = (frameAncestors: string, scriptNonce?: string) =>
  scriptNonce
    ? `sandbox ${STATIC_OVERLAY_SANDBOX}; default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}; child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'`
    : `sandbox ${STATIC_HTML_SANDBOX}; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}; child-src 'none'; worker-src 'none'; manifest-src 'none'`;
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
  return withLeadingMarkup(html, VIEWER_GUARD_BYTES);
}

/**
 * Viewer-added scripts go at the very start of the document, after a
 * leading doctype only. Nothing of the page comes before them, so no
 * unfinished tag of the page can swallow them (or their nonce).
 */
export function withLeadingMarkup(html: Buffer, markup: Buffer): Buffer {
  const text = html.toString("latin1");
  let at = 0;
  // Skip a byte-order mark, whitespace and comments before a doctype. A
  // comment ends where the tokenizer ends it ("<!-->", "<!--->", the first
  // "-->" or "--!>"): a scan that read past the real end could place the
  // markup inside the page's own unfinished tag. When unsure, the markup
  // goes at byte 0, before everything.
  for (;;) {
    const rest = text.slice(at, at + 4);
    if (at === 0 && text.startsWith("\u00ef\u00bb\u00bf")) at = 3;
    else if (/^\s/.test(rest)) at += 1;
    else if (rest === "<!--") {
      if (text.startsWith(">", at + 4)) at += 5;
      else if (text.startsWith("->", at + 4)) at += 6;
      else {
        COMMENT_END.lastIndex = at + 4;
        const end = COMMENT_END.exec(text);
        if (!end) return Buffer.concat([markup, html]);
        at = end.index + end[0].length;
      }
    } else break;
  }
  if (text.slice(at, at + 9).toLowerCase() === "<!doctype") {
    const end = text.indexOf(">", at);
    if (end !== -1)
      return Buffer.concat([
        html.subarray(0, end + 1),
        markup,
        html.subarray(end + 1),
      ]);
  }
  return Buffer.concat([markup, html]);
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

// Attributes whose value names or labels a field: the secret signal (a).
const FIELD_NAMING = new Set(["name", "id", "placeholder", "aria-label"]);
// Attributes whose value is shown or read out: brand and urgency (b, c).
const SHOWN_ATTRIBUTES = new Set([
  "placeholder",
  "aria-label",
  "alt",
  "title",
  "value",
]);

// Attributes that hold an address the page links to or loads.
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "data",
  "background",
  "xlink:href",
  "cite",
]);
// Text a reader cannot see: a link farm hides its links this way. Bounded
// alternatives, matched against one style attribute at a time.
const CONCEALING_STYLE =
  /display\s{0,3}:\s{0,3}none|visibility\s{0,3}:\s{0,3}hidden|font-size\s{0,3}:\s{0,3}0(?![.\d])|text-indent\s{0,3}:\s{0,3}-\d{3,}|(?:left|top)\s{0,3}:\s{0,3}-\d{3,}px|opacity\s{0,3}:\s{0,3}0(?![.\d])/i;

export type HtmlInspection = {
  profile: HtmlProfile;
  signals: string[];
  /** The content filter's findings (docs/specs/CONTENT_FILTER.md). */
  filter: FilterResult;
  /** With { sample: true }: the start of the visible text, for the model. */
  sample?: string;
  /** With { images: true }: a few data: images of the page. */
  images?: string[];
  /** With { scripts: true }: the page's scripts (bounded), for the code model. */
  scripts?: string[];
  /** With { text: true }: the visible text for search (search-text.ts). */
  text?: string;
  /**
   * Fields for a password, a card or a code (content-filter/sensitive-input.ts),
   * also kept in filter.sensitiveInput. Absent: the page was not read (UNREAD).
   */
  sensitive?: SensitiveInput;
};

// A conservative heuristic, not a safety verdict: it only decides how honestly
// the page can be shown without a runtime. Isolation comes from the CSP above.
//
// It reads the document the way a browser does: parse5 resolves character
// references, so `http-equiv="&#x72;efresh"` is a refresh, while escaped text
// such as `&lt;script&gt;` stays text. One walk of the tree keeps the cost
// linear in the page size; this runs on the request thread for every save.
//
// The same walk collects phishing signals (phishing-signals.ts): secret
// fields, brands and urgency, each read from one node or attribute at a time
// and from the strings of inline scripts. Never a regex over the raw source.
export function inspectHtml(
  source: string,
  collector = new SignalCollector(),
): HtmlInspection {
  // A page with a submission target, password field, script URL or remote
  // asset is kept as an unsupported source. CSP still protects the viewer, but
  // refusing a link avoids presenting an unsafe page as a trusted copy.
  let unsafe = false;
  let interactive = false;
  const text: string[] = [];
  // An explicit stack, not recursion: a deeply nested page would overflow
  // the call stack. The order of visits does not matter for these checks.
  // The walk goes on after the page is found unsafe: signals still count.
  // [node, inside script/style/template, parent tag, hidden by CSS]
  const stack: [Node, boolean, string | undefined, boolean][] = [
    [parse(source) as unknown as Node, false, undefined, false],
  ];
  const content = collector.content;
  const searchText = content.textWanted ? new SearchText() : null;
  while (stack.length) {
    const [node, hidden, parent, concealedAbove] = stack.pop()!;
    let concealed = concealedAbove;
    if (node.nodeName === "#text") {
      const value = node.value ?? "";
      if (parent === "script") scanScript(value, collector);
      else if (parent === "style") content.css(value);
      else {
        collector.context(value);
        if (parent === "label") collector.sensitive.label(value);
        if (concealed) content.hidden(value.trim().length);
      }
      if (!hidden && !unsafe) text.push(value);
      if (searchText && !concealed) {
        if (parent === "script") addScriptText(value, searchText, "cyrillic");
        else if (!hidden) searchText.add(value);
      }
      continue;
    }
    const tag = node.tagName?.toLowerCase();
    if (tag) {
      const attrs = node.attrs ?? [];
      for (const { name, value } of attrs) {
        const attr = name.toLowerCase();
        if (
          attr === "hidden" ||
          (attr === "style" && CONCEALING_STYLE.test(value))
        )
          concealed = true;
      }
      collector.sensitive.element(tag, attrs);
      for (const { name, value } of attrs) {
        const attr = name.toLowerCase();
        if (attr.startsWith("on")) {
          content.code(value);
          collector.sensitive.script(value);
        }
        if (tag === "a" && attr === "download")
          content.download(
            attrs.find((item) => item.name.toLowerCase() === "href")?.value ?? "",
            value,
          );
        if ((tag === "a" || tag === "area") && attr === "href") {
          content.link(value);
          if (concealed) content.hidden(0, true);
          if (SCRIPT_URL.test(url(value))) content.code(url(value).slice(11));
        } else if (URL_ATTRIBUTES.has(attr)) content.url(value);
        else if (attr === "srcset")
          for (const candidate of value.split(",").slice(0, 50))
            content.url(candidate.trim().split(/\s/)[0] ?? "");
        else if (attr === "style") content.css(value);
        else if (tag === "meta" && attr === "content") content.text(value);
        if (tag === "img" && attr === "src" && value.startsWith("data:"))
          content.image(value);
      }
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
        ) {
          unsafe = true;
          collector.add("secret:password-field");
        }
        if (
          tag === "meta" &&
          attr === "http-equiv" &&
          value.trim().toLowerCase() === "refresh"
        ) {
          unsafe = true;
          content.metaRefresh();
        }
        if (FIELD_NAMING.has(attr)) collector.secret(value);
        if (SHOWN_ATTRIBUTES.has(attr)) collector.context(value);
        if (
          attr === "autocomplete" &&
          value
            .toLowerCase()
            .split(/\s/)
            .some((token) => SECRET_AUTOCOMPLETE.has(token))
        )
          collector.add("secret:autocomplete");
      }
    }
    const inner = hidden || (tag !== undefined && HIDDEN_TEXT.has(tag));
    // Children in reverse so text is collected in document order.
    const children = node.childNodes ?? [];
    if (node.content) stack.push([node.content, true, tag, concealed]);
    for (let i = children.length - 1; i >= 0; i--)
      stack.push([children[i]!, inner, tag, concealed]);
  }
  const signals = collector.list();
  const sensitive = collector.sensitive.result();
  const findings = {
    signals,
    filter: { ...content.result(signals), ...sensitiveFields(sensitive) },
    sensitive,
    ...(content.sampleWanted ? { sample: content.sample() } : {}),
    ...(content.imagesWanted ? { images: content.images } : {}),
    ...(content.scriptsWanted ? { scripts: content.scripts } : {}),
    ...(searchText ? { text: searchText.value() } : {}),
  };
  if (unsafe) return { profile: "unsupported", ...findings };
  if (!interactive) return { profile: "static", ...findings };
  const visible = text.join(" ").replace(/\s+/g, " ").trim();
  return {
    profile: visible.length >= 80 ? "limited" : "unsupported",
    ...findings,
  };
}

export function classifyHtml(source: string): HtmlProfile {
  return inspectHtml(source).profile;
}

/**
 * inspectHtml off the request thread, with a deadline. parse5's tree builder
 * is quadratic on deeply nested markup (200 KB of nested <div> takes ~4 s,
 * the 5 MB upload limit ~40 min), and saving runs on the server's request
 * thread. Small pages are inspected inline; larger ones in a worker that is
 * terminated at the deadline. A page that cannot be read in time gets no
 * static link ("unsupported"; the owner still sees and downloads it) and the
 * signal SCAN_INCOMPLETE, so an interactive link to it waits for review
 * instead of escaping the phishing check by nesting.
 */
export const CLASSIFY_INLINE_BYTES = 16 * 1024;
export const CLASSIFY_DEADLINE_MS = 2_000;
const WORKER_START_MS = 10_000;
export const UNREAD: HtmlInspection = {
  profile: "unsupported",
  signals: [SCAN_INCOMPLETE],
  filter: { v: 1, hits: { fraud: fraudScore([SCAN_INCOMPLETE])! } },
};
export type InspectOptions = {
  images?: boolean;
  sample?: boolean;
  scripts?: boolean;
  text?: boolean;
};
/**
 * Runs one message through a fresh classify worker. The deadline bounds the
 * scan, not the worker's start: the worker says it is ready (tsx and the
 * classifier loaded) before it gets the source, and only then does the clock
 * start. On a loaded host loading alone can take seconds, and a normal page
 * must not come out «unsupported» with scan:incomplete for it. Startup has
 * its own, looser bound. Other readers with the same protocol (the shelf
 * cover reader, cover-facts-worker.ts) pass their own worker script.
 */
export async function inWorker<T>(
  message: object,
  deadlineMs: number,
  unread: T,
  script: URL = new URL("./html-classify-worker.mjs", import.meta.url),
): Promise<T> {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(script, {
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  try {
    return await new Promise<T>((resolve) => {
      let timer = setTimeout(() => resolve(unread), WORKER_START_MS);
      worker.on("message", (reply: T | { ready: true }) => {
        clearTimeout(timer);
        if (reply && typeof reply === "object" && "ready" in reply) {
          timer = setTimeout(() => resolve(unread), deadlineMs);
          worker.postMessage(message);
        } else resolve(reply as T);
      });
      worker.once("error", () => {
        clearTimeout(timer);
        resolve(unread);
      });
    });
  } finally {
    await worker.terminate();
  }
}

export async function inspectHtmlBounded(
  source: string,
  deadlineMs = CLASSIFY_DEADLINE_MS,
  options: InspectOptions = {},
): Promise<HtmlInspection> {
  if (source.length <= CLASSIFY_INLINE_BYTES)
    return inspectHtml(source, new SignalCollector(options));
  return inWorker({ source, options }, deadlineMs, UNREAD);
}

/**
 * The content filter over a plain text file, off the request thread for a
 * large one (the same worker and deadline as a page). A text that cannot be
 * read in time comes back with no findings and `incomplete`.
 */
export async function scanTextBounded(
  source: string,
  deadlineMs = CLASSIFY_DEADLINE_MS,
): Promise<FilterResult & { incomplete?: true }> {
  if (source.length <= CLASSIFY_INLINE_BYTES) return scanText(source);
  const unread = { v: 1 as const, hits: {}, incomplete: true as const };
  return inWorker<FilterResult & { incomplete?: true }>({ source, text: true }, deadlineMs, unread);
}

export async function classifyHtmlBounded(
  source: string,
  deadlineMs = CLASSIFY_DEADLINE_MS,
): Promise<HtmlProfile> {
  return (await inspectHtmlBounded(source, deadlineMs)).profile;
}

// Shared with the web app, which decides whether pasted code is saved as HTML.
export { looksLikeHtml } from "../../packages/contracts/index.ts";
