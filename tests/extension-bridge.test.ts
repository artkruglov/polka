// The postMessage bridge between Полка's page and the «На Полку» extension
// (packages/contracts/extension-bridge.ts): the protocol checks, and both real
// halves talking through a stand-in window — the page's findExtension
// (tests/fixtures/extension-page.ts, the reference page half) and the extension's
// content script (extensions/chrome/src/content/bridge.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptExtensionEvent,
  acceptPageEvent,
  EXTENSION_SOURCE,
  importableArtifact,
  PAGE_SOURCE,
  parseExtensionMessage,
  parsePageMessage,
} from "../packages/contracts/extension-bridge.ts";
import { findExtension } from "./fixtures/extension-page.ts";

const ORIGIN = "https://polochka.app";
const NONCE = "n0nce-n0nce-n0nce-n0nce";
const ARTIFACT = "https://claude.ai/artifact/0f6e1b2a-4c3d-4e5f-9a8b-7c6d5e4f3a2b";

type Listener = (event: { data: unknown; origin: string; source: unknown }) => void;

/** A window whose postMessage delivers to its own listeners, as a browser does. */
function fakeWindow(origin: string) {
  const listeners = new Set<Listener>();
  const win: any = {
    location: { origin },
    addEventListener(type: string, listener: Listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.delete(listener);
    },
    postMessage(data: unknown, targetOrigin: string) {
      if (targetOrigin !== origin) return;
      const event = { data: structuredClone(data), origin, source: win };
      setTimeout(() => listeners.forEach((listener) => listener(event)), 0);
    },
    /** A message from somewhere else: another frame, another origin. */
    inject(event: { data: unknown; origin: string; source: unknown }) {
      listeners.forEach((listener) => listener(event));
    },
    listenerCount: () => listeners.size,
  };
  win.top = win;
  return win;
}

test("only Claude and ChatGPT artifact links are importable, normalised", () => {
  for (const url of [
    ARTIFACT,
    "https://claude.ai/public/artifacts/8b241cc8-6938-4ace-97f0-05fa098b296c",
    "https://claude.ai/code/artifact/5fbea6f3-1111-2222-3333-444455556666",
    "https://claude.ai/chat/5fbea6f3-1111-2222-3333-444455556666",
    "https://chatgpt.com/canvas/shared/68a0c1d2e3f4",
    "https://chatgpt.com/share/68a0c1d2-e3f4-5678-9abc-def012345678",
  ])
    assert.ok(importableArtifact(url), url);
  assert.deepEqual(importableArtifact(`  ${ARTIFACT}#frag  `), {
    provider: "claude",
    url: ARTIFACT,
  });
  for (const url of [
    ARTIFACT.replace("https:", "http:"),
    ARTIFACT.replace("claude.ai", "claude.ai.evil.example"),
    ARTIFACT.replace("claude.ai", "evil.example"),
    ARTIFACT.replace("https://", "https://user:pw@"),
    ARTIFACT.replace("claude.ai", "claude.ai:8443"),
    "https://claude.ai/settings/profile",
    "https://claude.ai/artifact/../../settings",
    "https://claude.ai/artifact/abc",
    "https://chat.openai.com/share/68a0c1d2e3f4",
    "javascript:alert(1)",
    "https://polochka.app/s#x",
    42,
    null,
  ])
    assert.equal(importableArtifact(url), null, String(url));
});

