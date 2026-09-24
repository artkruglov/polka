// Extraction in the «На Полку» extension (extensions/chrome/src): the pure
// helpers that turn a source into a publish body, and the DOM readers run in
// a real Chrome against synthetic fixtures (tests/fixtures/extension/, written
// by hand after public descriptions of claude.ai and chatgpt.com — never
// scraped). Without Chrome the DOM part skips, as the other browser suites do.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import {
  cleanTitle,
  detectKind,
  htmlTitle,
  pickBest,
  publishBody,
  type Extracted,
} from "../extensions/chrome/src/shared/payload.ts";
import {
  matchPattern,
  normaliseOrigin,
  sameOrigin,
} from "../extensions/chrome/src/shared/origin.ts";

const JSX = `import React, { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  return (<button onClick={() => setN(n + 1)}>{n}</button>);
}`;
const TSX = `import { useState } from "react";
type Props = { start: number };
export default function Counter({ start }: Props) {
  const [n, setN] = useState<number>(start);
  return <b>{n}</b>;
}`;

const extracted = (source: string, extra: Partial<Extracted> = {}): Extracted => ({
  provider: "claude",
  title: "",
  source,
  language: null,
  via: "copy-button",
  ...extra,
});

test("source kinds: documents, components, fragments, SVG, text", () => {
  assert.equal(detectKind("<!DOCTYPE html><html><body>x</body></html>", null), "html");
  assert.equal(detectKind("<!-- note -->\n<!doctype html><p>x", null), "html");
  assert.equal(detectKind("<html><body>x</body></html>", null), "html");
  assert.equal(detectKind(JSX, null), "jsx");
  assert.equal(detectKind(TSX, null), "tsx");
  assert.equal(detectKind(JSX, "tsx"), "tsx");
  assert.equal(detectKind("const x = () => <div/>;\nexport default x;", "javascript"), "jsx");
  assert.equal(detectKind("console.log(1)", "javascript"), "text");
  assert.equal(detectKind('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>', null), "svg");
  assert.equal(detectKind("<div><h1>Hi</h1></div>", null), "html-fragment");
  assert.equal(detectKind("<p>a</p><p>b</p>", "html"), "html-fragment");
  assert.equal(detectKind("# Заголовок\n\nтекст", null), "markdown");
  assert.equal(detectKind("graph TD; A-->B", "mermaid"), "text");
});

test("publish bodies: components as source, the rest as one HTML page", () => {
  const key = randomUUID();
  assert.deepEqual(publishBody(extracted(JSX, { title: "Счётчик - Claude" }), key), {
    key,
    title: "Счётчик",
    component: JSX,
    componentLanguage: "jsx",
  });
  const tsx = publishBody(extracted(TSX), key);
  assert.equal("componentLanguage" in tsx && tsx.componentLanguage, "tsx");
  assert.equal(tsx.title, "Артефакт Claude");

  const doc = "\ufeff<!doctype html><title>Отчёт &amp; план</title><h1>x</h1>";
  const html = publishBody(extracted(doc, { title: "Claude" }), key);
  assert.deepEqual(html, { key, title: "Отчёт & план", html: doc.slice(1) });

  const text = publishBody(
    extracted("<script>alert(1)</script> & co", { provider: "chatgpt", language: "text" }),
    key,
  );
  assert.ok("html" in text);
  assert.equal(text.title, "Артефакт ChatGPT");
  assert.match(text.html, /<pre>&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co<\/pre>/);
  assert.doesNotMatch(text.html, /<script>/);

  const svg = publishBody(extracted('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>', { title: "Круг" }), key);
  assert.ok("html" in svg && svg.html.startsWith("<!doctype html>") && svg.html.includes("<circle"));
  const escapedTitle = publishBody(extracted("<div>x</div>", { title: 'A "<b>" title' }), key);
  assert.ok("html" in escapedTitle);
  assert.match(escapedTitle.html, /<title>A &quot;&lt;b&gt;&quot; title<\/title>/);
});

