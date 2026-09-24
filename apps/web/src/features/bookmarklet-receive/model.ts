import { useEffect, useState } from "react";
import {
  BOOKMARKLET_MAX_BYTES,
  BOOKMARKLET_MESSAGE,
  acceptBookmarkletEvent,
  checkSource,
  provenanceUrl,
  utf8Bytes,
  type BookmarkletFailure,
  type BookmarkletSource,
} from "../../../../../packages/contracts/bookmarklet.ts";
import { looksLikeHtml } from "../../../../../packages/contracts/constants.ts";

/**
 * What the bookmark sent survives the sign-in round trip here, in this tab's
 * sessionStorage only (it is gone when the tab closes), and is removed once
 * saved or dismissed.
 */
const PENDING = "polka.bookmarklet.pending";

export function loadPending(): BookmarkletSource | null {
  try {
    const raw = sessionStorage.getItem(PENDING);
    if (!raw) return null;
    const value = JSON.parse(raw) as BookmarkletSource;
    // The same checks as a fresh message from the page it names.
    const checked = checkSource(value, new URL(value.url).origin);
    return checked.status === "source" ? checked.source : null;
  } catch {
    return null;
  }
}

export function savePending(source: BookmarkletSource): boolean {
  try {
    sessionStorage.setItem(PENDING, JSON.stringify(source));
    return true;
  } catch {
    return false; // storage off or full: the page says the data will not survive sign-in
  }
}

export function clearPending() {
  try {
    sessionStorage.removeItem(PENDING);
  } catch {
    /* nothing to clear */
  }
}

export type Received =
  | { state: "waiting" }
  | { state: "source"; source: BookmarkletSource }
  | { state: "failure"; failure: BookmarkletFailure | "too_large" | "invalid" | "timeout" };

/**
 * The one message from the bookmark: from window.opener, an allowed AI chat,
 * with this tab's nonce. Everything else is ignored without a reply; the
 * first accepted message ends listening.
 */
export function useBookmarkletMessage(nonce: string | null, waitMs = 20_000): Received {
  const [received, setReceived] = useState<Received>({ state: "waiting" });
  useEffect(() => {
    if (!nonce) return;
    let done = false;
    const reply = (event: MessageEvent, body: Record<string, unknown>) =>
      (event.source as Window | null)?.postMessage(
        { type: BOOKMARKLET_MESSAGE, nonce, ...body },
        event.origin,
      );
    const onMessage = (event: MessageEvent) => {
      if (done) return;
      const accepted = acceptBookmarkletEvent(event, { opener: window.opener, nonce });
      if (!accepted) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (accepted.status === "rejected") {
        reply(event, { reply: "rejected", reason: accepted.reason });
        return setReceived({ state: "failure", failure: accepted.reason });
      }
      reply(event, { reply: "ready" });
      setReceived(
        accepted.status === "source"
          ? { state: "source", source: accepted.source }
          : { state: "failure", failure: accepted.failure },
      );
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      setReceived({ state: "failure", failure: "timeout" });
    }, waitMs);
    window.addEventListener("message", onMessage);
    return () => {
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [nonce, waitMs]);
  return received;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The file saved for a source. Always an HTML page, so the source address
 * stays in its provenance: HTML as sent; component source and text as a
 * page showing the text as written, with no markup and no scripts.
 */
export function toUpload(source: BookmarkletSource, title: string) {
  const html = source.language === "html" && looksLikeHtml(source.text);
  const text = html
    ? source.text
    : `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;padding:24px;font:16px/1.55 system-ui,sans-serif;color:#1b1f24;background:#fff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 ui-monospace,monospace}</style>
</head>
<body>
<pre>${escapeHtml(source.text)}</pre>
</body>
</html>
`;
  const blob = new Blob([text], { type: "text/html" });
  return {
    blob,
    filename:
      source.kind === "snapshot"
        ? "snapshot.html"
        : html
          ? "artifact.html"
          : source.language === "text"
            ? "artifact-text.html"
            : `component-${source.language}.html`,
    sourceUrl: provenanceUrl(source.url) ?? undefined,
    tooLarge: blob.size > BOOKMARKLET_MAX_BYTES,
  };
}

export const sourceSize = (source: BookmarkletSource) => utf8Bytes(source.text);

/** What the page says about each failure. */
export const FAILURE_TEXT: Record<Exclude<Received, { state: "waiting" | "source" }>["failure"], string> = {
  not_found:
    "Закладка не нашла артефакт на странице. Откройте его так, чтобы он был виден справа от чата, и нажмите закладку ещё раз.",
  sign_in: "Страница чата просит войти. Войдите в чат в том браузере и нажмите закладку ещё раз.",
  too_large: "Артефакт больше 5 МБ: такой файл Полка не примет.",
  invalid: "Со страницы пришли данные, которые Полка не может сохранить.",
  timeout:
    "Данные от закладки не пришли. Вернитесь на страницу чата и нажмите закладку ещё раз: эта вкладка должна открыться из неё.",
};
