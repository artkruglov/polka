// Single-file works Полка draws as a page (docs/specs/SINGLE_FILE_FORMATS.md):
// Markdown through the project renderer, CSV as a table, JSON as code. The
// page is Полка's own markup around escaped text: no script, no network, no
// author HTML. It is served only on the viewer domain (static-viewer.ts),
// never from the app's origin.
import { posix } from "node:path";
import { singleFileFormat } from "../../packages/contracts/constants.ts";
import { escapeHtml } from "../../packages/contracts/html.ts";
import { projectDocumentPage, renderProjectMarkdownBounded, type ProjectPage } from "./project-markdown.ts";
import { csvTableHtml } from "./single-file-view-csv.ts";
import { runInPool } from "./worker-pool.ts";

/** Drawn on the request below this; in the reader pool above it. */
export const CSV_INLINE_CHARS = 16 * 1024;
export const CSV_DEADLINE_MS = 3_000;

// A version never changes: a drawn table is kept for the next view, within bounds.
const TABLES_KEPT = 20;
const TABLE_CACHE_CHARS = 16 * 1024 * 1024;
const tables = new Map<string, string>();
let tableChars = 0;
function keepTable(key: string, body: string) {
  if (body.length > TABLE_CACHE_CHARS / 4) return;
  while (tables.size && (tables.size >= TABLES_KEPT || tableChars + body.length > TABLE_CACHE_CHARS)) {
    const [oldest, value] = tables.entries().next().value!;
    tables.delete(oldest);
    tableChars -= value.length;
  }
  tables.set(key, body);
  tableChars += body.length;
}

const asText = (source: string, note: string) =>
  `<p class="polka-note">${escapeHtml(note)}</p><pre class="polka-code"><code>${escapeHtml(source)}</code></pre>`;

async function csvBody(source: string, key: string) {
  const kept = tables.get(key);
  if (kept !== undefined) return kept;
  const body =
    source.length <= CSV_INLINE_CHARS
      ? csvTableHtml(source)
      : await runInPool<string | null>({ kind: "csv", source }, CSV_DEADLINE_MS, null);
  if (body === null)
    return asText(source, "Таблица показана как текст: она слишком большая или сложная для оформления.");
  keepTable(key, body);
  return body;
}

/** The whole page of a single-file work of a drawn format (isDrawnMime). */
export async function drawSingleFile(
  revision: { id: string; mime: string; filename: string },
  bytes: Buffer,
): Promise<Buffer> {
  const view = singleFileFormat(revision.mime)?.view;
  const source = bytes.toString("utf8");
  const name = posix.basename(String(revision.filename || "file")) || "file";
  let page: ProjectPage;
  if (view === "markdown") page = await renderProjectMarkdownBounded(source, name, null, `single:${revision.id}`);
  else if (view === "table") page = { title: name, body: await csvBody(source, revision.id) };
  else if (view === "code")
    page = { title: name, body: `<pre class="polka-code"><code>${escapeHtml(source)}</code></pre>` };
  else throw new Error(`Not a drawn format: ${revision.mime}`);
  return Buffer.from(projectDocumentPage(page, null, { wide: view === "table" }));
}
