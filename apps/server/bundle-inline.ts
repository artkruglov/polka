import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import postcss, { Input } from "postcss";
import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";
import { SaxesParser } from "saxes";
import {
  canonicalizeManifest,
  type BundleManifest,
} from "../../packages/contracts/bundle.ts";

import {
  BUILD_LIMITS,
  BUNDLE_BUILDER_VERSION as BUILDER_VERSION,
  type BuildFailureCategory,
  type SERVED_RUNTIME_PROFILES,
} from "./bundle-runtime-contract.ts";
const RUNTIME_PROFILE = "bundle-inline-experimental-v1" as const;
const MAX_OUTPUT_BYTES = BUILD_LIMITS.outputBytes;
const MAX_HTML_NODES = BUILD_LIMITS.htmlNodes;
const MAX_HTML_DEPTH = BUILD_LIMITS.htmlDepth;
const MAX_SVG_NODES = BUILD_LIMITS.svgNodes;
const MAX_SVG_DEPTH = BUILD_LIMITS.svgDepth;
export const XHTML = "http://www.w3.org/1999/xhtml";

export type BundleInlineResult =
  | {
      ok: true;
      sourceManifestSha256: string;
      builderVersion: typeof BUILDER_VERSION;
      runtimeProfile: (typeof SERVED_RUNTIME_PROFILES)[number];
      html: Buffer;
      sha256: string;
      size: number;
      consumedPaths: string[];
      /** What the builder left out of the page, for the owner. */
      warnings: string[];
    }
  // failed: the builder itself broke (not the page); the build may be retried.
  | {
      ok: false;
      reason: string;
      path?: string;
      failed?: boolean;
      category?: BuildFailureCategory;
    };

export type Node = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  namespaceURI?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
  parentNode?: Node | null;
  sourceCodeLocation?: { startLine: number; endLine: number } | null;
};

export const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

export function fail(
  reason: string,
  resourcePath?: string,
): BundleInlineResult {
  return { ok: false, reason, ...(resourcePath ? { path: resourcePath } : {}) };
}

export function attr(node: Node, name: string) {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

/** Inserts after the leading meta/title/base elements (and text) of head. */
export function insertIntoHead(head: Node, nodes: Node[]) {
  const children = (head.childNodes ??= []);
  let at = 0;
  while (
    at < children.length &&
    (!children[at].tagName ||
      ["meta", "title", "base"].includes(children[at].tagName!))
  )
    at++;
  for (const node of nodes) node.parentNode = head;
  children.splice(at, 0, ...nodes);
}

export function element(tag: string, text: string, parentNode: Node): Node {
  const node: Node = {
    nodeName: tag,
    tagName: tag,
    namespaceURI: XHTML,
    attrs: [],
    childNodes: [],
    parentNode,
  };
  node.childNodes!.push({ nodeName: "#text", value: text, parentNode: node });
  return node;
}

export function findElement(node: Node, tag: string): Node | null {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

/**
 * Browser APIs the sandbox refuses, replaced so a chat artifact keeps
 * working: storage lives in memory for the open page, network and the
 * artifact model API fail with a clear message instead of a SecurityError.
 * The viewer has no allow-modals (a cross-origin prompt() can imitate a
 * login dialog and a dialog loop freezes the reader's tab), so alert,
 * confirm and prompt show a note inside the page: confirm answers yes and
 * prompt returns its default (or null). A Tailwind v3 CDN page may assign
 * tailwind.config; the object exists so that assignment does not throw.
 */
export const PRELUDE = `(()=>{"use strict";
const memory=()=>{const m=new Map();return{get length(){return m.size},key(i){return[...m.keys()][i]??null},getItem(k){k=String(k);return m.has(k)?m.get(k):null},setItem(k,v){m.set(String(k),String(v))},removeItem(k){m.delete(String(k))},clear(){m.clear()}}};
for(const name of["localStorage","sessionStorage"])try{Object.defineProperty(window,name,{value:memory(),configurable:true})}catch{}
try{Object.defineProperty(document,"cookie",{get(){return""},set(){},configurable:true})}catch{}
const kept=new Map();
window.storage={async get(key){key=String(key);return kept.has(key)?{key,value:kept.get(key),shared:false}:null},async set(key,value){key=String(key);kept.set(key,String(value));return{key,value:String(value),shared:false}},async delete(key){key=String(key);return{key,deleted:kept.delete(key),shared:false}},async list(prefix){prefix=prefix==null?"":String(prefix);return{keys:[...kept.keys()].filter(k=>k.startsWith(prefix)),prefix,shared:false}}};
const offline=()=>Promise.reject(new TypeError("Полка: у страницы нет доступа к сети."));
window.fetch=offline;
window.claude={complete:()=>Promise.reject(new Error("Полка: вызовы модели из страницы недоступны."))};
const note=(text)=>{try{const box=document.createElement("div");box.setAttribute("role","status");box.style.cssText="position:fixed;left:50%;top:12px;transform:translateX(-50%);box-sizing:border-box;max-width:min(560px,calc(100vw - 24px));padding:10px 14px;background:#fffbe8;color:#3d2f00;border:1px solid #e6d27a;border-radius:8px;font:14px/1.45 system-ui,sans-serif;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:2147483647;cursor:pointer";box.textContent=String(text);box.onclick=()=>box.remove();(document.body||document.documentElement).appendChild(box);setTimeout(()=>box.remove(),6000)}catch{}};
window.alert=(message)=>{note(message===undefined?"":message)};
window.confirm=(message)=>{note(message===undefined?"":message);return true};
window.prompt=(message,value)=>{note(message===undefined?"":message);return value===undefined?null:String(value)};
if(!("tailwind"in window))window.tailwind={config:{}};
})();`;

function hasAttr(node: Node, name: string) {
  return node.attrs?.some((item) => item.name.toLowerCase() === name) ?? false;
}

function setAttr(node: Node, name: string, value: string) {
  const existing = node.attrs?.find((item) => item.name.toLowerCase() === name);
  if (existing) existing.value = value;
  else (node.attrs ??= []).push({ name, value });
}

/** A reference to another file of the bundle, as its normalized path. */
export function resolveLocal(reference: string | undefined, from: string) {
  if (
    !reference ||
    /^[a-z][a-z\d+.-]*:/i.test(reference) ||
    reference.startsWith("/") ||
    reference.startsWith("//") ||
    /[?#%\\\s\u0000-\u001f\u007f]/.test(reference)
  )
    return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), reference),
  );
  if (
    resolved === "." ||
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  )
    return null;
  return resolved;
}

