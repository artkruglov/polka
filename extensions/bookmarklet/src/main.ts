/*
 * The «На Полку» bookmarklet: a bookmark whose address is this code.
 * Built by extensions/bookmarklet/build.ts into one minified IIFE and served
 * by Полка's /bookmarklet page as a javascript: link to drag onto the
 * bookmarks bar. The Полка address is baked in when the link is made.
 *
 * On click, on an AI chat's page (SOURCE_HOSTS):
 * 1. reads the artifact while the page is in the foreground (read.ts);
 * 2. opens <Полка>/bring/receive#nonce=<random> in a new tab;
 * 3. posts the source to that tab only (targetOrigin = Полка), until it
 *    answers, for at most 15 s.
 * It sends nothing anywhere else (no fetch, no XHR), reads no cookies or
 * storage, and puts back everything it patched in the page (read.ts →
 * the extension's capture functions restore them before returning).
 * Protocol: packages/contracts/bookmarklet.ts.
 */
import {
  BOOKMARKLET_MAX_BYTES,
  BOOKMARKLET_MESSAGE,
  DELIVERY_MS,
  RECEIVE_PATH,
  allowedSourceOrigin,
  parseBookmarkletReply,
  utf8Bytes,
  type BookmarkletMessage,
  type BookmarkletReply,
} from "../../../packages/contracts/bookmarklet.ts";
import { readPage, type Read } from "./read.ts";
import { toast, type Toast } from "./toast.ts";

declare const POLKA_ORIGIN: string;

const BUSY = "__polkaBookmarkletBusy";

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Offers the message until the tab answers, it is closed, or time is up. */
function deliver(
  tab: Window,
  nonce: string,
  message: BookmarkletMessage,
): Promise<BookmarkletReply | "closed" | "timeout"> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (result: BookmarkletReply | "closed" | "timeout") => {
      clearInterval(timer);
      clearTimeout(deadline);
      window.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      const reply = parseBookmarkletReply(event, { tab, origin: POLKA_ORIGIN, nonce });
      if (reply) finish(reply);
    };
    const offer = () => {
      if (tab.closed) return finish("closed");
      // While the tab is still loading it has another origin: the browser
      // drops the message (targetOrigin) and the next offer goes through.
      try {
        tab.postMessage(message, POLKA_ORIGIN);
      } catch {
        /* the window is going away */
      }
    };
    window.addEventListener("message", onMessage);
    const deadline = setTimeout(() => finish("timeout"), DELIVERY_MS);
    timer = setInterval(offer, 500);
    offer();
  });
}

function message(nonce: string, read: Read): BookmarkletMessage {
  if ("failure" in read) return { type: BOOKMARKLET_MESSAGE, nonce, failure: read.failure };
  if (utf8Bytes(read.source.text) > BOOKMARKLET_MAX_BYTES)
    return { type: BOOKMARKLET_MESSAGE, nonce, failure: "too_large" };
  return { type: BOOKMARKLET_MESSAGE, nonce, source: read.source };
}

const FAILURE_TEXT = {
  not_found:
    "Артефакт на странице не найден. Откройте его так, чтобы он был виден справа от чата, и нажмите закладку ещё раз.",
  sign_in: "Войдите в чат в этом браузере и нажмите закладку ещё раз.",
  too_large: "Больше 5 МБ: такой файл Полка не примет.",
} as const;

async function send(note: Toast, tab: Window, nonce: string, outgoing: BookmarkletMessage) {
  note.progress("Передаём во вкладку Полки…");
  const reply = await deliver(tab, nonce, outgoing);
  if (reply === "closed") return note.error("Вкладку Полки закрыли до того, как она получила данные.");
  if (reply === "timeout")
    return note.error("Вкладка Полки не ответила за 15 секунд. Проверьте, что она открылась, и нажмите закладку ещё раз.");
  if (reply.reply === "rejected")
    return note.error(reply.reason === "too_large" ? FAILURE_TEXT.too_large : "Полка не приняла данные с этой страницы.");
  if ("failure" in outgoing) return note.error(FAILURE_TEXT[outgoing.failure]);
  note.done("Готово: проверьте название во вкладке Полки и нажмите «Сохранить на полку».");
}

async function run() {
  const page = window as unknown as Record<string, unknown>;
  if (page[BUSY]) return;
  const note = toast();
  if (!allowedSourceOrigin(location.origin)) {
    note.error(
      "Закладка работает на страницах Claude, ChatGPT и других AI-чатов. Эту страницу можно сохранить на Полке файлом.",
    );
    return;
  }
  page[BUSY] = true;
  try {
    note.progress("Читаем артефакт на странице…");
    let read: Read;
    try {
      read = await readPage();
    } catch {
      read = { failure: "not_found" };
    }
    const nonce = randomNonce();
    const outgoing = message(nonce, read);
    const url = `${POLKA_ORIGIN}${RECEIVE_PATH}#nonce=${nonce}`;
    // With the click's activation still fresh the tab opens at once;
    // otherwise (a slow menu, Safari's short window) the user presses once more.
    const tab = window.open(url, "_blank");
    if (tab) return await send(note, tab, nonce, outgoing);
    note.action("Всё готово. Откройте Полку, чтобы сохранить.", "Открыть Полку", () => {
      const opened = window.open(url, "_blank");
      if (opened) void send(note, opened, nonce, outgoing);
      else
        note.error(
          "Браузер не дал открыть вкладку. Разрешите всплывающие окна для этого сайта и нажмите закладку ещё раз.",
        );
    });
  } finally {
    delete page[BUSY];
  }
}

void run();
