import {
  MAX_BYTES,
  looksLikeHtml,
} from "../../../../../packages/contracts/constants.ts";
import { clipTitle, htmlTitle } from "../../entities/artifact/html-title.ts";

/**
 * What pasted code becomes on the shelf. HTML is saved as a page; everything
 * else (Markdown, notes, component source) as UTF-8 text, shown as written.
 */
export type PastedCode = {
  kind: "html" | "text" | "component";
  mime: "text/html" | "text/plain";
  filename: string;
  title: string;
  size: number;
  tooLarge: boolean;
};

function textTitle(source: string) {
  const line = source
    .split("\n")
    .map((value) => value.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return line ? clipTitle(line) : "";
}

/**
 * A name for component source: its first heading's text, else the exported
 * component's name spaced out («SalesDashboard» → «Sales Dashboard»).
 */
export function componentTitle(source: string) {
  const heading = /<h[1-2]\b[^>]*>([^<{}]{2,})<\/h[1-2]>/i.exec(source)?.[1];
  if (heading?.trim()) return clipTitle(heading.replace(/\s+/g, " ").trim());
  const name =
    /export\s+default\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/.exec(source)?.[1] ??
    /export\s+default\s+([A-Z][A-Za-z0-9_]*)\s*;?\s*$/m.exec(source)?.[1] ??
    /(?:function|const)\s+([A-Z][A-Za-z0-9_]*)\s*(?:=|\()/.exec(source)?.[1];
  if (!name || name === "App") return "";
  return clipTitle(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " "));
}

/** React/JSX or module source: it looks like markup but is a program, not a page. */
const COMPONENT_SOURCE =
  /^\s*(?:import\s[^;\n]*from\s*["'][^"']+["']|import\s+["'][^"']+["']|export\s+default\b|["']use client["'])/m;

export function describePaste(source: string): PastedCode | null {
  if (!source.trim()) return null;
  const size = new TextEncoder().encode(source).length;
  const component =
    COMPONENT_SOURCE.test(source) && !/^\s*<(?:!doctype|html)\b/i.test(source);
  const kind = component ? "component" : looksLikeHtml(source) ? "html" : "text";
  return {
    kind,
    mime: kind === "html" ? "text/html" : "text/plain",
    filename: kind === "html" ? "code.html" : "code.txt",
    title:
      kind === "html"
        ? htmlTitle(source) || "Страница из чата"
        : kind === "text"
          ? textTitle(source) || "Заметка из чата"
          : componentTitle(source) || "Код компонента",
    size,
    tooLarge: size > MAX_BYTES,
  };
}