function readResource(
  resourcePath: string,
  manifestFiles: Map<string, BundleManifest["files"][number]>,
  bytes: Map<string, Buffer>,
  consumed: Set<string>,
) {
  const file = manifestFiles.get(resourcePath);
  const value = bytes.get(resourcePath);
  if (!file || !value)
    return {
      error: fail("resource is missing from the verified bundle", resourcePath),
    };
  consumed.add(resourcePath);
  return { file, value };
}

const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "text",
  "tspan",
  "title",
  "desc",
]);

// Presentation only: none of these names a resource. Paint and clip
// references may point at an element of the same image (url(#id)).
const SVG_ATTRIBUTES = new Set([
  "xmlns",
  "xmlns:xlink",
  "xml:space",
  "version",
  "id",
  "class",
  "viewbox",
  "preserveaspectratio",
  "width",
  "height",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "clip-rule",
  "clip-path",
  "clippathunits",
  "mask",
  "maskunits",
  "maskcontentunits",
  "transform",
  "vector-effect",
  "shape-rendering",
  "paint-order",
  "color",
  "display",
  "visibility",
  "d",
  "pathlength",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "dx",
  "dy",
  "rotate",
  "textlength",
  "lengthadjust",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "text-decoration",
  "role",
  "aria-hidden",
  "aria-label",
  "focusable",
]);