test("titles lose the provider's suffix, invisible characters and excess length", () => {
  assert.equal(cleanTitle("Mortgage calculator - Claude"), "Mortgage calculator");
  assert.equal(cleanTitle("Лендинг | ChatGPT"), "Лендинг");
  assert.equal(cleanTitle("ChatGPT"), "");
  assert.equal(cleanTitle("a\u202eb\u200bc"), "abc");
  assert.equal(cleanTitle("x".repeat(300)).length, 160);
  assert.equal(htmlTitle("<head><title>\n  Отчёт  &lt;Q3&gt;\n</title>"), "Отчёт <Q3>");
  assert.equal(htmlTitle("<p>no title</p>"), null);
});

test("the most trusted non-empty source wins", () => {
  const best = pickBest([
    extracted("<p>rendered</p>", { via: "frame-rendered" }),
    extracted("   ", { via: "copy-button" }),
    extracted("<p>code view</p>", { via: "code-view" }),
    null,
    extracted("<!doctype html><p>source", { via: "frame-source" }),
  ]);
  assert.equal(best?.via, "frame-source");
  assert.equal(pickBest([null, undefined]), null);
});

test("the Полка address: https, or http on this computer only", () => {
  assert.equal(normaliseOrigin(" https://polochka.app/works/1 "), "https://polochka.app");
  assert.equal(normaliseOrigin("http://127.0.0.1:6390/"), "http://127.0.0.1:6390");
  assert.equal(normaliseOrigin("http://localhost:4390"), "http://localhost:4390");
  for (const bad of ["http://polka.example", "ftp://polochka.app", "https://u:p@polochka.app", "polochka.app", ""])
    assert.equal(normaliseOrigin(bad), null, bad);
  assert.equal(matchPattern("http://127.0.0.1:6390"), "http://127.0.0.1/*");
  assert.equal(matchPattern("https://polochka.app"), "https://polochka.app/*");
  assert.equal(sameOrigin("https://polochka.app/oauth/token", "https://polochka.app"), "https://polochka.app/oauth/token");
  assert.equal(sameOrigin("https://evil.example/oauth/token", "https://polochka.app"), null);
  assert.equal(sameOrigin(42, "https://polochka.app"), null);
});

// --- The DOM readers in a real browser -------------------------------------

const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));
const skip = chromePath ? false : "Chrome is not installed here";

const fixtures = new URL("./fixtures/extension/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, fixtures), "utf8");

let server: Server;
let origin = "";
let chrome: ChildProcess | undefined;
let profile = "";
let socket: WebSocket | undefined;
let nextId = 0;
const pending = new Map<number, (message: any) => void>();
let helpers = "";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, (message) =>
      message.error ? reject(new Error(message.error.message)) : resolve(message.result),
    );
    socket!.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression: string) {
  const value = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (value.exceptionDetails)
    throw new Error(value.exceptionDetails.exception?.description ?? "evaluation failed");
  return value.result?.value;
}

/** Opens a fixture and loads the extension's DOM readers into the page. */
async function open(name: string) {
  await send("Page.navigate", { url: `${origin}/${name}` });
  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(100);
    if (await evaluate("document.readyState === 'complete'")) break;
  }
  await evaluate(helpers);
}

