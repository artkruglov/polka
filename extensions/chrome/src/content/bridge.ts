/// <reference path="../chrome.d.ts" />
/*
 * Runs only on the user's Полка (registered for that origin alone, top frame).
 * Answers Полка's page over window.postMessage: «hello» → «ready», and an
 * «import» of one artifact link → progress and the result. The protocol and
 * its checks (same window, same origin, the page's nonce) live in
 * packages/contracts/extension-bridge.ts.
 */
import {
  acceptPageEvent,
  EXTENSION_SOURCE,
  type ExtensionMessage,
  type ImportFailure,
  type ImportSuccess,
} from "../../../../packages/contracts/extension-bridge.ts";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "source" | "v" | "nonce"> : never;

if (window.top === window) {
  let nonce: string | null = null;
  const post = (message: WithoutEnvelope<ExtensionMessage>) => {
    if (!nonce) return;
    window.postMessage(
      { source: EXTENSION_SOURCE, v: 1, nonce, ...message },
      location.origin,
    );
  };

  window.addEventListener("message", (event) => {
    const message = acceptPageEvent(event, {
      window,
      origin: location.origin,
      nonce,
    });
    if (!message) return;
    if (message.type === "hello") {
      nonce = message.nonce;
      chrome.runtime
        .sendMessage<{ connected: boolean; version: string } | null>({ type: "bridge-status" })
        .then((status) => {
          // null: this Полка is not the one the extension is set up for.
          if (status)
            post({ type: "ready", version: status.version, connected: status.connected });
        })
        .catch(() => {});
      return;
    }
    const { requestId, url } = message;
    chrome.runtime
      .sendMessage<ImportSuccess | ImportFailure | null>({
        type: "bridge-import",
        requestId,
        url,
      })
      .then((result) =>
        post({
          type: "result",
          requestId,
          result: result ?? {
            ok: false,
            code: "extract_failed",
            message: "Расширение не ответило. Обновите страницу и повторите.",
          },
        }),
      )
      .catch(() =>
        post({
          type: "result",
          requestId,
          result: {
            ok: false,
            code: "extract_failed",
            message: "Расширение было перезапущено. Обновите страницу и повторите.",
          },
        }),
      );
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "bridge-progress" && typeof message.requestId === "string")
      post({ type: "progress", requestId: message.requestId, stage: message.stage });
    return false;
  });
}
