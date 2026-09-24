/*
 * The «На Полку» browser extension and Полка's own page talk through
 * window.postMessage (extensions/chrome/README.md, «Мост со страницей Полки»).
 * This module is the whole protocol: both sides import it, so the shapes and
 * the checks cannot drift apart. It has no DOM or chrome.* dependencies and is
 * unit-tested in tests/extension-bridge.test.ts.
 *
 * Rules on both sides:
 * - only messages from the same window (event.source === window), never from a
 *   frame or another tab;
 * - only from the expected origin: the page accepts its own origin, the
 *   extension's bridge accepts only the Полка address it is configured for;
 * - a nonce chosen by the page in «hello» is echoed in every later message;
 *   a message with another nonce is ignored;
 * - an import carries one artifact URL from a short allowlist and nothing else.
 */

export const BRIDGE_VERSION = 1;
export const PAGE_SOURCE = "polka-page";
export const EXTENSION_SOURCE = "polka-extension";
/** 128+ bits, base64url; page-generated for each mount. */
export const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_URL = 2048;
const MAX_TEXT = 500;

export type ArtifactProvider = "claude" | "chatgpt";

export type PageMessage =
  | { source: typeof PAGE_SOURCE; v: 1; type: "hello"; nonce: string }
  | {
      source: typeof PAGE_SOURCE;
      v: 1;
      type: "import";
      nonce: string;
      requestId: string;
      url: string;
    };

export type ImportStage = "opening" | "extracting" | "saving" | "connecting";

export type ImportSuccess = {
  ok: true;
  title: string;
  /** Share link, or null when saved privately (reason in note). */
  url: string | null;
  shelfUrl: string;
  note: string | null;
};
export type ImportFailure = {
  ok: false;
  code:
    | "not_connected"
    | "unsupported_url"
    | "not_found"
    | "extract_failed"
    | "publish_failed"
    | "busy"
    | "timeout";
  message: string;
};

export type ExtensionMessage =
  | {
      source: typeof EXTENSION_SOURCE;
      v: 1;
      type: "ready";
      nonce: string;
      version: string;
      connected: boolean;
    }
  | {
      source: typeof EXTENSION_SOURCE;
      v: 1;
      type: "progress";
      nonce: string;
      requestId: string;
      stage: ImportStage;
    }
  | {
      source: typeof EXTENSION_SOURCE;
      v: 1;
      type: "result";
      nonce: string;
      requestId: string;
      result: ImportSuccess | ImportFailure;
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = MAX_TEXT) =>
  typeof value === "string" && value.length <= max;
const nullableText = (value: unknown, max = MAX_TEXT) =>
  value === null || text(value, max);
const webUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > MAX_URL) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * The artifact links the extension will open: a Claude artifact (chat,
 * published, shared or Claude Code) or a ChatGPT shared canvas/conversation.
 * Returns a normalised URL (no credentials, no fragment) or null.
 */
export function importableArtifact(
  value: unknown,
): { provider: ArtifactProvider; url: string } | null {
  if (typeof value !== "string" || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  url.hash = "";
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const id = "[A-Za-z0-9-]{6,80}";
  if (
    host === "claude.ai" &&
    new RegExp(
      `^/(artifact/${id}|public/artifacts/${id}|code/artifact/${id}|chat/${id})/?$`,
    ).test(path)
  )
    return { provider: "claude", url: url.href };
  if (
    host === "chatgpt.com" &&
    new RegExp(`^/(canvas/shared/${id}|share/${id}|c/${id})/?$`).test(path)
  )
    return { provider: "chatgpt", url: url.href };
  return null;
}

export function parsePageMessage(data: unknown): PageMessage | null {
  if (!isObject(data) || data.source !== PAGE_SOURCE || data.v !== 1)
    return null;
  if (typeof data.nonce !== "string" || !NONCE.test(data.nonce)) return null;
  if (data.type === "hello")
    return { source: PAGE_SOURCE, v: 1, type: "hello", nonce: data.nonce };
  if (
    data.type === "import" &&
    typeof data.requestId === "string" &&
    REQUEST_ID.test(data.requestId)
  ) {
    const artifact = importableArtifact(data.url);
    if (!artifact) return null;
    return {
      source: PAGE_SOURCE,
      v: 1,
      type: "import",
      nonce: data.nonce,
      requestId: data.requestId,
      url: artifact.url,
    };
  }
  return null;
}

const STAGES: readonly ImportStage[] = [
  "opening",
  "extracting",
  "saving",
  "connecting",
];
const FAILURES: readonly ImportFailure["code"][] = [
  "not_connected",
  "unsupported_url",
  "not_found",
  "extract_failed",
  "publish_failed",
  "busy",
  "timeout",
];

function parseResult(value: unknown): ImportSuccess | ImportFailure | null {
  if (!isObject(value)) return null;
  if (value.ok === true) {
    if (
      !text(value.title, 200) ||
      !(value.url === null || webUrl(value.url)) ||
      !webUrl(value.shelfUrl) ||
      !nullableText(value.note)
    )
      return null;
    return {
      ok: true,
      title: value.title as string,
      url: value.url as string | null,
      shelfUrl: value.shelfUrl as string,
      note: value.note as string | null,
    };
  }
  if (
    value.ok === false &&
    FAILURES.includes(value.code as ImportFailure["code"]) &&
    text(value.message)
  )
    return {
      ok: false,
      code: value.code as ImportFailure["code"],
      message: value.message as string,
    };
  return null;
}

export function parseExtensionMessage(data: unknown): ExtensionMessage | null {
  if (!isObject(data) || data.source !== EXTENSION_SOURCE || data.v !== 1)
    return null;
  if (typeof data.nonce !== "string" || !NONCE.test(data.nonce)) return null;
  const base = { source: EXTENSION_SOURCE, v: 1, nonce: data.nonce } as const;
  if (data.type === "ready" && text(data.version, 32))
    return {
      ...base,
      type: "ready",
      version: data.version as string,
      connected: data.connected === true,
    };
  if (typeof data.requestId !== "string" || !REQUEST_ID.test(data.requestId))
    return null;
  if (data.type === "progress" && STAGES.includes(data.stage as ImportStage))
    return {
      ...base,
      type: "progress",
      requestId: data.requestId,
      stage: data.stage as ImportStage,
    };
  if (data.type === "result") {
    const result = parseResult(data.result);
    return result
      ? { ...base, type: "result", requestId: data.requestId, result }
      : null;
  }
  return null;
}

/** The parts of a MessageEvent both sides check. */
export type BridgeEvent = { origin: string; source: unknown; data: unknown };

/**
 * One check for a received event: from this very window, from the expected
 * origin, well-formed, and carrying the expected nonce (when one is set).
 */
export function acceptPageEvent(
  event: BridgeEvent,
  expected: { window: unknown; origin: string; nonce: string | null },
): PageMessage | null {
  if (event.source !== expected.window || event.origin !== expected.origin)
    return null;
  const message = parsePageMessage(event.data);
  if (!message) return null;
  // «hello» sets the nonce; everything after it must carry the same one.
  if (message.type !== "hello" && message.nonce !== expected.nonce) return null;
  return message;
}

export function acceptExtensionEvent(
  event: BridgeEvent,
  expected: { window: unknown; origin: string; nonce: string },
): ExtensionMessage | null {
  if (event.source !== expected.window || event.origin !== expected.origin)
    return null;
  const message = parseExtensionMessage(event.data);
  return message && message.nonce === expected.nonce ? message : null;
}
