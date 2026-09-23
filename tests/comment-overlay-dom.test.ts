// The comment overlay in a real Chrome (docs/specs/COMMENTS.md, «Приёмка»).
// A parent page on one origin plays Полка's shell; the frame on another
// origin is served exactly as the viewer serves it: the same CSP, sandbox,
// link rewriting and overlay injection (html.ts, comment-overlay.ts).
//
// Static view with comments: only the overlay runs. The page's own
// <script>, inline handlers and javascript: URLs do not; fetch and WebRTC
// stay blocked for the overlay too; the overlay listens only to its parent
// with the expected origin. Without Chrome (CI images have none) it skips.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  overlayNonce,
  withLiveOverlay,
  withStaticOverlay,
} from "../apps/server/comment-overlay.ts";
import {
  LIVE_VIEWER_SANDBOX,
  STATIC_HTML_SANDBOX,
  STATIC_OVERLAY_SANDBOX,
  liveViewerCsp,
  staticHtmlCsp,
  withNewTabLinks,
} from "../apps/server/html.ts";

const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));
const skip = chromePath ? false : "Chrome is not installed here";

let server: Server;
let viewerServer: Server;
let port = 0;
let viewerPort = 0;
// Two origins (two ports of the loopback): the shell and the viewer.
const shell = () => `http://127.0.0.1:${port}`;
const viewer = () => `http://127.0.0.1:${viewerPort}`;
const hits: string[] = [];

const HOSTILE = `<!doctype html><html><head><title>t</title>
<script>window.pageRan = 1; document.title = "ran";</script></head>
<body><h1>Отчёт</h1><p id="p">Выручка выросла на 12%. Итоги квартала.</p>
<p>Выручка выросла на 12%. Повтор.</p>
<button id="b" onclick="window.clicked = 1">x</button>
<img src="data:," onerror="window.errored = 1">
<a id="j" href="javascript:window.js = 1">j</a>
<img name="body"><img name="createTreeWalker"><img name="addEventListener">
<form name="f"><input name="insertBefore"><input name="nodeType"></form>
<noscript><p id="ns">Без скриптов</p></noscript>
<svg><animate onbegin="window.svg = 1" attributeName="x" dur="1s"/></svg>
<script>window.later = 1</script></body></html>`;

const LIVE = `<!doctype html><html><head><title>live</title></head><body>
<div id="root"></div>
<script>window.pageRan = 1; document.getElementById("root").textContent = "Интерактивный отчёт: выручка выросла.";</script>
</body></html>`;

const frames = new Map<string, { body: Buffer; csp: string }>();

/** The shell: frames one viewer URL and records what reaches it. */
function parentPage(frame: string, sandbox: string) {
  return `<!doctype html><html><body><script>
window.messages = [];
window.addEventListener("message", (event) => {
  window.messages.push({ origin: event.origin, fromFrame: event.source === document.querySelector("iframe").contentWindow, data: event.data });
});
window.toFrame = (message) => document.querySelector("iframe").contentWindow.postMessage(message, "*");
</script><iframe src="${frame}" sandbox="${sandbox}" style="width:800px;height:600px"></iframe></body></html>`;
}

let chrome: ChildProcess | undefined;
let profile = "";
let socket: WebSocket | undefined;
let nextId = 0;
const pending = new Map<number, (message: any) => void>();
const contexts: Array<{ id: number; frameId: string; isDefault: boolean }> = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome puts a sandboxed frame in its own process: it is a separate target
// the page session auto-attaches to (flat sessions), not a child frame.
const frameSessions: string[] = [];

function send(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, (message) =>
      message.error
        ? reject(new Error(message.error.message))
        : resolve(message.result),
    );
    socket!.send(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
  });
}

async function evaluate(
  expression: string,
  contextId?: number,
  sessionId?: string,
) {
  const value = await send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId ? { contextId } : {}),
    },
    sessionId,
  );
  if (value.exceptionDetails)
    throw new Error(
      value.exceptionDetails.exception?.description ?? "evaluation failed",
    );
  return value.result?.value;
}

