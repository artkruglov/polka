import {
  MAX_BYTES,
  looksLikeHtml,
} from "../../../../../packages/contracts/index.ts";

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

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function plain(fragment: string) {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
      const code =
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (title: string) =>
  title.length > 160 ? `${title.slice(0, 159).trimEnd()}…` : title;

function htmlTitle(source: string) {
  const head = source.slice(0, 256 * 1024);
  for (const pattern of [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]) {
    const found = pattern.exec(head);
    const title = found ? plain(found[1]) : "";
    if (title) return clip(title);
  }
  return "";
}

function textTitle(source: string) {
  const line = source
    .split("\n")
    .map((value) => value.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return line ? clip(line) : "";
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
          : "Код компонента",
    size,
    tooLarge: size > MAX_BYTES,
  };
}