test("page messages: exact shape, nonce, an importable URL", () => {
  assert.deepEqual(parsePageMessage({ source: PAGE_SOURCE, v: 1, type: "hello", nonce: NONCE }), {
    source: PAGE_SOURCE,
    v: 1,
    type: "hello",
    nonce: NONCE,
  });
  const imported = parsePageMessage({
    source: PAGE_SOURCE,
    v: 1,
    type: "import",
    nonce: NONCE,
    requestId: "req-12345678",
    url: ARTIFACT,
    extra: "ignored",
  });
  assert.deepEqual(imported, {
    source: PAGE_SOURCE,
    v: 1,
    type: "import",
    nonce: NONCE,
    requestId: "req-12345678",
    url: ARTIFACT,
  });
  for (const data of [
    null,
    "hello",
    { source: PAGE_SOURCE, v: 2, type: "hello", nonce: NONCE },
    { source: EXTENSION_SOURCE, v: 1, type: "hello", nonce: NONCE },
    { source: PAGE_SOURCE, v: 1, type: "hello", nonce: "short" },
    { source: PAGE_SOURCE, v: 1, type: "hello", nonce: `${NONCE}<script>` },
    { source: PAGE_SOURCE, v: 1, type: "import", nonce: NONCE, requestId: "req-12345678", url: "https://evil.example/" },
    { source: PAGE_SOURCE, v: 1, type: "import", nonce: NONCE, requestId: "x", url: ARTIFACT },
    { source: PAGE_SOURCE, v: 1, type: "open-tab", nonce: NONCE, url: ARTIFACT },
  ])
    assert.equal(parsePageMessage(data), null, JSON.stringify(data));
});

test("extension messages: results carry only web links and bounded text", () => {
  const ok = {
    source: EXTENSION_SOURCE,
    v: 1,
    type: "result",
    nonce: NONCE,
    requestId: "req-12345678",
    result: {
      ok: true,
      title: "Калькулятор",
      url: "https://polochka.app/s#abc",
      shelfUrl: "https://polochka.app/works/1",
      note: null,
    },
  };
  assert.ok(parseExtensionMessage(ok));
  for (const result of [
    { ...ok.result, url: "javascript:alert(1)" },
    { ...ok.result, shelfUrl: "data:text/html,x" },
    { ...ok.result, title: "x".repeat(201) },
    { ok: false, code: "whatever", message: "x" },
    { ok: false, code: "timeout", message: "x".repeat(501) },
  ])
    assert.equal(parseExtensionMessage({ ...ok, result }), null, JSON.stringify(result));
  assert.ok(
    parseExtensionMessage({ ...ok, result: { ok: false, code: "not_connected", message: "Подключите" } }),
  );
  assert.equal(
    parseExtensionMessage({ ...ok, type: "progress", stage: "exfiltrating" }),
    null,
  );
});

test("an event counts only from this window, this origin, with the nonce", () => {
  const win = {};
  const hello = { source: PAGE_SOURCE, v: 1, type: "hello", nonce: NONCE };
  const importing = { ...hello, type: "import", requestId: "req-12345678", url: ARTIFACT };
  const expected = { window: win, origin: ORIGIN, nonce: null };
  assert.ok(acceptPageEvent({ origin: ORIGIN, source: win, data: hello }, expected));
  assert.equal(acceptPageEvent({ origin: "https://evil.example", source: win, data: hello }, expected), null);
  assert.equal(acceptPageEvent({ origin: ORIGIN, source: {}, data: hello }, expected), null);
  // No hello yet: no import is accepted.
  assert.equal(acceptPageEvent({ origin: ORIGIN, source: win, data: importing }, expected), null);
  assert.ok(acceptPageEvent({ origin: ORIGIN, source: win, data: importing }, { ...expected, nonce: NONCE }));
  assert.equal(
    acceptPageEvent(
      { origin: ORIGIN, source: win, data: importing },
      { ...expected, nonce: "another-nonce-another-nonce" },
    ),
    null,
  );
  const ready = { source: EXTENSION_SOURCE, v: 1, type: "ready", nonce: NONCE, version: "0.1.0", connected: true };
  assert.ok(acceptExtensionEvent({ origin: ORIGIN, source: win, data: ready }, { window: win, origin: ORIGIN, nonce: NONCE }));
  assert.equal(
    acceptExtensionEvent(
      { origin: ORIGIN, source: win, data: ready },
      { window: win, origin: ORIGIN, nonce: "another-nonce-another-nonce" },
    ),
    null,
  );
});

