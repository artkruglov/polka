// Runs diffTexts off the main thread: a large page cannot freeze the tab.
import { diffTexts } from "./line-diff.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ oldText: string; newText: string }>) => void) | null;
  postMessage: (message: unknown) => void;
};
scope.onmessage = (event) => {
  scope.postMessage(diffTexts(event.data.oldText, event.data.newText));
};
