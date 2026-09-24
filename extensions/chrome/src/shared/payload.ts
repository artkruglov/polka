/*
 * From what was extracted to the body of POST /api/v1/publish
 * (docs/PUBLISH_API.md). Pure: no DOM, no chrome.*; unit-tested in
 * tests/extension-extract.test.ts.
 */

export type Provider = "claude" | "chatgpt";

/** How a source was obtained, best first. Shown in the result as a hint. */
export type Via =
  | "download"
  | "copy-button"
  | "frame-source"
  | "code-view"
  | "frame-rendered";

export type Extracted = {
  provider: Provider;
  title: string;
  source: string;
  /** A language hint from the page (class="language-tsx", data-language …). */
  language: string | null;
  via: Via;
};

export type SourceKind =
  | "html"
  | "html-fragment"
  | "jsx"
  | "tsx"
  | "svg"
  | "markdown"
  | "text";

export type PublishBody =
  | { key: string; title: string; html: string }
  | {
      key: string;
      title: string;
      component: string;
      componentLanguage: "jsx" | "tsx";
    };

const MAX_TITLE = 160;

const lang = (hint: string | null) =>
  (hint ?? "")
    .toLowerCase()
    .replace(/^language-/, "")
    .trim();

export function detectKind(source: string, hint: string | null): SourceKind {
  const text = source.replace(/^\ufeff/, "").trim();
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

function page(title: string, body: string, style = "") {
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

/** A tab or header title without the provider's suffix, within API limits. */
export function cleanTitle(value: string | null | undefined): string {
  const title = (value ?? "")
    .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—|\\·]\s*(Claude|ChatGPT)\s*$/i, "")
    .trim();
  if (/^(claude|chatgpt|new chat|новый чат)$/i.test(title)) return "";
  return title.slice(0, MAX_TITLE).trim();
}

export function titleFor(extracted: Extracted): string {
  return (
    cleanTitle(extracted.title) ||
    cleanTitle(htmlTitle(extracted.source)) ||
    (extracted.provider === "chatgpt" ? "Артефакт ChatGPT" : "Артефакт Claude")
  );
}

export function publishBody(extracted: Extracted, key: string): PublishBody {
  const title = titleFor(extracted);
  const source = extracted.source.replace(/^\ufeff/, "");
  const kind = detectKind(source, extracted.language);
  switch (kind) {
    case "html":
      return { key, title, html: source };
    case "jsx":
    case "tsx":
      return { key, title, component: source, componentLanguage: kind };
    case "html-fragment":
      return { key, title, html: page(title, source) };
    case "svg":
      return {
        key,
        title,
        html: page(
          title,
          source.replace(/^<\?xml[^>]*>\s*/i, ""),
          "svg{max-width:100%;height:auto}",
        ),
      };
    case "markdown":
    case "text":
      // As the CLI does: the text as is, without markup (docs/PUBLISH_API.md).
      return {
        key,
        title,
        html: page(
          title,
          `<pre>${escapeHtml(source)}</pre>`,
          "pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 ui-monospace,monospace}",
        ),
      };
  }
}

/** Candidates in order of trust; the first non-empty one wins. */
export function pickBest(candidates: (Extracted | null | undefined)[]) {
  const order: Via[] = ["download", "copy-button", "frame-source", "code-view", "frame-rendered"];
  const usable = candidates.filter(
    (item): item is Extracted => !!item && item.source.trim().length > 0,
  );
  usable.sort((a, b) => order.indexOf(a.via) - order.indexOf(b.via));
  return usable[0] ?? null;
}
