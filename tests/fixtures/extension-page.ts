import {
  acceptExtensionEvent,
  PAGE_SOURCE,
  type ImportFailure,
  type ImportStage,
  type ImportSuccess,
  type PageMessage,
} from "../../packages/contracts/extension-bridge.ts";

/*
 * The page's half of the bridge to the «На Полку» browser extension
 * (packages/contracts/extension-bridge.ts), kept as the reference the
 * extension is tested against. The web app stopped offering link import
 * (2026-09-25), so no page ships it any more. The page says «hello» with a fresh
 * nonce; the extension's content script, present only if it is installed and
 * set up for this Полка, answers «ready». An import then goes out with the
 * same nonce and comes back as progress and one result. Only messages from
 * this window, this origin and with this nonce are read.
 */

export type ImportResult = ImportSuccess | ImportFailure;

export type ExtensionLink = {
  version: string;
  connected: boolean;
  importArtifact(
    url: string,
    onStage?: (stage: ImportStage) => void,
  ): Promise<ImportResult>;
  close(): void;
};

type Listener = (event: MessageEvent) => void;
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "source" | "v" | "nonce"> : never;
/** The parts of window the bridge uses; tests pass a stand-in. */
export type BridgeWindow = {
  location: { origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: "message", listener: Listener): void;
  removeEventListener(type: "message", listener: Listener): void;
};

const token = (bytes: number) => {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...random))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** The whole wait for one import: opening Claude, rendering, saving. */
const IMPORT_TIMEOUT_MS = 120_000;

export function findExtension(
  win: BridgeWindow = window as unknown as BridgeWindow,
  { timeoutMs = 1500 }: { timeoutMs?: number } = {},
): Promise<ExtensionLink | null> {
  const nonce = token(16);
  const origin = win.location.origin;
  const send = (message: WithoutEnvelope<PageMessage>) =>
    win.postMessage({ source: PAGE_SOURCE, v: 1, nonce, ...message }, origin);
  const pending = new Map<
    string,
    { resolve: (result: ImportResult) => void; onStage?: (stage: ImportStage) => void; timer: ReturnType<typeof setTimeout> }
  >();

  return new Promise((resolveLink) => {
    let link: ExtensionLink | null = null;
    const retries: ReturnType<typeof setTimeout>[] = [];
    const listener: Listener = (event) => {
      const message = acceptExtensionEvent(event, { window: win, origin, nonce });
      if (!message) return;
      if (message.type === "ready") {
        if (link) return;
        retries.forEach(clearTimeout);
        link = {
          version: message.version,
          connected: message.connected,
          importArtifact(url, onStage) {
            const requestId = token(12);
            return new Promise<ImportResult>((resolve) => {
              const timer = setTimeout(() => {
                pending.delete(requestId);
                resolve({
                  ok: false,
                  code: "timeout",
                  message: "Расширение не ответило за две минуты. Проверьте вкладки браузера и повторите.",
                });
              }, IMPORT_TIMEOUT_MS);
              pending.set(requestId, { resolve, onStage, timer });
              send({ type: "import", requestId, url });
            });
          },
          close() {
            win.removeEventListener("message", listener);
            for (const entry of pending.values()) clearTimeout(entry.timer);
            pending.clear();
          },
        };
        resolveLink(link);
        return;
      }
      const entry = pending.get(message.requestId);
      if (!entry) return;
      if (message.type === "progress") entry.onStage?.(message.stage);
      else {
        clearTimeout(entry.timer);
        pending.delete(message.requestId);
        entry.resolve(message.result);
      }
    };
    win.addEventListener("message", listener);
    // The extension's script may start after this page's code: ask a few times.
    for (const delay of [0, 250, 700]) retries.push(setTimeout(() => send({ type: "hello" }), delay));
    retries.push(
      setTimeout(() => {
        if (link) return;
        win.removeEventListener("message", listener);
        resolveLink(null);
      }, timeoutMs),
    );
  });
}
