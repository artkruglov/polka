// A PDF work on the viewer domain (docs/specs/SINGLE_FILE_FORMATS.md, «PDF»):
// a page of Полка's with the file embedded as a data block and pdf.js, served
// from the viewer's own origin (never a CDN), drawing it page by page.
//
// pdf.js runs in the sandboxed, opaque-origin frame of the static view with
// only these scripts: Полка's pdf-view.mjs and pdf.js's two modules, all from
// /__polka/pdf/<version>/ on the viewer (script-src names that path, nothing
// else, no inline script, no eval). Its parser runs in the frame's own thread
// (globalThis.pdfjsWorker): no worker is started, so worker-src stays 'none'.
// The document's JavaScript and forms never run: Полка loads no pdf.js
// scripting sandbox (enableScripting: false), draws annotations without
// forms, and the frame has no network (connect-src 'none'), so the file
// travels inside the page, not by a request.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import type { FastifyInstance } from "fastify";
import { escapeHtml } from "../../packages/contracts/html.ts";
import { config } from "./config.ts";
import { missing } from "./errors.ts";

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
export const PDFJS_VERSION = JSON.parse(readFileSync(join(pdfjsRoot, "package.json"), "utf8")).version as string;
/** Where the viewer serves pdf.js; the version in the path lets browsers keep the files. */
export const PDF_ASSETS_PATH = `/__polka/pdf/${PDFJS_VERSION}/`;

/** The files under PDF_ASSETS_PATH: the legacy build (older Safari too) and Полка's script. */
const ASSETS: Record<string, () => Buffer> = {
  "pdf.min.mjs": () => readFileSync(join(pdfjsRoot, "legacy/build/pdf.min.mjs")),
  "pdf.worker.min.mjs": () => readFileSync(join(pdfjsRoot, "legacy/build/pdf.worker.min.mjs")),
  "pdf-view.mjs": () => readFileSync(new URL("./single-file-view-pdf.client.mjs", import.meta.url)),
};
const loaded = new Map<string, Buffer>();
const asset = (name: string) => {
  if (!Object.hasOwn(ASSETS, name)) return null;
  let bytes = loaded.get(name);
  if (!bytes) loaded.set(name, (bytes = ASSETS[name]!()));
  return bytes;
};

/**
 * The PDF page's CSP: the static view's (html.ts, staticHtmlCsp) plus scripts
 * from the pdf.js path only, and pictures from blob: (pdf.js hands decoded
 * images to the canvas that way). No connect-src, worker-src, frames,
 * forms, popups or eval.
 */
export const pdfViewCsp = (frameAncestors: string) =>
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${config.VIEWER_ORIGIN}${PDF_ASSETS_PATH}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f3f1ec;--ink:#1d1b18;--muted:#6b665d;--sheet:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a18;--ink:#ece8e1;--muted:#a49e93;--sheet:#fff}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{display:flex;flex-direction:column;align-items:center;gap:28px;padding:16px 12px 48px}
.pdf-status{color:var(--muted);margin:32px 16px;text-align:center}
.pdf-page{position:relative;background:var(--sheet);box-shadow:0 1px 3px rgb(0 0 0/.18);max-width:100%;--scale-round-x:1px;--scale-round-y:1px}
.pdf-page canvas{display:block;width:100%;height:100%}
.pdf-number{position:absolute;right:4px;bottom:-21px;font-size:12px;line-height:16px;color:var(--muted)}
.textLayer{position:absolute;inset:0;overflow:clip;opacity:1;line-height:1;text-align:initial;letter-spacing:normal;word-spacing:normal;text-size-adjust:none;-webkit-text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.textLayer > :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
.textLayer .markedContent{display:contents}
.textLayer ::selection{background:rgb(0 90 255/.25);color:transparent}
.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none}
@media (max-width:600px){main{padding:12px 8px 40px;gap:26px}}
`;

/**
 * The whole page of a PDF work. The file goes base64 in a data block (a
 * <script> of a type that never runs; base64 has no "<", so it cannot close
 * the block); pdf-view.mjs reads it, its options are fixed there.
 */
export function pdfViewPage(revision: { filename: string }, bytes: Buffer): Buffer {
  const name = posix.basename(String(revision.filename || "document.pdf")) || "document.pdf";
  const base = `${config.VIEWER_ORIGIN}${PDF_ASSETS_PATH}`;
  return Buffer.from(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${PAGE_CSS}</style>
</head><body><main id="polka-pdf" aria-label="${escapeHtml(name)}"><p class="pdf-status" role="status">Открываем PDF…</p></main>
<script type="application/pdf;base64" id="polka-pdf-data">${bytes.toString("base64")}</script>
<script type="module" src="${escapeHtml(base)}pdf-view.mjs"></script>
</body></html>`,
  );
}

/**
 * pdf.js and Полка's script for the PDF page. Library code, the same for
 * everyone: no grant needed, kept by browsers for a year under its version.
 * Served only as a script (Fetch Metadata), with CORS for the page's opaque
 * origin (module scripts load in CORS mode).
 */
export function registerPdfAssets(viewer: FastifyInstance) {
  viewer.get(`${PDF_ASSETS_PATH}:name`, async (req, reply) => {
    const dest = req.headers["sec-fetch-dest"];
    if (dest !== undefined && dest !== "script") throw missing();
    const bytes = asset((req.params as { name?: string }).name ?? "");
    if (!bytes) throw missing();
    return reply
      .type("text/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("access-control-allow-origin", "*")
      .header("cross-origin-resource-policy", "cross-origin")
      .send(bytes);
  });
}