/** Opens the shell around one frame; returns evaluators for both. */
async function open(frame: string, sandbox: string) {
  const name = `/parent-${frames.size}-${Date.now()}`;
  frames.set(name, {
    body: Buffer.from(parentPage(`${viewer()}${frame}`, sandbox)),
    csp: "",
  });
  contexts.length = 0;
  frameSessions.length = 0;
  await send("Page.navigate", { url: `${shell()}${name}` });
  // Either an out-of-process frame target, or a child frame of the page.
  let session: string | undefined;
  let child: string | undefined;
  for (let attempt = 0; attempt < 50 && !session && !child; attempt++) {
    await wait(100);
    session = frameSessions.at(-1);
    const tree = await send("Page.getFrameTree");
    child = tree.frameTree.childFrames?.[0]?.frame?.id;
  }
  assert.ok(session || child, "the frame did not load");
  let context: number | undefined;
  if (!session)
    for (let attempt = 0; attempt < 50 && !context; attempt++) {
      await wait(100);
      context = contexts.find(
        (item) => item.frameId === child && item.isDefault,
      )?.id;
    }
  assert.ok(session || context, "no execution context for the frame");
  await wait(600);
  return {
    parent: (expression: string) => evaluate(expression),
    frame: (expression: string) => evaluate(expression, context, session),
  };
}

before(async () => {
  if (skip) return;
  const handler = (request: any, response: any) => {
    const url = request.url ?? "";
    hits.push(url);
    const page = frames.get(url.split("?")[0]!);
    if (!page) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(page.csp ? { "content-security-policy": page.csp } : {}),
    });
    response.end(page.body);
  };
  server = createServer(handler);
  viewerServer = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) =>
    viewerServer.listen(0, "127.0.0.1", resolve),
  );
  port = (server.address() as { port: number }).port;
  viewerPort = (viewerServer.address() as { port: number }).port;
  profile = mkdtempSync(path.join(tmpdir(), "polka-chrome-overlay-"));
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
  let debugPort = 0;
  let targets: any[] = [];
  while (Date.now() < deadline && exited === null) {
    try {
      debugPort ||= Number(
        readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(
          "\n",
        )[0],
      );
      if (debugPort) {
        targets = (await (
          await fetch(`http://127.0.0.1:${debugPort}/json`)
        ).json()) as any[];
        if (targets.some((target) => target.type === "page")) break;
        await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
          method: "PUT",
        });
      }
    } catch {
      /* not listening yet */
    }
    await wait(250);
  }
  const target = targets.find((item) => item.type === "page");
  assert.ok(target, "Chrome did not open a page target");
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
    } else if (
      message.method === "Runtime.executionContextCreated" &&
      !message.sessionId
    ) {
      const context = message.params.context;
      contexts.push({
        id: context.id,
        frameId: context.auxData?.frameId,
        isDefault: !!context.auxData?.isDefault,
      });
    } else if (
      message.method === "Target.attachedToTarget" &&
      message.params.targetInfo.type === "iframe"
    ) {
      const sessionId = message.params.sessionId as string;
      void send("Runtime.enable", {}, sessionId)
        .then(() => send("Runtime.runIfWaitingForDebugger", {}, sessionId))
        .then(() => frameSessions.push(sessionId))
        .catch(() => {});
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
});

after(async () => {
  socket?.close();
  if (chrome) {
    const ended = new Promise((resolve) => chrome!.once("exit", resolve));
    chrome.kill();
    await Promise.race([ended, wait(5_000)]);
  }
  for (const each of [server, viewerServer])
    await new Promise<void>(
      (resolve) => each?.close(() => resolve()) ?? resolve(),
    );
  try {
    if (profile) rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the OS cleans the temp directory */
  }
});

/** Serves `html` as the viewer's static view, with or without the overlay. */
function staticFrame(html: string, overlay: boolean, appOrigin = shell()) {
  const name = `/static-${frames.size}`;
  const page = withNewTabLinks(Buffer.from(html));
  const nonce = overlay ? overlayNonce() : undefined;
  frames.set(name, {
    body: nonce ? withStaticOverlay(page, appOrigin, nonce) : page,
    csp: staticHtmlCsp(shell(), nonce),
  });
  return name;
}

