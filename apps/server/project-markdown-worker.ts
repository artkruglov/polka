import { parentPort } from "node:worker_threads";
import { renderProjectMarkdown } from "./project-markdown.ts";

// One document per worker; the parent terminates it after the answer or the
// deadline (the protocol of html.ts inWorker). marked is quadratic on some
// inputs, so a document is never drawn on the request thread.
parentPort!.once(
  "message",
  ({ source, path, paths }: { source: string; path: string; paths: string[] }) => {
    try {
      parentPort!.postMessage(renderProjectMarkdown(source, path, new Set(paths)));
    } catch {
      parentPort!.postMessage(null);
    }
  },
);
// Loaded and listening: the parent sends the document now and starts the clock.
parentPort!.postMessage({ ready: true });
