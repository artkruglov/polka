import { diffTexts, type DiffResult } from "./line-diff.ts";

/**
 * Diff two texts in a Web Worker; an abort terminates the worker. Where
 * workers are unavailable the (bounded) diff runs in place.
 */
export function diffInWorker(
  oldText: string,
  newText: string,
  signal?: AbortSignal,
): Promise<DiffResult> {
  if (typeof Worker === "undefined")
    return Promise.resolve(diffTexts(oldText, newText));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./line-diff.worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      signal?.removeEventListener("abort", stop);
      worker.terminate();
    };
    function stop() {
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    }
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    worker.onmessage = (event: MessageEvent<DiffResult>) => {
      finish();
      resolve(event.data);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Не удалось сравнить версии в этом браузере."));
    };
    worker.postMessage({ oldText, newText });
  });
}