const fromFrame = (expression: string) =>
  `window.messages.filter((m) => m.fromFrame)${expression}`;

test(
  "static view with comments: only the overlay runs, the page's scripts and handlers do not",
  { skip },
  async () => {
    const { parent, frame } = await open(
      staticFrame(HOSTILE, true),
      STATIC_OVERLAY_SANDBOX,
    );
    // The overlay announced itself to the shell, from the opaque origin.
    assert.deepEqual(
      await parent(fromFrame(".map((m) => [m.origin, m.data.type])[0]")),
      ["null", "polka:ready"],
    );
    // The page's own script, inline handlers, javascript: URLs: nothing ran.
    assert.equal(await frame("typeof window.pageRan"), "undefined");
    assert.equal(await frame("typeof window.later"), "undefined");
    assert.equal(await frame("document.title"), "t");
    assert.equal(await frame("typeof window.errored"), "undefined");
    await frame("document.getElementById('b').click()");
    assert.equal(await frame("typeof window.clicked"), "undefined");
    await frame(
      "HTMLAnchorElement.prototype.click.call(document.getElementById('j'))",
    );
    await wait(200);
    assert.equal(await frame("typeof window.js"), "undefined");
    assert.equal(await frame("typeof window.svg"), "undefined");
    // A script the page (or anyone) adds later has no nonce: blocked.
    await frame(
      "(() => { const s = document.createElement('script'); s.textContent = 'window.injected = 1'; document.head.appendChild(s); })()",
    );
    assert.equal(await frame("typeof window.injected"), "undefined");
    // No network and no WebRTC, for the overlay's realm too.
    const before = hits.length;
    assert.equal(
      await frame(
        `fetch(${JSON.stringify(`${shell()}/probe`)}).then(() => "reached", (e) => e.name)`,
      ),
      "TypeError",
    );
    assert.equal(await frame("typeof RTCPeerConnection"), "undefined");
    assert.equal(await frame("typeof webkitRTCPeerConnection"), "undefined");
    assert.ok(!hits.slice(before).some((hit) => hit.startsWith("/probe")));
    // Still an opaque origin without cookies.
    assert.equal(await frame("self.origin"), "null");
    // <noscript> reads as it did without scripts.
    assert.equal(
      await frame("document.getElementById('ns')?.textContent"),
      "Без скриптов",
    );
  },
);

