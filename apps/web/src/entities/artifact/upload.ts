import { MAX_BYTES, MIME, SINGLE_FILE_FORMATS, mimeForFilename } from "../../../../../packages/contracts/constants.ts";

/** One description of what an upload may be, for every save form. */
export const UPLOAD_ACCEPT = [
  ...MIME,
  ...MIME.flatMap((mime) => SINGLE_FILE_FORMATS[mime].extensions),
  // What some systems call a CSV or a Markdown file.
  "text/x-markdown",
  "application/vnd.ms-excel",
].join(",");
export const UPLOAD_FORMATS = "HTML, TXT, Markdown, CSV, JSON, PDF, PNG, JPEG или WebP · до 5 МБ";

// Browsers may report an empty, generic or system-specific type (Windows
// calls a .csv application/vnd.ms-excel, macOS a .md text/x-markdown or
// nothing). A known extension decides; the server still checks the bytes.
const fileMime = (file: File) => mimeForFilename(file.name) ?? file.type;

/** The bytes to send with the type the server expects. */
export const uploadBlob = (file: File) => new Blob([file], { type: fileMime(file) });

/** Why this content cannot be saved, or null when it can. */
export function uploadProblem(blob: Blob): string | null {
  if (!blob.size) return "Файл пустой.";
  if (!(MIME as readonly string[]).includes(blob.type))
    return "Этот тип файла не поддерживается. Подойдут HTML, TXT, Markdown, CSV, JSON, PDF, PNG, JPEG или WebP. ZIP пока не поддерживается.";
  if (blob.size > MAX_BYTES) return "Файл больше 5 МБ.";
  return null;
}

/** Pasted text formats: a page, a Markdown document or plain text. */
const PASTE_MIMES = ["text/html", "text/markdown", "text/csv", "application/json", "text/plain"] as const;
export type PasteMime = (typeof PASTE_MIMES)[number];

/**
 * What pasted text is saved as. A new version keeps its work's format (a page
 * stays a page); a new work is a page when the text is an HTML document or
 * markup, Markdown when it has a heading and other Markdown, else plain text.
 */
export function pastedMime(text: string, baseMime?: string): PasteMime {
  if (baseMime && (PASTE_MIMES as readonly string[]).includes(baseMime)) return baseMime as PasteMime;
  const head = text.trimStart().slice(0, 2000);
  if (/^(<!doctype html|<html[\s>])/i.test(head)) return "text/html";
  if (/<(body|head|main|section|article|div|table|style)[\s>]/i.test(head) && /<\/[a-z][\w-]*>/i.test(text))
    return "text/html";
  if (/^#{1,6} \S/m.test(head) && /(^\s*([-*+]|\d+\.) \S)|\*\*\S|\[[^\]]+\]\([^)]+\)|^```/m.test(text))
    return "text/markdown";
  return "text/plain";
}

/** The file name a paste is saved under: the title with the format's extension. */
export const pastedFilename = (title: string, mime: PasteMime) =>
  `${title.trim() || "Текст"}${SINGLE_FILE_FORMATS[mime].extensions[0]}`;
