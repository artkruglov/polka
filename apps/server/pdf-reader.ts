// A PDF's text and links (docs/specs/SINGLE_FILE_FORMATS.md, «PDF»), read by
// pdf.js in the reader pool (worker-pool.ts, html-pool-worker.ts): the save
// checks that pdf.js can open the file, and its text feeds search, the
// content filter, the moderator, the cover and the agent. Its link
// annotations (URI actions) go through the same address checks as an HTML
// page's <a href> (phishing-signals.ts, SignalCollector.address and the
// content filter's link()).
//
// pdf.js parses hostile input, so it runs only in the pool, with a deadline
// and the worker's heap limit, and only as a parser: no worker thread of its
// own (its "worker" code runs in the pool worker, set as globalThis.pdfjsWorker),
// no eval (pdf.js 6 has no eval path left; its isEvalSupported option is
// gone with it), no fonts, no canvas, no images decoded,
// no network (the bytes are passed as data; no font, CMap or wasm URLs).
// A document's JavaScript is read as text for the content filter, never run.
import type { FilterResult } from "./content-filter/scanner.ts";
import { SignalCollector } from "./phishing-signals.ts";
import { SEARCH_TEXT_CHARS } from "./search-text.ts";
import { runInPool } from "./worker-pool.ts";

/** Pages read for text and links; the rest of a longer PDF is shown, not read. */
export const PDF_MAX_PAGES = 300;
/** Characters of text kept: search reads a quarter of it (search-text.ts), the moderator 96 000. */
export const PDF_TEXT_CHARS = SEARCH_TEXT_CHARS * 4;
/** Link annotations read; a page of thousands of links is a link farm either way. */
export const PDF_MAX_LINKS = 1_000;
/**
 * The reading's deadline: Markdown's 3 s (project-markdown.ts) plus loading
 * pdf.js in a worker the first time (~0.4 s).
 */
export const PDF_DEADLINE_MS = 5_000;

export type PdfReading =
  | {
      ok: true;
      /** Pages in the document; text and links come from the first PDF_MAX_PAGES. */
      pages: number;
      text: string;
      links: string[];
      /** It carries JavaScript actions (never run by Полка). */
      scripted: boolean;
      /** Phishing signals of its text and links, as a page's (phishing-signals.ts). */
      signals: string[];
      filter: FilterResult;
    }
  | { ok: false; reason: "invalid" | "password" | "unread" };

const UNREAD: PdfReading = { ok: false, reason: "unread" };

/** Bytes start like a PDF (a few bytes of junk before the header are allowed by readers; not here). */
export const looksLikePdf = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loaded: Promise<PdfJs> | null = null;
function pdfjs() {
  loaded ??= (async () => {
    // The parser runs here, in this thread: pdf.js uses globalThis.pdfjsWorker
    // instead of starting a worker of its own.
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return loaded;
}

/** Reads a PDF in this thread. Only the pool worker calls it (html-pool-worker.ts). */
export async function readPdf(data: Uint8Array): Promise<PdfReading> {
  if (!looksLikePdf(data)) return { ok: false, reason: "invalid" };
  const lib = await pdfjs();
  const task = lib.getDocument({
    data,
    enableXfa: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    return { ok: false, reason: (error as { name?: string })?.name === "PasswordException" ? "password" : "invalid" };
  }
  try {
    const collector = new SignalCollector();
    let scripted = false;
    let scriptChars = 0;
    // JavaScript of the document, a page or an annotation: read as code by
    // the content filter, never run. A Map in pdf.js 6 (an object before).
    const readScripts = (actions: unknown) => {
      if (!actions || typeof actions !== "object") return;
      const lists = actions instanceof Map ? [...actions.values()] : Object.values(actions);
      for (const list of lists)
        for (const script of Array.isArray(list) ? list : []) {
          scripted = true;
          if (scriptChars >= 256 * 1024) continue;
          const piece = String(script).slice(0, 64 * 1024);
          scriptChars += piece.length;
          collector.content.code(piece);
        }
    };
    const parts: string[] = [];
    let chars = 0;
    const links: string[] = [];
    const pages = Math.min(document.numPages, PDF_MAX_PAGES);
    for (let number = 1; number <= pages; number++) {
      let page;
      try {
        page = await document.getPage(number);
      } catch {
        continue;
      }
      if (chars < PDF_TEXT_CHARS) {
        try {
          const content = await page.getTextContent();
          let text = "";
          for (const item of content.items) if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
          text = text.trim();
          if (text) {
            const kept = text.slice(0, PDF_TEXT_CHARS - chars);
            parts.push(kept);
            chars += kept.length + 2;
            collector.context(kept);
          }
        } catch {
          // A page whose text cannot be read is still shown.
        }
      }
      try {
        for (const annotation of await page.getAnnotations({ intent: "display" })) {
          readScripts(annotation.actions);
          const uri = typeof annotation.unsafeUrl === "string" ? annotation.unsafeUrl : annotation.url;
          if (typeof uri !== "string" || !uri.trim() || links.length >= PDF_MAX_LINKS) continue;
          const value = uri.trim().slice(0, 2300);
          links.push(value);
          // As an HTML page's <a href> (html.ts, inspectHtml).
          collector.address(value);
          collector.content.link(value);
        }
        readScripts(await page.getJSActions());
      } catch {
        // Annotations that cannot be read add nothing.
      }
      page.cleanup();
    }
    try {
      readScripts(await document.getJSActions());
    } catch {
      // Unreadable actions are not run either.
    }

    const signals = collector.list();
    return {
      ok: true,
      pages: document.numPages,
      text: parts.join("\n\n").slice(0, PDF_TEXT_CHARS),
      links,
      scripted,
      signals,
      filter: { ...collector.content.result(signals), sensitiveInput: false },
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// A version never changes: one reading serves the save's two checks (the
// bytes, then the finalize) and the cover, search and agent reads after it.
const READINGS_KEPT = 16;
const readings = new Map<string, PdfReading>();

/**
 * readPdf in the reader pool, with a deadline. `key` (the file's SHA-256)
 * keeps the answer for the next read of the same bytes. A PDF that cannot be
 * read in time is "unread": saved, without text, counted as not checked.
 */
export async function readPdfBounded(bytes: Buffer, key?: string): Promise<PdfReading> {
  const kept = key ? readings.get(key) : undefined;
  if (kept) return kept;
  if (!looksLikePdf(bytes)) return { ok: false, reason: "invalid" };
  const reading = await runInPool<PdfReading>({ kind: "pdf", bytes: new Uint8Array(bytes) }, PDF_DEADLINE_MS, UNREAD);
  if (key && (reading.ok || reading.reason !== "unread")) {
    if (readings.size >= READINGS_KEPT) readings.delete(readings.keys().next().value!);
    readings.set(key, reading);
  }
  return reading;
}
