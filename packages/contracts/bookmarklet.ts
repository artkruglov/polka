/*
 * The «На Полку» bookmarklet (extensions/bookmarklet) and Полка's
 * /bring/receive page talk through window.postMessage between two tabs: the
 * AI chat the user clicked the bookmark on, and the Полка tab the bookmark
 * opened from it. This module is the whole protocol; both sides import it.
 * No DOM, no zod: it ships inside the bookmarklet itself.
 * Unit-tested in tests/bookmarklet.test.ts.
 *
 * 1. On click the bookmark reads the artifact while its page is still in the
 *    foreground (menus and animations stop in a background tab), then opens
 *    <Полка>/bring/receive#nonce=<random> with the click's user activation and
 *    keeps the window handle. If the activation has run out, its toast offers
 *    a button that opens the tab.
 * 2. It posts one BookmarkletMessage (the source, or why there is none) to
 *    that window with targetOrigin = the Полка origin baked into the bookmark,
 *    again every half second until the tab replies (it may still be loading),
 *    for at most 15 s.
 * 3. The Полка tab accepts the first message that is from window.opener,
 *    from an AI provider's https origin in SOURCE_HOSTS, carries the nonce of
 *    its own URL fragment, describes a page of that same origin and is at most
 *    MAX_BYTES; it replies «ready» (or «rejected») to the opener and ignores
 *    everything after.
 *
 * Nothing else leaves the provider's page: no fetch, no XHR, no cookies.
 */
import { MAX_BYTES, MAX_TITLE } from "./constants.ts";

export const BOOKMARKLET_MESSAGE = "polka.bookmarklet.v1";
/** Where the bookmark opens Полка; the nonce follows in the fragment. */
export const RECEIVE_PATH = "/bring/receive";
/** How long the bookmark keeps offering the data to the Полка tab. */
export const DELIVERY_MS = 15_000;
/** The same limit as every other upload. */
export const BOOKMARKLET_MAX_BYTES = MAX_BYTES;
/** 144 bits, base64url. */
export const BOOKMARKLET_NONCE = /^[A-Za-z0-9_-]{24,64}$/;
const MAX_URL = 2048;

/**
 * The AI chats a bookmark may send from (https only, exact hosts). Claude and
 * ChatGPT get dedicated readers; on the others the bookmark sends a snapshot
 * of the page. Anything else: the bookmark says so and opens nothing.
 */
export const SOURCE_HOSTS = [
  "claude.ai",
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "aistudio.google.com",
  "www.perplexity.ai",
  "perplexity.ai",
  "v0.app",
  "v0.dev",
  "chat.deepseek.com",
  "chat.mistral.ai",
  "copilot.microsoft.com",
  "grok.com",
  "alice.yandex.ru",
  "giga.chat",
] as const;

/** artifact: read by a provider reader; snapshot: the page as rendered, without scripts. */
export type BookmarkletKind = "artifact" | "snapshot";
/** html: save as a page; jsx/tsx: component source; text: anything else. */
export type BookmarkletLanguage = "html" | "jsx" | "tsx" | "text";

export type BookmarkletSource = {
  /** The page the bookmark was clicked on. */
  url: string;
  title: string;
  kind: BookmarkletKind;
  language: BookmarkletLanguage;
  text: string;
};

/** Why the bookmark had nothing to send; the Полка tab explains it in its own words. */
export type BookmarkletFailure = "not_found" | "sign_in" | "too_large";

export type BookmarkletMessage =
  | { type: typeof BOOKMARKLET_MESSAGE; nonce: string; source: BookmarkletSource }
  | { type: typeof BOOKMARKLET_MESSAGE; nonce: string; failure: BookmarkletFailure };

export type BookmarkletRejection = "too_large" | "invalid";

export type BookmarkletReply =
  | { type: typeof BOOKMARKLET_MESSAGE; nonce: string; reply: "ready" }
  | {
      type: typeof BOOKMARKLET_MESSAGE;
      nonce: string;
      reply: "rejected";
      reason: BookmarkletRejection;
    };

const FAILURES: readonly BookmarkletFailure[] = ["not_found", "sign_in", "too_large"];
const KINDS: readonly BookmarkletKind[] = ["artifact", "snapshot"];
const LANGUAGES: readonly BookmarkletLanguage[] = ["html", "jsx", "tsx", "text"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An https origin of one of SOURCE_HOSTS, nothing else (no port, no http). */
export function allowedSourceOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.origin === origin &&
    !url.port &&
    (SOURCE_HOSTS as readonly string[]).includes(url.hostname)
  );
}