test(
  "static view with comments: anchors paint and resolve, the selection reaches the shell",
  { skip },
  async () => {
    const { parent, frame } = await open(
      staticFrame(HOSTILE, true),
      STATIC_OVERLAY_SANDBOX,
    );
    await parent(`window.toFrame({ type: "polka:anchors", anchors: [
      { id: "a1", exact: "Выручка выросла на 12%.", prefix: "", suffix: " Итоги" },
      { id: "dup", exact: "Выручка выросла на 12%.", prefix: "", suffix: "" },
      { id: "gone", exact: "Этого текста нет", prefix: "", suffix: "" }
    ] })`);
    await wait(500);
    assert.deepEqual(
      await parent(
        fromFrame(
          ".filter((m) => m.data.type === 'polka:resolved').at(-1).data.missing",
        ),
      ),
      ["dup", "gone"],
    );
    const positions = await parent(
      fromFrame(
        ".filter((m) => m.data.type === 'polka:positions').at(-1).data.positions",
      ),
    );
    assert.deepEqual(Object.keys(positions), ["a1"]);
    assert.ok(positions.a1 > 0);
    // Painted with the CSS Highlight API: no element of the page changed.
    assert.equal(await frame("CSS.highlights.get('polka-d1')?.size"), 1);
    assert.equal(
      await frame("document.getElementById('p').childNodes.length"),
      1,
    );
    // The reader selects text: the shell gets the quote and its context.
    await frame(`(() => {
      const text = document.getElementById("p").firstChild;
      const range = document.createRange();
      range.setStart(text, 8);
      range.setEnd(text, 22);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
    await wait(500);
    const selection = await parent(
      fromFrame(
        ".filter((m) => m.data.type === 'polka:selection').at(-1).data",
      ),
    );
    assert.equal(selection.anchor.exact, "выросла на 12%");
    assert.equal(selection.anchor.prefix.endsWith("Отчёт" + "Выручка "), true);
    assert.equal(selection.anchor.suffix.startsWith(". Итоги"), true);
    assert.ok(selection.rect.bottom > selection.rect.top);
    await parent(`window.toFrame({ type: "polka:clearSelection" })`);
    await wait(100);
    assert.equal(await frame("getSelection().isCollapsed"), true);
  },
);

test(
  "the overlay listens only to its parent from the expected origin",
  { skip },
  async () => {
    // An overlay that expects another shell origin: its messages are never
    // delivered here, and it ignores this parent's messages.
    const { parent, frame } = await open(
      staticFrame(HOSTILE, true, "http://polka.invalid"),
      STATIC_OVERLAY_SANDBOX,
    );
    assert.equal(await parent(fromFrame(".length")), 0, JSON.stringify(await parent("window.messages")));
    await parent(`window.toFrame({ type: "polka:anchors", anchors: [
      { id: "a1", exact: "Итоги квартала.", prefix: "", suffix: "" }
    ] })`);
    await wait(300);
    assert.equal(await frame("CSS.highlights.get('polka-d1')?.size ?? 0"), 0);
    // A message forged inside the frame (not trusted, not from the parent)
    // is ignored by the overlay of the expected origin too.
    const real = await open(staticFrame(HOSTILE, true), STATIC_OVERLAY_SANDBOX);
    await real.frame(`(() => {
      try {
        window.dispatchEvent(new MessageEvent("message", {
          data: { type: "polka:anchors", anchors: [{ id: "x", exact: "Итоги квартала.", prefix: "", suffix: "" }] },
          origin: ${JSON.stringify(shell())},
        }));
      } catch (e) {}
    })()`);
    await wait(300);
    assert.equal(
      await real.frame("CSS.highlights.get('polka-d1')?.size ?? 0"),
      0,
    );
  },
);

test(
  "the static view without comments runs nothing at all",
  { skip },
  async () => {
    const { parent, frame } = await open(
      staticFrame(HOSTILE, false),
      STATIC_HTML_SANDBOX,
    );
    assert.equal(await parent(fromFrame(".length")), 0);
    assert.equal(await frame("document.title"), "t");
    assert.equal(await frame("typeof window.pageRan"), "undefined");
  },
);

test(
  "live view with comments: guard first, overlay next, then the page",
  { skip },
  async () => {
    const name = `/live-${frames.size}`;
    frames.set(name, {
      body: withLiveOverlay(Buffer.from(LIVE), shell()),
      csp: liveViewerCsp(shell()),
    });
    const { parent, frame } = await open(name, LIVE_VIEWER_SANDBOX);
    assert.equal(await frame("window.pageRan"), 1);
    assert.equal(await frame("typeof RTCPeerConnection"), "undefined");
    assert.equal(
      await frame(
        `fetch(${JSON.stringify(`${shell()}/probe-live`)}).then(() => "reached", (e) => e.name)`,
      ),
      "TypeError",
    );
    await parent(`window.toFrame({ type: "polka:anchors", anchors: [
      { id: "a1", exact: "выручка выросла", prefix: "", suffix: "" }
    ] })`);
    await wait(500);
    assert.deepEqual(
      await parent(
        fromFrame(
          ".filter((m) => m.data.type === 'polka:resolved').at(-1).data.missing",
        ),
      ),
      [],
    );
    assert.equal(await frame("CSS.highlights.get('polka-d1')?.size"), 1);
    // The page re-renders: the overlay follows the new text.
    await frame(
      "document.getElementById('root').textContent = 'Новый текст без цитаты'",
    );
    await wait(600);
    assert.deepEqual(
      await parent(
        fromFrame(
          ".filter((m) => m.data.type === 'polka:resolved').at(-1).data.missing",
        ),
      ),
      ["a1"],
    );
  },
);
