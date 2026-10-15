import { parentPort } from "node:worker_threads";
import { UNREAD, inspectHtml, scanScripts, type HtmlInspection, type InspectOptions, type ScriptScan } from "./html.ts";
import { SCAN_INCOMPLETE, SignalCollector } from "./phishing-signals.ts";
import { scanText } from "./content-filter/scanner.ts";
import { coverFactsFromHtml } from "./cover-facts.ts";
import { renderProjectMarkdownUnsigned } from "./project-markdown.ts";
import { csvTableHtml } from "./single-file-view-csv.ts";
import { readPdf } from "./pdf-reader.ts";

// A reader of the pool (worker-pool.ts): it stays loaded and answers tasks one
// at a time. The parent terminates it when a task misses its deadline, so a
// task never has to stop itself. The answer is the task's result, or the
// task's own «unread» value when it throws.
type Task =
  | { kind: "inspect"; source: string; options?: InspectOptions; text?: boolean; scripts?: string[] }
  | { kind: "cover"; source: string }
  | { kind: "markdown"; source: string; path: string; paths: string[] | null }
  | { kind: "csv"; source: string }
  | { kind: "pdf"; bytes: Uint8Array };

function run(task: Task): unknown {
  // A PDF's text and links (pdf-reader.ts); pdf.js answers asynchronously.
  if (task.kind === "pdf") return readPdf(task.bytes).catch(() => ({ ok: false, reason: "unread" }));
  if (task.kind === "cover") {
    try {
      return coverFactsFromHtml(task.source);
    } catch {
      return null;
    }
  }
  if (task.kind === "markdown") {
    try {
      return renderProjectMarkdownUnsigned(task.source, task.path, task.paths && new Set(task.paths));
    } catch {
      return null;
    }
  }
  if (task.kind === "csv") {
    try {
      return csvTableHtml(task.source);
    } catch {
      return null;
    }
  }
  // A work's scripts (html.ts, scanScriptsBounded): signals and findings.
  if (task.scripts) {
    try {
      return scanScripts(task.scripts);
    } catch {
      return { signals: [SCAN_INCOMPLETE], filter: UNREAD.filter } satisfies ScriptScan;
    }
  }
  // A plain text file: only the content filter.
  if (task.text) return scanText(task.source);
  // A page: the profile, the phishing signals and the content filter's
  // findings of the same walk.
  try {
    return inspectHtml(task.source, new SignalCollector(task.options ?? {})) satisfies HtmlInspection;
  } catch {
    return UNREAD;
  }
}

// One task at a time (worker-pool.ts): the next one is sent after this answer.
parentPort!.on("message", async ({ id, task }: { id: number; task: Task }) => {
  parentPort!.postMessage({ id, result: await run(task) });
});
// Compile and warm the signal patterns (phishing-signals.ts) before the first
// task: their first use costs tens of milliseconds that belong to the
// worker's start, not to a page.
inspectHtml(
  `<p>Сообщите код, переведите на карту 1234, напишите в Telegram @abcd, позвоните +7 900 000-00-00, send us code, x@example.com</p><a href="https://example.com/login">x</a><input type="password" name="password"><script>const a="https://example.ru";</script>`,
);
// Loaded and listening: the parent sends tasks now.
parentPort!.postMessage({ ready: true });
