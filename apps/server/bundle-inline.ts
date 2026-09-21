import { createHash } from "node:crypto";
import path from "node:path";
import postcss from "postcss";
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

import { BUNDLE_BUILDER_VERSION as BUILDER_VERSION } from "./bundle-runtime-contract.ts";
const RUNTIME_PROFILE = "bundle-inline-experimental-v1" as const;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_HTML_NODES = 100_000;
const MAX_HTML_DEPTH = 256;
const MAX_SVG_NODES = 20_000;
const MAX_SVG_DEPTH = 256;
const XHTML = "http://www.w3.org/1999/xhtml";

export type BundleInlineResult =
  | {
      ok: true;
      sourceManifestSha256: string;
      builderVersion: typeof BUILDER_VERSION;
      runtimeProfile: typeof RUNTIME_PROFILE;
      html: Buffer;
      sha256: string;
      size: number;
      consumedPaths: string[];
    }
  | { ok: false; reason: string; path?: string };

type Node = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
  parentNode?: Node;
};

const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

function fail(reason: string, resourcePath?: string): BundleInlineResult {
  return { ok: false, reason, ...(resourcePath ? { path: resourcePath } : {}) };
}

function attr(node: Node, name: string) {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

function hasAttr(node: Node, name: string) {
  return node.attrs?.some((item) => item.name.toLowerCase() === name) ?? false;
}

function setAttr(node: Node, name: string, value: string) {
  const existing = node.attrs?.find((item) => item.name.toLowerCase() === name);
  if (existing) existing.value = value;
  else (node.attrs ??= []).push({ name, value });
}

function resolveLocal(reference: string | undefined, from: string) {
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

function safeSvg(value: Buffer) {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return false;
  }
  if (!/^\s*<svg(?:\s|>)/i.test(source)) return false;
  if (
    /<!doctype|<!entity|<\s*(?:script|foreignObject|use)\b|\bon[a-z]+\s*=|(?:href|xlink:href|style)\s*=|url\s*\(|data:|&/i.test(
      source,
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
  const allowed = new Set([
    "svg",
    "g",
    "path",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "rect",
  ]);
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
    if (node.tagName && !allowed.has(node.tagName.toLowerCase())) return false;
    for (const item of node.attrs ?? []) {
      const name = item.name.toLowerCase();
      if (
        ![
          "xmlns",
          "viewbox",
          "width",
          "height",
          "fill",
          "stroke",
          "stroke-width",
          "stroke-linecap",
          "stroke-linejoin",
          "opacity",
          "fill-opacity",
          "stroke-opacity",
          "d",
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
          "points",
        ].includes(name) ||
        /[&]/.test(item.value)
      )
        return false;
      if (name === "xmlns" && item.value !== "http://www.w3.org/2000/svg")
        return false;
    }
    for (const child of node.childNodes ?? [])
      stack.push({ node: child, depth: current.depth + 1 });
  }
  return true;
}

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

function inlineCss(source: string, resourcePath: string, localAsset: (reference: string, from: string) => string) {
  if (/<\/style/i.test(source) || /\\/.test(source))
    return {
      error: "stylesheet contains an unsafe raw-text or escape sequence",
    };
  try {
    const root = postcss.parse(source, { from: resourcePath });
    let error: string | undefined;
    root.walkAtRules((rule) => {
      if (rule.name.toLowerCase() === "import")
        error = "CSS @import is unsupported";
    });
    root.walkDecls((decl) => {
      if (
        /\b(?:image-set|cross-fade|element|paint|src)\s*\(/i.test(
          decl.value,
        )
      )
        error = "CSS resource functions are unsupported";
      // Only explicit local url() references are accepted. Protocols, escapes,
      // fragments and missing bundle resources are rejected by localAsset.
      const pattern = /\burl\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'"(]+))\s*\)/gi;
      const unmatched = decl.value.replace(pattern, "");
      if (/\burl\s*\(/i.test(unmatched)) throw Error("unsupported CSS URL syntax");
      decl.value = decl.value.replace(pattern, (_match, double, single, bare) =>
        `url("${localAsset(double ?? single ?? bare, resourcePath)}")`);
    });
    return error ? { error } : { css: root.toString() };
  } catch {
    return { error: "stylesheet is not valid CSS" };
  }
}

function textNode(value: string, parentNode: Node): Node {
  return { nodeName: "#text", value, parentNode };
}

export function buildInlineBundle(
  manifest: BundleManifest,
  sourceBytes: Map<string, Buffer>,
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
  // Shared by CSS url() and <img> inlining.
  let cssExpansionBytes = 0;
  const localCssAsset = (reference: string, from: string) => {
    const resolved = resolveLocal(reference, from);
    if (!resolved) throw Error("CSS resource is not local");
    const resource = readResource(resolved, manifestFiles, sourceBytes, consumed);
    if (resource.error) throw Error("CSS resource is missing");
    const mime = resource.file.mime;
    if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml", "font/woff2"].includes(mime))
      throw Error("CSS resource MIME is unsupported");
    if (mime === "image/svg+xml" && !safeSvg(resource.value)) throw Error("CSS SVG is not inert");
    if (mime === "font/woff2" && resource.value.subarray(0,4).toString() !== "wOF2") throw Error("Invalid WOFF2 font");
    cssExpansionBytes += Math.ceil(resource.value.length / 3) * 4 + 80;
    if (cssExpansionBytes > MAX_OUTPUT_BYTES) throw Error("CSS resources exceed output limit");
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
      return fail("unsupported HTML resource or container", currentPath);
    if (
      attrs.some((item) =>
        [
          "src",
          "href",
          "xlink:href",
          "poster",
          "background",
          "action",
          "formaction",
        ].includes(item.name.toLowerCase()),
      ) &&
      !(
        (tag === "img" &&
          attrs.some((item) => item.name.toLowerCase() === "src")) ||
        (tag === "script" &&
          attrs.some((item) => item.name.toLowerCase() === "src")) ||
        (tag === "link" &&
          attrs.some((item) => item.name.toLowerCase() === "href"))
      )
    )
      return fail("unhandled resource-bearing HTML attribute", currentPath);
    if (tag === "meta" && /refresh/i.test(attr(node, "http-equiv") ?? ""))
      return fail("meta refresh is unsupported", currentPath);
    const inlineStyle = attrs.find(
      (item) => item.name.toLowerCase() === "style",
    );
    if (inlineStyle) {
      const css = inlineCss(`a{${inlineStyle.value}}`, currentPath, localCssAsset);
      if (css.error) return fail(css.error, currentPath);
      const parsedStyle = postcss.parse(css.css!);
      inlineStyle.value = parsedStyle.first?.type === "rule" ? parsedStyle.first.nodes.map(n => n.toString()).join(";") : "";
    }
    if (tag === "link") {
      const rel = (attr(node, "rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet"))
        return fail("unsupported link resource", currentPath);
      if (
        attrs.some((item) => !["rel", "href"].includes(item.name.toLowerCase()))
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
      const resolved = resolveLocal(attr(node, "href"), currentPath);
      if (!resolved)
        return fail("stylesheet reference is not local", currentPath);
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
      const css = inlineCss(cssSource, resolved, localCssAsset);
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
      );
      if (css.error) return fail(css.error, currentPath);
      node.childNodes = [textNode(css.css!, node)];
    } else if (tag === "script") {
      const type = (attr(node, "type") ?? "").toLowerCase();
      if (
        ["module", "importmap"].includes(type) ||
        (type &&
          ![
            "text/javascript",
            "application/javascript",
            "application/ecmascript",
            "text/ecmascript",
          ].includes(type)) ||
        hasAttr(node, "async") ||
        hasAttr(node, "defer")
      )
        return fail(
          "module, importmap, async, and defer scripts are unsupported",
          currentPath,
        );
      if (hasAttr(node, "src") && !attr(node, "src"))
        return fail("empty script source is unsupported", currentPath);
      if (hasAttr(node, "type") && !attr(node, "type"))
        return fail("empty script type is unsupported", currentPath);
      const source = attr(node, "src");
      if (source) {
        const resolved = resolveLocal(source, currentPath);
        if (!resolved)
          return fail("script reference is not local", currentPath);
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
    } else if (tag === "img") {
      const resolved = resolveLocal(attr(node, "src"), currentPath);
      if (!resolved) return fail("image reference is not local", currentPath);
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
  };
}