before(async () => {
  if (skip) return;
  // The readers as shipped, bundled from the extension's own modules.
  const bundled = await build({
    stdin: {
      contents: `
        import { inspectPage } from "./extract/page.ts";
        import { extractFrame } from "./extract/frame.ts";
        import { cleanArtifactDocument } from "./extract/dom.ts";
        import { findArtifactFrames, findShareButton } from "./extract/dom.ts";
        import { captureCopy } from "./extract/copy-capture.ts";
        import { captureDownload } from "./extract/download-capture.ts";
        // As chrome.scripting ships a func: its source text, rebuilt in the page.
        const captureSource = captureCopy.toString();
        const downloadSource = captureDownload.toString();
        globalThis.__test = {
          inspectPage, extractFrame, cleanArtifactDocument, findArtifactFrames,
          findShareButton, captureSource, downloadSource,
        };`,
      resolveDir: path.resolve("extensions/chrome/src"),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    target: "chrome116",
    write: false,
  });
  helpers = bundled.outputFiles[0].text;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const name = url.pathname.slice(1);
    let html: string;
    try {
      html = fixture(name.replace(/^frame-without-csp\.html$/, "claude-artifact-frame.html"));
    } catch {
      response.writeHead(404).end();
      return;
    }
    // The same frame without the viewer's CSP meta: its own fetch succeeds.
    if (name === "frame-without-csp.html")
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  profile = mkdtempSync(path.join(tmpdir(), "polka-ext-chrome-"));
  chrome = spawn(
    chromePath!,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited: number | null = null;
  chrome.once("exit", (code) => (exited = code ?? -1));
  const deadline = Date.now() + 45_000;
  let port = 0;
  let targets: any[] = [];
  while (Date.now() < deadline && exited === null) {
    try {
      port ||= Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (port) {
        targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
        if (targets.some((target) => target.type === "page")) break;
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      }
    } catch {
      /* not listening yet */
    }
    await wait(250);
  }
  const target = targets.find((item) => item.type === "page");
  assert.ok(target, exited === null ? "Chrome did not open a page within 45 s" : `Chrome exited (${exited})`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket!.addEventListener("open", resolve);
    socket!.addEventListener("error", reject);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  });
  await send("Page.enable");
  await send("Network.enable");
  // The fixtures name the provider's hosts; nothing may leave this machine.
  await send("Network.setBlockedURLs", { urls: ["*claudeusercontent.com*", "*claude.ai*", "*chatgpt.com*"] });
});

after(async () => {
  socket?.close();
  chrome?.kill("SIGKILL");
  await new Promise((resolve) => (chrome ? chrome.once("exit", resolve) : resolve(null)));
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test("Claude chat: the panel's title and Copy button, not the message's", { skip }, async () => {
  await open("claude-chat-artifact.html");
  const report = await evaluate(`__test.inspectPage(document, "claude.ai", "/chat/1")`);
  assert.equal(report.provider, "claude");
  assert.equal(report.title, "Калькулятор ипотеки");
  assert.equal(report.frames, 1);
  assert.equal(report.signIn, false);
  assert.match(report.copyMarker, /^[0-9a-f]{24}$/);
  // With a Copy button there is no need to go through a menu.
  assert.equal(report.menuMarker, null);
  assert.equal(
    await evaluate(`document.querySelector("[data-polka-copy]").id`),
    "artifact-copy",
  );
  // The MAIN-world capture, serialised as chrome.scripting does it.
  const capture = (marker: string, ms: number) =>
    evaluate(
      `new Function("return (" + __test.captureSource + ")")()(${JSON.stringify(marker)}, ${ms})`,
    );
  const copied = await capture(report.copyMarker, 2000);
  assert.match(copied, /^import React, \{ useState \} from "react";/);
  assert.match(copied, /export default function Mortgage/);
  // The page's own Copy flow ran (it relabels itself) and everything is put back.
  assert.equal(await evaluate(`document.getElementById("artifact-copy").textContent`), "Copied");
  assert.equal(await evaluate(`document.querySelector("[data-polka-copy]")`), null);
  assert.equal(
    await evaluate(`Object.prototype.hasOwnProperty.call(navigator.clipboard, "writeText")`),
    false,
  );
  // A stale or unknown marker presses nothing.
  assert.equal(await capture("nope", 100), null);
});

test("Claude code view: CodeMirror lines joined, language from the panel", { skip }, async () => {
  await open("claude-code-view.html");
  const report = await evaluate(`__test.inspectPage(document, "claude.ai", "/chat/1")`);
  assert.equal(report.frames, 0);
  assert.equal(report.copyMarker, null);
  assert.equal(report.code.language, "html");
  assert.equal(
    report.code.source,
    [
      "<!doctype html>",
      "<html><head><title>Отчёт о продажах</title></head>",
      "<body><h1>Продажи за квартал</h1></body>",
      "</html>",
    ].join("\n"),
  );
});

test("artifact frame: the page's own bytes without the viewer runtime", { skip }, async () => {
  await open("frame-without-csp.html");
  const report = await evaluate(`__test.extractFrame({ anyHost: true })`);
  assert.equal(report.via, "frame-source");
  assert.equal(report.title, "Трекер привычек");
  assert.doesNotMatch(report.html, /claudeusercontent|__claude-bridge|Content-Security-Policy/);
  assert.match(report.html, /^<!doctype html>\n<html lang="ru">/);
  assert.match(report.html, /classList\.toggle\("done"\)/);
  assert.match(report.html, /<style>body \{ font: 16px system-ui; \}/);
  // Outside the artifact host the frame reader answers nothing.
  assert.equal(await evaluate(`__test.extractFrame()`), null);
});

test("artifact frame under the viewer's CSP: the rendered document, cleaned", { skip }, async () => {
  await open("claude-artifact-frame.html");
  const report = await evaluate(`__test.extractFrame({ anyHost: true })`);
  assert.equal(report.via, "frame-rendered");
  assert.doesNotMatch(report.html, /claudeusercontent|__claude-bridge|Content-Security-Policy/);
  assert.match(report.html, /<li>Зарядка<\/li>/);
});

test("ChatGPT: the last code block of the last answer", { skip }, async () => {
  await open("chatgpt-conversation.html");
  const report = await evaluate(`__test.inspectPage(document, "chatgpt.com", "/c/1")`);
  assert.equal(report.provider, "chatgpt");
  assert.equal(report.code.language, "html");
  assert.match(report.code.source, /^<!doctype html>/);
  assert.match(report.code.source, /<button>Купить<\/button>/);
  assert.doesNotMatch(report.code.source, /Copy code|Старая версия/);
  assert.equal(report.title, "Landing page draft");
});

test("a provider's sign-in page is recognised, other hosts are not read", { skip }, async () => {
  await open("claude-code-view.html");
  assert.equal((await evaluate(`__test.inspectPage(document, "claude.ai", "/login")`)).signIn, true);
  assert.equal((await evaluate(`__test.inspectPage(document, "example.org", "/")`)).provider, null);
});

/** The page's originals, to check the capture puts every one of them back. */
const REMEMBER_ORIGINALS = `window.__originals = [
  URL.createObjectURL, HTMLAnchorElement.prototype.click,
  EventTarget.prototype.dispatchEvent, window.open,
]`;
const ORIGINALS_BACK = `(() => {
  const now = [URL.createObjectURL, HTMLAnchorElement.prototype.click,
    EventTarget.prototype.dispatchEvent, window.open];
  return now.every((value, index) => value === window.__originals[index]);
})()`;
const downloadCapture = (marker: string, ms = 3000) =>
  evaluate(
    `new Function("return (" + __test.downloadSource + ")")()(${JSON.stringify(marker)}, ${ms})`,
  );

test("standalone artifact page: title menu → Export → Download, read and never saved", { skip }, async () => {
  await open("claude-artifact-page.html");
  await evaluate(REMEMBER_ORIGINALS);
  const report = await evaluate(`__test.inspectPage(document, "claude.ai", "/artifact/0f6e1b2a")`);
  assert.equal(report.provider, "claude");
  assert.equal(report.title, "Трекер привычек");
  assert.equal(report.copyMarker, null);
  assert.equal(report.code, null);
  // The content frame counts; the hidden 1×1 helper frame does not.
  assert.equal(report.frames, 1);
  assert.match(report.menuMarker, /^[0-9a-f]{24}$/);
  assert.equal(await evaluate(`document.querySelector("[data-polka-menu]").id`), "title");

  const captured = await downloadCapture(report.menuMarker);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.filename, "habit-tracker.html");
  assert.equal(captured.type, "text/html");
  assert.equal(captured.text, await evaluate("SOURCE"));
  // No click reached the a[download], the Markdown copy was not pressed, the
  // menu is closed, the marker is gone and the page's functions are its own.
  assert.equal(await evaluate("window.__downloadClicks"), 0);
  assert.equal(await evaluate("window.__markdownCopied"), false);
  assert.equal(await evaluate(`document.querySelector('[role="menu"]')`), null);
  assert.equal(await evaluate("window.__closedBy"), "escape-in-menu");
  assert.equal(await evaluate(`document.querySelector("[data-polka-menu]")`), null);
  assert.equal(await evaluate(ORIGINALS_BACK), true);
  // The page carried on after its click as usual (it revokes the URL).
  assert.equal(await evaluate("window.__revoked"), 1);
  // A stale marker opens nothing.
  assert.deepEqual(await downloadCapture("nope", 200), { ok: false, reason: "no_menu" });
});

test("the fixture's menu is as stubborn as the real one: no pointer, no Enter", { skip }, async () => {
  await open("claude-artifact-page.html");
  await evaluate(`(() => {
    const title = document.getElementById("title");
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      title.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, button: 0, buttons: 1 }));
    title.focus();
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  })()`);
  await wait(300);
  assert.equal(await evaluate(`document.querySelector('[role="menu"]')`), null);
  await evaluate(`document.getElementById("title").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))`);
  await wait(300);
  assert.notEqual(await evaluate(`document.querySelector('[role="menu"]')`), null);
  // A document-level Escape leaves it open.
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.notEqual(await evaluate(`document.querySelector('[role="menu"]')`), null);
});

test("without data attributes the items are found by role and text", { skip }, async () => {
  await open("claude-artifact-page.html?plain=1");
  await evaluate(REMEMBER_ORIGINALS);
  const report = await evaluate(`__test.inspectPage(document, "claude.ai", "/artifact/0f6e1b2a")`);
  assert.equal(report.title, "Трекер привычек");
  const captured = await downloadCapture(report.menuMarker);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.text, await evaluate("SOURCE"));
  assert.equal(await evaluate("window.__downloadClicks"), 0);
  assert.equal(await evaluate(ORIGINALS_BACK), true);
});

test("menus that ignore Escape are closed by an outside press", { skip }, async () => {
  await open("claude-artifact-page.html?noescape=1");
  const report = await evaluate(`__test.inspectPage(document, "claude.ai", "/artifact/0f6e1b2a")`);
  const captured = await downloadCapture(report.menuMarker);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(await evaluate(`document.querySelector('[role="menu"]')`), null);
  assert.equal(await evaluate("window.__closedBy"), "outside");
});

test("a Download that would fetch a server URL is stopped; the frame is next", { skip }, async () => {
  await open("claude-artifact-page.html?server=1");
  await evaluate(REMEMBER_ORIGINALS);
  const report = await evaluate(`__test.inspectPage(document, "claude.ai", "/artifact/0f6e1b2a")`);
  const captured = await downloadCapture(report.menuMarker);
  assert.deepEqual(captured, { ok: false, reason: "navigation" });
  assert.equal(await evaluate("window.__downloadClicks"), 0);
  assert.equal(await evaluate("location.pathname"), "/claude-artifact-page.html");
  assert.equal(await evaluate(`document.querySelector('[role="menu"]')`), null);
  assert.equal(await evaluate(ORIGINALS_BACK), true);
});

test("the page button's anchor on an artifact page is the Share button", { skip }, async () => {
  await open("claude-artifact-page.html");
  assert.match(
    await evaluate(`__test.findShareButton(document).getAttribute("aria-label")`),
    /^Share, shared with anyone/,
  );
  // The menu path is for standalone artifact pages only, never a chat's menus.
  assert.equal(
    (await evaluate(`__test.inspectPage(document, "claude.ai", "/chat/1")`)).menuMarker,
    null,
  );
  assert.equal(
    await evaluate(`__test.findArtifactFrames(document).map((f) => f.title).join("|")`),
    "User-generated artifact content",
  );
});
