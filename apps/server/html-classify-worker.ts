import { parentPort } from "node:worker_threads";
import { classifyHtml } from "./html.ts";

// One page per worker; the parent terminates it after the answer or the deadline.
parentPort!.once("message", (source: string) => {
  let profile: string;
  try {
    profile = classifyHtml(source);
  } catch {
    profile = "unsupported";
  }
  parentPort!.postMessage(profile);
});
