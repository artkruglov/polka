import { parentPort } from "node:worker_threads";
import { inspectHtml, type HtmlInspection } from "./html.ts";
import { SCAN_INCOMPLETE } from "./phishing-signals.ts";

// One page per worker; the parent terminates it after the answer or the deadline.
// The answer is the profile and the phishing signals of the same walk.
parentPort!.once("message", (source: string) => {
  let inspection: HtmlInspection;
  try {
    inspection = inspectHtml(source);
  } catch {
    inspection = { profile: "unsupported", signals: [SCAN_INCOMPLETE] };
  }
  parentPort!.postMessage(inspection);
});
