import { parentPort } from "node:worker_threads";
import {
  UNREAD,
  inspectHtml,
  type HtmlInspection,
  type InspectOptions,
} from "./html.ts";
import { SignalCollector } from "./phishing-signals.ts";
import { scanText } from "./content-filter/scanner.ts";

// One page per worker; the parent terminates it after the answer or the deadline.
// The deadline starts when this module has loaded and says it is ready (below).
// The answer is the profile, the phishing signals and the content filter's
// findings of the same walk.
parentPort!.once(
  "message",
  ({
    source,
    options,
    text,
  }: {
    source: string;
    options?: InspectOptions;
    text?: boolean;
  }) => {
  // A plain text file: only the content filter.
  if (text) {
    parentPort!.postMessage(scanText(source));
    return;
  }
  let inspection: HtmlInspection;
  try {
    inspection = inspectHtml(source, new SignalCollector(options ?? {}));
  } catch {
    inspection = UNREAD;
  }
  parentPort!.postMessage(inspection);
  },
);
// Loaded and listening: the parent sends the source now and starts the clock.
parentPort!.postMessage({ ready: true });