/** The nonce from /bring/receive's fragment (#nonce=…), or null. */
export function nonceFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("nonce");
  return value && BOOKMARKLET_NONCE.test(value) ? value : null;
}

/** UTF-8 length without TextEncoder allocations of the whole text. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The page's address as provenance keeps it: https, no credentials, no query
 * and no fragment (they may carry tokens). Null when nothing is left.
 */
export function provenanceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.href.length <= MAX_URL ? url.href : null;
  } catch {
    return null;
  }
}

/** The parts of a MessageEvent the receiving tab checks. */
export type BookmarkletEvent = { origin: string; source: unknown; data: unknown };

export type Accepted =
  | { status: "source"; source: BookmarkletSource }
  | { status: "failure"; failure: BookmarkletFailure }
  | { status: "rejected"; reason: BookmarkletRejection };

/**
 * One check for a message arriving at /bring/receive. Null: not for us, say
 * nothing (another window, another origin, another nonce, not this protocol).
 * «failure»: the bookmark found nothing to send and says why. «rejected»: it
 * is our bookmark, but the content cannot be taken; the page answers
 * «rejected» so the bookmark can tell the user.
 */
export function acceptBookmarkletEvent(
  event: BookmarkletEvent,
  expected: { opener: unknown; nonce: string | null },
): Accepted | null {
  if (!expected.nonce || !expected.opener || event.source !== expected.opener)
    return null;
  if (!allowedSourceOrigin(event.origin)) return null;
  const data = event.data;
  if (
    !isObject(data) ||
    data.type !== BOOKMARKLET_MESSAGE ||
    data.nonce !== expected.nonce
  )
    return null;
  if ("failure" in data)
    return FAILURES.includes(data.failure as BookmarkletFailure)
      ? { status: "failure", failure: data.failure as BookmarkletFailure }
      : { status: "rejected", reason: "invalid" };
  return checkSource(data.source, event.origin);
}

/**
 * A source as sent by the bookmark on the page at `origin` (also one restored
 * after sign-in): well-formed, naming a page of that origin, non-empty and
 * within MAX_BYTES.
 */
export function checkSource(source: unknown, sender: string): Accepted {
  if (!isObject(source) || !allowedSourceOrigin(sender))
    return { status: "rejected", reason: "invalid" };
  const { url, title, kind, language, text } = source;
  if (
    typeof url !== "string" ||
    url.length > MAX_URL ||
    typeof title !== "string" ||
    typeof text !== "string" ||
    !KINDS.includes(kind as BookmarkletKind) ||
    !LANGUAGES.includes(language as BookmarkletLanguage)
  )
    return { status: "rejected", reason: "invalid" };
  // The page it names is the page that sent it.
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { status: "rejected", reason: "invalid" };
  }
  if (origin !== sender) return { status: "rejected", reason: "invalid" };
  // A cheap bound first: a UTF-16 unit is at least one UTF-8 byte.
  if (text.length > BOOKMARKLET_MAX_BYTES || utf8Bytes(text) > BOOKMARKLET_MAX_BYTES)
    return { status: "rejected", reason: "too_large" };
  if (!text.trim()) return { status: "rejected", reason: "invalid" };
  return {
    status: "source",
    source: {
      url,
      title: title
        .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_TITLE),
      kind: kind as BookmarkletKind,
      language: language as BookmarkletLanguage,
      text,
    },
  };
}

/** The bookmark's side: a reply from its own Полка tab, or null. */
export function parseBookmarkletReply(
  event: BookmarkletEvent,
  expected: { tab: unknown; origin: string; nonce: string },
): BookmarkletReply | null {
  if (event.source !== expected.tab || event.origin !== expected.origin) return null;
  const data = event.data;
  if (
    !isObject(data) ||
    data.type !== BOOKMARKLET_MESSAGE ||
    data.nonce !== expected.nonce
  )
    return null;
  if (data.reply === "ready")
    return { type: BOOKMARKLET_MESSAGE, nonce: expected.nonce, reply: "ready" };
  if (
    data.reply === "rejected" &&
    (data.reason === "too_large" || data.reason === "invalid")
  )
    return {
      type: BOOKMARKLET_MESSAGE,
      nonce: expected.nonce,
      reply: "rejected",
      reason: data.reason,
    };
  return null;
}