const SVG_FRAGMENT_URL = /url\(\s*(["']?)#[A-Za-z_][\w.:-]*\1\s*\)/gi;
// The XML predefined entities and character references expand to one
// character each; any other entity needs a DTD, which is refused.
const XML_CHARACTER_REFERENCE =
  /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi;

function safeSvg(value: Buffer) {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return false;
  }
  if (!/^\s*<svg(?:\s|>)/i.test(source)) return false;
  if (
    /<!doctype|<!entity|<\s*(?:script|foreignObject|use|image|feImage|style|a)\b|\bon[a-z]+\s*=|(?:href|xlink:href|style)\s*=|url\s*\(|data:|&/i.test(
      source.replace(SVG_FRAGMENT_URL, "").replace(XML_CHARACTER_REFERENCE, ""),
    )
  )
    return false;
  let failed = false;
  let rootName = "";
  let rootUri = "";
  const xml = new SaxesParser({ xmlns: true, position: false });
  xml.on("error", () => {
    failed = true;
  });
  xml.on("doctype", () => {
    failed = true;
  });
  xml.on("opentag", (tag) => {
    if (!rootName) {
      rootName = tag.name;
      rootUri = tag.uri;
    }
  });
  try {
    xml.write(source).close();
  } catch {
    failed = true;
  }
  if (
    failed ||
    rootName.toLowerCase() !== "svg" ||
    rootUri !== "http://www.w3.org/2000/svg"
  )
    return false;
  const fragment = parseFragment(source) as unknown as Node;
  const roots = (fragment.childNodes ?? []).filter((child) => child.tagName);
  if (roots.length !== 1 || roots[0].tagName?.toLowerCase() !== "svg")
    return false;
  const stack = [{ node: roots[0], depth: 1 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > MAX_SVG_NODES || current.depth > MAX_SVG_DEPTH) return false;
    const node = current.node;
    if (node.tagName && !SVG_ELEMENTS.has(node.tagName.toLowerCase()))
      return false;
    for (const item of node.attrs ?? []) {
      // parse5 splits a foreign attribute into prefix and local name.
      const prefix = (item as { prefix?: string }).prefix;
      const name = (
        prefix ? `${prefix}:${item.name}` : item.name
      ).toLowerCase();
      // Values are checked decoded, so a character reference cannot hide
      // a resource function or a scheme.
      if (!SVG_ATTRIBUTES.has(name)) return false;
      if (
        !name.startsWith("xmlns") &&
        /url\s*\(|\b(?:javascript|vbscript|data|https?|file|blob):/i.test(
          item.value.replace(SVG_FRAGMENT_URL, ""),
        )
      )
        return false;
      if (name === "xmlns" && item.value !== "http://www.w3.org/2000/svg")
        return false;
      if (
        name === "xmlns:xlink" &&
        item.value !== "http://www.w3.org/1999/xlink"
      )
        return false;
    }
    for (const child of node.childNodes ?? [])
      stack.push({ node: child, depth: current.depth + 1 });
  }
  return true;
}

// postcss exposes its tokenizer only as an untyped module path.
const tokenizer = createRequire(import.meta.url)("postcss/lib/tokenize") as (
  input: Input,
) => {
  nextToken(): [string, string, ...unknown[]] | undefined;
  endOfFile(): boolean;
};

/**
 * CSS escapes are accepted where they cannot name a function or an at-rule:
 * inside strings and comments, and in selector/value identifiers that are not
 * followed by "(". An escaped or obfuscated url(, image-set( or @import, and
 * any escape inside parentheses, is refused before the url() rewrite runs.
 */
function cssEscapesSafe(source: string) {
  if (!source.includes("\\")) return true;
  const tokens: Array<[string, string]> = [];
  const stream = tokenizer(new Input(source));
  while (!stream.endOfFile()) {
    const token = stream.nextToken();
    if (token) tokens.push([token[0], token[1]]);
  }
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const [type, value] = tokens[index];
    if (type === "(") depth++;
    else if (type === ")") depth = Math.max(0, depth - 1);
    else if (type === "brackets" && value.includes("\\")) return false;
    else if (type === "at-word") {
      let end = index + 1;
      let escaped = value.includes("\\");
      for (; tokens[end]?.[0] === "word"; end++)
        if (tokens[end][1].includes("\\")) escaped = true;
      if (escaped) return false;
    } else if (type === "word") {
      let end = index;
      let escaped = false;
      for (; tokens[end]?.[0] === "word"; end++)
        if (tokens[end][1].includes("\\")) escaped = true;
      if (
        escaped &&
        (depth > 0 ||
          tokens[end]?.[0] === "(" ||
          tokens[end]?.[0] === "brackets")
      )
        return false;
      index = end - 1;
    }
  }
  return true;
}

const DATA_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const DATA_FONT_MIMES = ["font/woff2", "font/woff"];
const MAGIC: Record<string, (value: Buffer) => boolean> = {
  "image/png": (v) =>
    v.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  "image/jpeg": (v) => v.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  "image/gif": (v) => /^GIF8[79]a$/.test(v.subarray(0, 6).toString("latin1")),
  "image/webp": (v) =>
    v.subarray(0, 4).toString("latin1") === "RIFF" &&
    v.subarray(8, 12).toString("latin1") === "WEBP",
  "font/woff2": (v) => v.subarray(0, 4).toString("latin1") === "wOF2",
  "font/woff": (v) => v.subarray(0, 4).toString("latin1") === "wOFF",
  "image/svg+xml": (v) => safeSvg(v),
};

/**
 * A data: URI kept as is when it is canonical base64 of an allowlisted type
 * whose bytes match that type; SVG must pass the inert-image check. Returns
 * the normalized URI, or null when the reference is not such a URI.
 */
function safeDataUri(reference: string, allowed: string[]) {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    reference,
  );
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!allowed.includes(mime) && mime !== "image/svg+xml") return null;
  const value = Buffer.from(match[2], "base64");
  if (!value.length || value.toString("base64") !== match[2]) return null;
  if (!MAGIC[mime]?.(value)) return null;
  return `data:${mime};base64,${match[2]}`;
}

/** Fragment links and absolute web/mail links are markup, never resources. */
function safeLinkHref(value: string) {
  const trimmed = value.trim();
  if (/^#[^\s\u0000-\u001f\u007f]*$/.test(trimmed)) return true;
  if (/[\s\u0000-\u001f\u007f\\]/.test(trimmed)) return false;
  if (!/^(?:https?|mailto):/i.test(trimmed)) return false;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

const fragmentOnly = (value: string) =>
  /^#[A-Za-z_][\w.:-]*$/.test(value.trim());

/** An absolute web URL (or protocol-relative one) the viewer could not load. */
export const isRemote = (value: string | undefined) =>
  /^\s*(?:https?:)?\/\//i.test(value ?? "");

const hostOf = (value: string) => {
  try {
    return new URL(value.trim(), "https://invalid.invalid").hostname;
  } catch {
    return "";
  }
};

function withinHtmlBounds(root: Node) {
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > MAX_HTML_NODES || current.depth > MAX_HTML_DEPTH)
      return false;
    for (const child of current.node.childNodes ?? [])
      stack.push({ node: child, depth: current.depth + 1 });
  }
  return true;
}

/**
 * Called for a remote @import or url() the viewer's CSP would block anyway;
 * the rule or declaration is dropped and the owner is told. Without it such
 * a reference refuses the stylesheet.
 */
type DropRemote = (kind: "import" | "url", reference: string) => void;

function inlineCss(
  source: string,
  resourcePath: string,
  localAsset: (reference: string, from: string) => string,
  dropRemote?: DropRemote,
) {
  if (/<\/style/i.test(source) || !cssEscapesSafe(source))
    return {
      error: "stylesheet contains an unsafe raw-text or escape sequence",
    };
  try {
    const root = postcss.parse(source, { from: resourcePath });
    let error: string | undefined;
    root.walkAtRules((rule) => {
      if (rule.name.toLowerCase() !== "import") return;
      const reference = /^\s*(?:url\(\s*)?["']?([^"')\s]+)/i.exec(
        rule.params,
      )?.[1];
      if (dropRemote && isRemote(reference)) {
        dropRemote("import", reference!);
        rule.remove();
      } else error = "CSS @import is unsupported";
    });
    root.walkDecls((decl) => {
      if (/\b(?:image-set|cross-fade|element|paint|src)\s*\(/i.test(decl.value))
        error = "CSS resource functions are unsupported";
      // Only explicit local url() references and same-document fragments
      // (SVG paint, filter and clip references) are accepted. Protocols,
      // escapes and missing bundle resources are rejected by localAsset.
      const pattern =
        /\burl\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'"(]+))\s*\)/gi;
      const unmatched = decl.value.replace(pattern, "");
      if (/\burl\s*\(/i.test(unmatched))
        throw Error("unsupported CSS URL syntax");
      let remote = false;
      const value = decl.value.replace(
        pattern,
        (match, double, single, bare) => {
          const reference: string = double ?? single ?? bare;
          if (fragmentOnly(reference)) return `url("${reference.trim()}")`;
          if (dropRemote && isRemote(reference)) {
            dropRemote("url", reference);
            remote = true;
            return match;
          }
          return `url("${localAsset(reference, resourcePath)}")`;
        },
      );
      if (remote) decl.remove();
      else decl.value = value;
    });
    return error ? { error } : { css: root.toString() };
  } catch (error) {
    // Our own refusals name the reason; parser errors stay generic.
    return {
      error:
        error instanceof Error && error.name === "Error"
          ? error.message
          : "stylesheet is not valid CSS",
    };
  }
}

/**
 * Checks a stylesheet the builder generated itself (the runtime's Tailwind
 * output or compiled CSS imports) with the page CSS rules. It may reference
 * nothing but allowlisted data: images and fonts.
 */
export function checkGeneratedCss(
  source: string,
): { css: string; error?: undefined } | { error: string } {
  const result = inlineCss(source, "generated.css", (reference) => {
    const data = /^\s*data:/i.test(reference)
      ? safeDataUri(reference.trim(), [...DATA_IMAGE_MIMES, ...DATA_FONT_MIMES])
      : null;
    if (!data) throw Error("generated stylesheet references a resource");
    return data;
  });
  return result.error ? { error: result.error } : { css: result.css! };
}

function textNode(value: string, parentNode: Node): Node {
  return { nodeName: "#text", value, parentNode };
}

// Classic JavaScript per the HTML standard; any other type (except the
// module kinds below) is a data block the browser never runs.
const JAVASCRIPT_TYPES = new Set([
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
  ...["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"].map(
    (v) => `text/javascript${v}`,
  ),
]);
const MODULE_LIKE_TYPES = [
  "module",
  "importmap",
  "speculationrules",
  "text/babel",
  "text/jsx",
];

// <link> relations that only hint or label (loading, icons, metadata): the
// viewer has no network and no tab icon, so they are left out.
const HINT_RELS = new Set([
  "preconnect",
  "dns-prefetch",
  "preload",
  "prefetch",
  "modulepreload",
  "prerender",
  "icon",
  "shortcut",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "manifest",
  "canonical",
  "author",
  "license",
  "help",
  "me",
  "pingback",
  "search",
]);

const isFontHost = (host: string) =>
  [
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "fonts.bunny.net",
    "use.typekit.net",
    "rsms.me",
  ].includes(host);

export function buildInlineBundle(
  manifest: BundleManifest,
  sourceBytes: Map<string, Buffer>,
  { prelude = true }: { prelude?: boolean } = {},
): BundleInlineResult {
  let canonical: BundleManifest;
  try {
    canonical = canonicalizeManifest(manifest);
  } catch {
    return fail("manifest is not canonical and valid");
  }
  const sourceManifestSha256 = digest(JSON.stringify(canonical));
  const manifestFiles = new Map(
    canonical.files.map((file) => [file.path, file]),
  );
  for (const file of canonical.files) {
    const value = sourceBytes.get(file.path);
    if (!value) return fail("manifest file bytes are missing", file.path);
    if (value.length !== file.size)
      return fail("manifest file size does not match bytes", file.path);
    if (digest(value) !== file.sha256)
      return fail("manifest file hash does not match bytes", file.path);
  }
  const consumed = new Set<string>();
  const entry = readResource(
    canonical.entrypoint,
    manifestFiles,
    sourceBytes,
    consumed,
  );
  if (entry.error) return entry.error;
  let entryHtml: string;
  try {
    entryHtml = new TextDecoder("utf-8", { fatal: true }).decode(entry.value);
  } catch {
    return fail("entrypoint is not valid UTF-8", canonical.entrypoint);
  }
  if (
    (entryHtml.match(/<script\b/gi)?.length ?? 0) <
      (entryHtml.match(/<\/script\b/gi)?.length ?? 0) ||
    (entryHtml.match(/<style\b/gi)?.length ?? 0) <
      (entryHtml.match(/<\/style\b/gi)?.length ?? 0)
  )
    return fail(
      "entrypoint contains an unsafe raw-text closing sequence",
      manifest.entrypoint,
    );
  let document: Node;
  try {
    document = parse(entryHtml) as Node;
  } catch {
    return fail("entrypoint is not valid HTML", manifest.entrypoint);
  }
  if (!withinHtmlBounds(document))
    return fail("HTML exceeds node or depth limits", canonical.entrypoint);
  // What the viewer could never load (its CSP has no network) is left out
  // of the page rather than refusing it; the owner sees what was dropped.
  const warnings = new Set<string>();
  const removals: Node[] = [];
  let remoteImages = 0;
  const dropRemote: DropRemote = (kind, reference) => {
    const host = hostOf(reference);
    warnings.add(
      isFontHost(host)
        ? `веб-шрифты ${host} не подключены (просмотр без сети), используется запасной шрифт`
        : kind === "import"
          ? `внешняя таблица стилей ${host} не подключена (просмотр без сети)`
          : `внешние ресурсы в CSS (${host}) не подключены (просмотр без сети)`,
    );
  };
  let runsScripts = false;
  // Shared by CSS url() and <img> inlining.
  let cssExpansionBytes = 0;
  const localCssAsset = (reference: string, from: string) => {
    if (/^\s*data:/i.test(reference)) {
      const data = safeDataUri(reference, [
        ...DATA_IMAGE_MIMES,
        ...DATA_FONT_MIMES,
      ]);
      if (!data)
        throw Error("CSS data: URI is not an allowlisted image or font");
      cssExpansionBytes += data.length;
      if (cssExpansionBytes > MAX_OUTPUT_BYTES)
        throw Error("CSS resources exceed output limit");
      return data;
    }
    const resolved = resolveLocal(reference, from);
    if (!resolved)
      throw Error(
        `CSS resource "${reference.trim().slice(0, 120)}" is not a file of this page`,
      );
    const resource = readResource(
      resolved,
      manifestFiles,
      sourceBytes,
      consumed,
    );
    if (resource.error)
      throw Error(`CSS resource ${resolved} is missing from the bundle`);
    const mime = resource.file.mime;
    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/svg+xml",
        "font/woff2",
      ].includes(mime)
    )
      throw Error(`CSS resource ${resolved} has an unsupported type (${mime})`);
    if (mime === "image/svg+xml" && !safeSvg(resource.value))
      throw Error(`CSS SVG ${resolved} is not an inert allowlisted image`);
    if (
      mime === "font/woff2" &&
      resource.value.subarray(0, 4).toString() !== "wOF2"
    )
      throw Error(`${resolved} is not a valid WOFF2 font`);
    cssExpansionBytes += Math.ceil(resource.value.length / 3) * 4 + 80;
    if (cssExpansionBytes > MAX_OUTPUT_BYTES)
      throw Error("CSS resources exceed output limit");
    return `data:${mime};base64,${resource.value.toString("base64")}`;
  };
  const process = (
    node: Node,
    currentPath: string,
  ): BundleInlineResult | null => {
    const tag = node.tagName?.toLowerCase();
    const attrs = node.attrs ?? [];
    if (
      tag &&
      (attrs.some((item) => item.name.toLowerCase() === "srcset") ||
        [
          "template",
          "frame",
          "frameset",
          "iframe",
          "base",
          "object",
          "embed",
          "video",
          "audio",
          "source",
          "track",
          "picture",
          "image",
        ].includes(tag))
    )
      return fail(
        `<${tag}> (or srcset) is an unsupported HTML resource or container`,
        currentPath,
      );
    if (attrs.some((item) => /^on/i.test(item.name))) runsScripts = true;
    for (const item of attrs) {
      const name = item.name.toLowerCase();
      if (
        ![
          "src",
          "href",
          "xlink:href",
          "poster",
          "background",
          "action",
          "formaction",
        ].includes(name)
      )
        continue;
      const handled =
        (name === "src" && (tag === "img" || tag === "script")) ||
        (name === "href" && tag === "link") ||
        (name === "href" && tag === "a" && safeLinkHref(item.value)) ||
        ((name === "href" || name === "xlink:href") &&
          tag === "use" &&
          fragmentOnly(item.value));
      if (!handled)
        return fail(
          `<${tag} ${name}="${item.value.trim().slice(0, 80)}"> is an unhandled resource-bearing HTML attribute`,
          currentPath,
        );
    }
    if (tag === "meta" && /refresh/i.test(attr(node, "http-equiv") ?? ""))
      return fail("meta refresh is unsupported", currentPath);
    const inlineStyle = attrs.find(
      (item) => item.name.toLowerCase() === "style",
    );
    if (inlineStyle) {
      const css = inlineCss(
        `a{${inlineStyle.value}}`,
        currentPath,
        localCssAsset,
        dropRemote,
      );
      if (css.error) return fail(css.error, currentPath);
      const parsedStyle = postcss.parse(css.css!);
      inlineStyle.value =
        parsedStyle.first?.type === "rule"
          ? parsedStyle.first.nodes.map((n) => n.toString()).join(";")
          : "";
    }
    if (tag === "link") {
      const rel = (attr(node, "rel") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const href = attr(node, "href") ?? "";
      if (!rel.includes("stylesheet")) {
        if (!rel.length || !rel.every((item) => HINT_RELS.has(item)))
          return fail(
            `<link rel="${rel.join(" ")}"> is an unsupported link resource`,
            currentPath,
          );
        warnings.add(
          "подсказки загрузки и значки (<link rel=preconnect/icon/…>) не нужны просмотру и убраны",
        );
        removals.push(node);
        return null;
      }
      if (isRemote(href)) {
        dropRemote("import", href);
        removals.push(node);
        return null;
      }
      // A type/crossorigin/integrity/referrerpolicy on a local stylesheet
      // does not change how its rules apply once inlined.
      if (
        attrs.some(
          (item) =>
            ![
              "rel",
              "href",
              "type",
              "crossorigin",
              "integrity",
              "referrerpolicy",
            ].includes(item.name.toLowerCase()),
        ) ||
        !["", "text/css"].includes(
          (attr(node, "type") ?? "").trim().toLowerCase(),
        )
      )
        return fail("stylesheet link has unsupported attributes", currentPath);
      if (
        hasAttr(node, "media") ||
        hasAttr(node, "disabled") ||
        hasAttr(node, "title") ||
        rel.includes("alternate")
      )
        return fail(
          "stylesheet presentation semantics are unsupported",
          currentPath,
        );
      const resolved = resolveLocal(href, currentPath);
      if (!resolved)
        return fail(
          `stylesheet "${href.trim().slice(0, 120)}" is not a file of this page`,
          currentPath,
        );
      const resource = readResource(
        resolved,
        manifestFiles,
        sourceBytes,
        consumed,
      );
      if (resource.error) return resource.error;
      if (resource.file.mime !== "text/css")
        return fail("stylesheet has unsupported MIME", resolved);
      let cssSource: string;
      try {
        cssSource = new TextDecoder("utf-8", { fatal: true }).decode(
          resource.value,
        );
      } catch {
        return fail("stylesheet is not valid UTF-8", resolved);
      }
      const css = inlineCss(cssSource, resolved, localCssAsset, dropRemote);
      if (css.error) return fail(css.error, resolved);
      node.tagName = "style";
      node.nodeName = "style";
      node.attrs = [];
      node.childNodes = [textNode(css.css!, node)];
    } else if (tag === "style") {
      const css = inlineCss(
        (node.childNodes ?? []).map((child) => child.value ?? "").join(""),
        currentPath,
        localCssAsset,
        dropRemote,
      );
      if (css.error) return fail(css.error, currentPath);
      node.childNodes = [textNode(css.css!, node)];
    } else if (tag === "script") {
      const type = (attr(node, "type") ?? "").trim().toLowerCase();
      const source = attr(node, "src");
      const javascript = !type || JAVASCRIPT_TYPES.has(type);
      if (
        MODULE_LIKE_TYPES.includes(type) ||
        // Inline classic scripts ignore async/defer; a referenced one would
        // change execution order, so that stays refused.
        ((hasAttr(node, "async") || hasAttr(node, "defer")) &&
          hasAttr(node, "src"))
      )
        return fail(
          "module, importmap, non-JavaScript (e.g. text/babel) and referenced async or defer scripts are unsupported",
          currentPath,
        );
      if (hasAttr(node, "src") && !source)
        return fail("empty script source is unsupported", currentPath);
      if (hasAttr(node, "type") && !type)
        return fail("empty script type is unsupported", currentPath);
      // A data block (shader source, JSON) is inert text for the page's
      // own scripts; it may not name a file.
      if (!javascript && source)
        return fail(
          `script of type ${type} with a src is unsupported`,
          currentPath,
        );
      if (javascript) runsScripts = true;
      if (source) {
        const resolved = resolveLocal(source, currentPath);
        if (!resolved)
          return fail(
            isRemote(source) || /^[a-z][a-z\d+.-]*:/i.test(source.trim())
              ? `script ${source.trim().slice(0, 120)} needs the network; the viewer is offline`
              : `script "${source.trim().slice(0, 120)}" is not a file of this page`,
            currentPath,
          );
        const resource = readResource(
          resolved,
          manifestFiles,
          sourceBytes,
          consumed,
        );
        if (resource.error) return resource.error;
        if (resource.file.mime !== "text/javascript")
          return fail("script has unsupported MIME", resolved);
        let script: string;
        try {
          script = new TextDecoder("utf-8", { fatal: true }).decode(
            resource.value,
          );
        } catch {
          return fail("script is not valid UTF-8", resolved);
        }
        if (/<\/script/i.test(script))
          return fail("script contains a raw closing sequence", resolved);
        node.attrs = node.attrs?.filter(
          (item) => item.name.toLowerCase() !== "src",
        );
        node.childNodes = [textNode(script, node)];
      } else {
        const script = (node.childNodes ?? [])
          .map((child) => child.value ?? "")
          .join("");
        if (/<\/script/i.test(script))
          return fail("script contains a raw closing sequence", currentPath);
      }
    } else if (tag === "img" && /^\s*data:/i.test(attr(node, "src") ?? "")) {
      const data = safeDataUri(attr(node, "src")!.trim(), DATA_IMAGE_MIMES);
      if (!data)
        return fail("image data: URI is not an allowlisted image", currentPath);
      cssExpansionBytes += data.length;
      if (cssExpansionBytes > MAX_OUTPUT_BYTES)
        return fail("inlined HTML exceeds 8 MiB", currentPath);
      setAttr(node, "src", data);
    } else if (tag === "img" && isRemote(attr(node, "src"))) {
      // The image keeps its size and alt text; only the address goes.
      node.attrs = attrs.filter((item) => item.name.toLowerCase() !== "src");
      remoteImages++;
    } else if (tag === "img" && (attr(node, "src") ?? "").trim()) {
      const reference = attr(node, "src")!;
      const resolved = resolveLocal(reference, currentPath);
      if (!resolved)
        return fail(
          `image "${reference.trim().slice(0, 120)}" is not a file of this page`,
          currentPath,
        );
      const resource = readResource(
        resolved,
        manifestFiles,
        sourceBytes,
        consumed,
      );
      if (resource.error) return resource.error;
      if (
        !["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(
          resource.file.mime,
        )
      )
        return fail("image has unsupported MIME", resolved);
      if (resource.file.mime === "image/svg+xml" && !safeSvg(resource.value))
        return fail("SVG is not an inert allowlisted image", resolved);
      // Each <img> gets its own data: copy; charge it before allocating so a
      // repeated reference cannot amplify memory beyond the output limit.
      cssExpansionBytes += Math.ceil(resource.value.length / 3) * 4 + 80;
      if (cssExpansionBytes > MAX_OUTPUT_BYTES)
        return fail("inlined HTML exceeds 8 MiB", resolved);
      setAttr(
        node,
        "src",
        `data:${resource.file.mime};base64,${resource.value.toString("base64")}`,
      );
    }
    for (const child of node.childNodes ?? []) {
      const result = process(child, currentPath);
      if (result) return result;
    }
    return null;
  };
  const error = process(document, manifest.entrypoint);
  if (error) return error;
  for (const node of removals) {
    const siblings = node.parentNode?.childNodes;
    if (siblings) siblings.splice(siblings.indexOf(node), 1);
  }
  if (remoteImages)
    warnings.add(
      `внешние изображения (${remoteImages}) не показаны (просмотр без сети)`,
    );
  // Scripts get the same environment as runtime pages (storage in memory,
  // dialogs in the page) before any of them runs.
  if (prelude && runsScripts) {
    const head = findElement(document, "head");
    if (!head) return fail("entrypoint has no head", manifest.entrypoint);
    insertIntoHead(head, [element("script", PRELUDE, head)]);
  }
  const html = Buffer.from(
    serialize(document as unknown as DefaultTreeAdapterTypes.ParentNode),
  );
  if (html.length > MAX_OUTPUT_BYTES)
    return fail("inlined HTML exceeds 8 MiB", manifest.entrypoint);
  return {
    ok: true,
    sourceManifestSha256,
    builderVersion: BUILDER_VERSION,
    runtimeProfile: RUNTIME_PROFILE,
    html,
    sha256: digest(html),
    size: html.length,
    consumedPaths: [...consumed].sort(),
    warnings: [...warnings],
  };
}
