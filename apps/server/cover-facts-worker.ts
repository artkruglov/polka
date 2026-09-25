import { parentPort } from "node:worker_threads";
import { coverFactsFromHtml } from "./cover-facts.ts";

// One page per worker; the parent terminates it after the answer or the deadline.
parentPort!.once("message", ({ source }: { source: string }) => {
  try {
    parentPort!.postMessage(coverFactsFromHtml(source));
  } catch {
    parentPort!.postMessage(null);
  }
});
