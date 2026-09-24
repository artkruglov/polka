/*
 * Injected on demand (chrome.scripting, isolated world) into the top frame of
 * a claude.ai or chatgpt.com tab when the user asks to save. It only reads the
 * page; the one thing it changes is a data-polka-copy marker on the Copy
 * button, which copy-capture.ts removes when it presses that button.
 */
import { inspectPage } from "./inspect.ts";

export { inspectPage, type PageReport } from "./inspect.ts";

(globalThis as any).__polkaPage = {
  inspect: () => inspectPage(document, location.hostname, location.pathname),
};
