import { parentPort } from "node:worker_threads";
import { coverFactsFromHtml } from "./cover-facts.ts";

// One page per worker; the parent terminates it after the answer or the deadline.
// The deadline starts when this module has loaded and says it is ready
// (the same protocol as html-classify-worker.ts, html.ts inWorker).
parentPort!.once("message", ({ source }: { source: string }) => {
  try {
    parentPort!.postMessage(coverFactsFromHtml(source));
  } catch {
    parentPort!.postMessage(null);
  }
});
// Loaded and listening: the parent sends the source now and starts the clock.
parentPort!.postMessage({ ready: true });