test("no extension: the page gives up quietly", async () => {
  const win = fakeWindow(ORIGIN);
  const found = await findExtension(win, { timeoutMs: 100 });
  assert.equal(found, null);
  assert.equal(win.listenerCount(), 0);
});

// The real content script on a stand-in page, with a stand-in service worker.
let win: any;
const sent: any[] = [];
let toContentScript: ((message: unknown) => void) | null = null;
let importAnswer: (message: any) => Promise<unknown>;

before(async () => {
  win = fakeWindow(ORIGIN);
  (globalThis as any).window = win;
  (globalThis as any).location = win.location;
  (globalThis as any).chrome = {
    runtime: {
      async sendMessage(message: any) {
        sent.push(message);
        if (message.type === "bridge-status") return { connected: true, version: "0.1.0" };
        if (message.type === "bridge-import") return importAnswer(message);
        return null;
      },
      onMessage: {
        addListener(listener: (message: unknown) => void) {
          toContentScript = listener;
        },
      },
    },
  };
  await import("../extensions/chrome/src/content/bridge.ts");
});

after(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).location;
  delete (globalThis as any).chrome;
});

test("handshake and import through the real bridge: progress, then one result", async () => {
  const saved = {
    ok: true,
    title: "Калькулятор",
    url: `${ORIGIN}/s#abcdef`,
    shelfUrl: `${ORIGIN}/works/42`,
    note: null,
  };
  importAnswer = async (message) => {
    // The worker reports stages to the tab while it works.
    toContentScript!({ type: "bridge-progress", requestId: message.requestId, stage: "opening" });
    toContentScript!({ type: "bridge-progress", requestId: message.requestId, stage: "saving" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return saved;
  };
  const link = await findExtension(win, { timeoutMs: 1000 });
  assert.ok(link);
  assert.equal(link.version, "0.1.0");
  assert.equal(link.connected, true);

  // Forged answers do not reach the page: another frame, another origin.
  const stages: string[] = [];
  const pending = link.importArtifact(ARTIFACT, (stage) => stages.push(stage));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const imports = sent.filter((message) => message.type === "bridge-import");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].url, ARTIFACT);
  const forged = {
    source: EXTENSION_SOURCE,
    v: 1,
    type: "result",
    requestId: imports[0].requestId,
    result: { ...saved, url: "https://evil.example/phish" },
  };
  for (const nonce of ["guessed-nonce-guessed-nonce"]) {
    win.inject({ origin: ORIGIN, source: win, data: { ...forged, nonce } });
  }
  win.inject({ origin: ORIGIN, source: {}, data: { ...forged, nonce: "x" } });
  win.inject({ origin: "https://evil.example", source: win, data: forged });

  const result = await pending;
  assert.deepEqual(result, saved);
  assert.deepEqual(stages, ["opening", "saving"]);
  link.close();
});

test("the bridge ignores imports without the page's nonce or from elsewhere", async () => {
  const before = sent.filter((message) => message.type === "bridge-import").length;
  const importing = {
    source: PAGE_SOURCE,
    v: 1,
    type: "import",
    requestId: "req-12345678",
    url: ARTIFACT,
  };
  // A frame inside the page, a foreign origin, a guessed nonce.
  win.inject({ origin: ORIGIN, source: {}, data: { ...importing, nonce: NONCE } });
  win.inject({ origin: "https://evil.example", source: win, data: { ...importing, nonce: NONCE } });
  win.inject({ origin: ORIGIN, source: win, data: { ...importing, nonce: "guessed-nonce-guessed-nonce" } });
  // Not an artifact link, even with a well-formed message.
  win.inject({ origin: ORIGIN, source: win, data: { ...importing, url: "https://evil.example/", nonce: NONCE } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.filter((message) => message.type === "bridge-import").length, before);
});
