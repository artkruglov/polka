/*
 * What an AI chat's code block or canvas is, and the page Полка saves from it.
 * Shared by the «На Полку» extension (extensions/chrome/src/shared/payload.ts)
 * and the server's ChatGPT import (apps/server/url-import/providers/chatgpt.ts),
 * so both read a source the same way. Pure: no DOM, no Node APIs.
 */

export type SourceKind =
  | "html"
  | "html-fragment"
  | "jsx"
  | "tsx"
  | "svg"
  | "markdown"
  | "text";

/** A saved page: an HTML document, or a React component for the runtime. */
export type SourceBody =
  | { html: string }
  | { component: string; componentLanguage: "jsx" | "tsx" };

const lang = (hint: string | null) =>
  (hint ?? "")
    .toLowerCase()
    .replace(/^language-/, "")
    .trim();

export function detectKind(source: string, hint: string | null): SourceKind {
  const text = source.replace(/^﻿/, "").trim();
  const language = lang(hint);
  if (/^(<!--[\s\S]*?-->\s*)*<!doctype\s+html/i.test(text)) return "html";
  if (/^<html[\s>]/i.test(text) || /<body[\s>]/i.test(text.slice(0, 20000)))
    return "html";
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text) || language === "svg")
    return "svg";
  if (["tsx", "typescript", "ts"].includes(language)) return "tsx";
  if (["jsx", "javascript", "js", "react"].includes(language))
    return reactLike(text) ? (typed(text) ? "tsx" : "jsx") : "text";
  if (reactLike(text)) return typed(text) ? "tsx" : "jsx";
  if (["html", "htm", "text/html"].includes(language)) return "html-fragment";
  if (/^<([a-z][a-z0-9-]*)[\s>][\s\S]*<\/\1>\s*$/i.test(text))
    return "html-fragment";
  if (["markdown", "md", "text/markdown"].includes(language)) return "markdown";
  if (/^#{1,6} \S/.test(text)) return "markdown";
  return "text";
}

/** A React component module: an export and JSX, or a React import. */
function reactLike(text: string) {
  const exported = /\bexport\s+default\b/.test(text);
  const importsReact = /\bfrom\s+["']react["']/.test(text);
  const jsx = /return\s*\(?\s*<[A-Za-z>]/.test(text) || /=>\s*\(?\s*<[A-Za-z>]/.test(text);
  return (exported && jsx) || (importsReact && (exported || jsx));
}

/** TypeScript-only syntax: interfaces, type aliases, typed props. */
function typed(text: string) {
  return (
    /^\s*(export\s+)?(interface|type)\s+[A-Z]\w*\s*(=|\{|<)/m.test(text) ||
    /\}\s*:\s*[A-Z]\w*(Props)?\s*\)/.test(text) ||
    /:\s*React\.(FC|ReactNode|ReactElement)\b/.test(text) ||
    /\buseState<[^>]+>\(/.test(text)
  );
}

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A minimal page around a body, as the extension and the CLI build it. */
export function simplePage(title: string, body: string, style = "") {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;padding:24px;font:16px/1.55 system-ui,sans-serif;color:#1b1f24;background:#fff}${style}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** The page's own <title>, when the source is an HTML document. */
export function htmlTitle(source: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source.slice(0, 50000));
  if (!match) return null;
  const title = match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return title || null;
}

const TEXT_STYLE = "pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 ui-monospace,monospace}";

/** The page for a source of a given kind: an HTML document as is, a component for the runtime, anything else wrapped. */
export function sourceBody(title: string, rawSource: string, language: string | null): SourceBody {
  const source = rawSource.replace(/^﻿/, "");
  const kind = detectKind(source, language);
  switch (kind) {
    case "html":
      return { html: source };
    case "jsx":
    case "tsx":
      return { component: source, componentLanguage: kind };
    case "html-fragment":
      return { html: simplePage(title, source) };
    case "svg":
      return {
        html: simplePage(title, source.replace(/^<\?xml[^>]*>\s*/i, ""), "svg{max-width:100%;height:auto}"),
      };
    case "markdown":
    case "text":
      // As the CLI does: the text as is, without markup (docs/PUBLISH_API.md).
      return { html: simplePage(title, `<pre>${escapeHtml(source)}</pre>`, TEXT_STYLE) };
  }
}
