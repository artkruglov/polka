import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import { componentShell } from "../packages/contracts/runtime.ts";
import { buildDerivative } from "../apps/server/react-runtime.ts";
import { liveViewerCsp, withViewerGuard } from "../apps/server/html.ts";

/**
 * The compiled pages actually running: a real browser loads each build
 * under the interactive viewer's own CSP and sandbox, and the test drives
 * it over the DevTools protocol. Without Chrome (CI images have none) the
 * tests skip; the builder's own tests stay in react-runtime.test.ts.
 */
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));
const skip = chromePath ? false : "Chrome is not installed here";

const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const mimeOf = (file: string) =>
  file.endsWith(".html")
    ? "text/html"
    : file.endsWith(".css")
      ? "text/css"
      : file.endsWith(".json")
        ? "application/json"
        : "text/javascript";

async function compile(sources: Record<string, string>) {
  const bytes = new Map(
    Object.entries(sources).map(([file, text]) => [file, Buffer.from(text)]),
  );
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "inline-live-experimental-v1",
    files: [...bytes].map(([file, value]) => ({
      path: file,
      mime: mimeOf(file),
      size: value.length,
      sha256: digest(value),
    })),
    provenance: {
      kind: "mcp",
      sourceUrl: null,
      capturedAt: "2026-09-22T10:00:00Z",
      attribution: "Test",
      license: "unknown",
    },
    dependencies: { status: "self-contained", unresolved: [] },
  });
  const result = await buildDerivative(manifest, bytes);
  if (!result.ok)
    assert.fail(`build refused: ${result.reason} (${result.path})`);
  return result.html.toString("utf8");
}

const pages = new Map<string, string>();
let server: Server;
let origin = "";
let chrome: ChildProcess | undefined;
let profile = "";
let socket: WebSocket | undefined;
let nextId = 0;
const pending = new Map<number, (message: any) => void>();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId;
  return new Promise<any>((resolve, reject) => {
    pending.set(id, (message) =>
      message.error
        ? reject(new Error(message.error.message))
        : resolve(message.result),
    );
    socket!.send(JSON.stringify({ id, method, params }));
  });
}

/** Loads a built page under the viewer's CSP and returns an evaluator. */
async function open(html: string) {
  const name = `/page-${pages.size}`;
  pages.set(name, html);
  await send("Page.navigate", { url: origin + name });
  // The page mounts on DOMContentLoaded; give React a few frames.
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(100);
    const ready = await send("Runtime.evaluate", {
      expression: "document.readyState === 'complete'",
      returnByValue: true,
    });
    if (ready.result?.value) break;
  }
  await wait(200);
  return async (expression: string) => {
    const value = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (value.exceptionDetails)
      throw new Error(
        value.exceptionDetails.exception?.description ?? "evaluation failed",
      );
    return value.result?.value;
  };
}

before(async () => {
  if (skip) return;
  server = createServer((request, response) => {
    const html = pages.get((request.url ?? "").split("?")[0]);
    if (html === undefined) {
      response.writeHead(404).end();
      return;
    }
    // Exactly the interactive viewer's isolation, including its sandbox.
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": liveViewerCsp(origin),
      "cache-control": "no-store",
    });
    // As the viewer serves it: the WebRTC guard goes first.
    response.end(withViewerGuard(Buffer.from(html)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  profile = mkdtempSync(path.join(tmpdir(), "polka-chrome-"));
  // Port 0: Chrome picks a free port and writes it to DevToolsActivePort, so a
  // busy runner cannot hand us a port something else already holds.
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
  // A cold Chrome on a loaded CI runner can take well over 15 s to start.
  const deadline = Date.now() + 45_000;
  let port = 0;
  let targets: any[] = [];
  while (Date.now() < deadline && exited === null) {
    try {
      port ||= Number(
        readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0],
      );
      if (port) {
        targets = (await (
          await fetch(`http://127.0.0.1:${port}/json`)
        ).json()) as any[];
        if (targets.some((target) => target.type === "page")) break;
        // The browser answers but its first tab is not there yet: open one.
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      }
    } catch {
      /* not started or not listening yet */
    }
    await wait(250);
  }
  const target = targets.find((item) => item.type === "page");
  assert.ok(
    target,
    exited === null
      ? "Chrome did not open a page target within 45 s"
      : `Chrome exited (${exited}) before opening a page`,
  );
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
  await send("Runtime.enable");
  await send("Log.enable");
});

after(async () => {
  socket?.close();
  if (chrome) {
    const ended = new Promise((resolve) => chrome!.once("exit", resolve));
    chrome.kill();
    await Promise.race([ended, wait(5_000)]);
  }
  await new Promise<void>(
    (resolve) => server?.close(() => resolve()) ?? resolve(),
  );
  // Chrome may still be flushing its profile; a leftover temp directory is
  // not a test failure.
  try {
    if (profile) rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the OS cleans the temp directory */
  }
});

const CDN_HEAD = `<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>`;

test(
  "a React form submits to its own handler in the viewer sandbox",
  { skip },
  async () => {
    const html = await compile({
      "index.html": componentShell("Form", "App.jsx"),
      "App.jsx": `import { useState } from "react";
export default function App() {
  const [items, setItems] = useState([]);
  const [value, setValue] = useState("");
  return (
    <form onSubmit={(event) => { event.preventDefault(); setItems([...items, value]); setValue(""); }}>
      <input id="field" value={value} onChange={(event) => setValue(event.target.value)} />
      <button id="add" type="submit">Add</button>
      <ul id="items">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </form>
  );
}`,
    });
    const evaluate = await open(html);
    assert.equal(await evaluate("document.querySelectorAll('form').length"), 1);
    await evaluate(`(() => {
    const field = document.getElementById("field");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(field, "Milk");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add").click();
  })()`);
    await wait(300);
    assert.equal(
      await evaluate("document.querySelectorAll('#items li').length"),
      1,
    );
    assert.equal(
      await evaluate("document.querySelector('#items li').textContent"),
      "Milk",
    );
    // The page itself never navigated: form-action 'none' still holds.
    assert.equal(
      await evaluate("location.pathname.startsWith('/page-')"),
      true,
    );
  },
);

test(
  "gradients, storage and dialogs work in a compiled page",
  { skip },
  async () => {
    const html = await compile({
      "index.html": `<!doctype html><html><head><style>.filled{fill:url(#grad)}</style></head>
<body><svg width="40" height="40"><defs><linearGradient id="grad"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect id="box" class="filled" width="40" height="40"/></svg>
<script type="module">
localStorage.setItem("note", "kept");
sessionStorage.setItem("t", "1");
window.saved = localStorage.getItem("note") + document.cookie.length;
window.answered = confirm("Delete?");
alert("Готово");
window.prompted = prompt("Name?", "Ann");
</script></body></html>`,
    });
    const evaluate = await open(html);
    assert.equal(
      await evaluate("getComputedStyle(document.getElementById('box')).fill"),
      'url("#grad")',
    );
    assert.equal(await evaluate("window.saved"), "kept0");
    assert.equal(await evaluate("window.answered"), true);
    assert.equal(await evaluate("window.prompted"), "Ann");
    assert.equal(
      await evaluate("document.body.innerText.includes('Готово')"),
      true,
    );
  },
);

test(
  "Babel scripts share a scope and an inline Tailwind config applies",
  { skip },
  async () => {
    const html = await compile({
      "index.html": `<!doctype html><html><head>${CDN_HEAD}
<script>tailwind.config = { theme: { extend: { colors: { brand: "#123456" } } } };</script>
</head><body><div id="root"></div>
<script type="text/babel">const Header = ({ title }) => <h1 id="title" className="bg-brand text-2xl">{title}</h1>;</script>
<script type="text/babel">ReactDOM.createRoot(document.getElementById("root")).render(<Header title="Второй скрипт видит первый" />);</script>
</body></html>`,
    });
    const evaluate = await open(html);
    assert.equal(
      await evaluate("document.getElementById('title')?.textContent"),
      "Второй скрипт видит первый",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.getElementById('title')).backgroundColor",
      ),
      "rgb(18, 52, 86)",
    );
    assert.equal(
      await evaluate("document.querySelector('[role=alert]') === null"),
      true,
    );
  },
);

test(
  "a plain scripted page gets the same environment without a compiler",
  { skip },
  async () => {
    const html = await compile({
      "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>Counter</title></head>
<body><button id="tick">0</button>
<script>
document.getElementById("tick").onclick = function () {
  this.textContent = Number(this.textContent) + 1;
  localStorage.setItem("count", this.textContent);
};
window.probe = () => localStorage.getItem("count");
</script></body></html>`,
    });
    const evaluate = await open(html);
    assert.equal(await evaluate("typeof localStorage.setItem"), "function");
    await evaluate("document.getElementById('tick').click()");
    assert.equal(
      await evaluate("document.getElementById('tick').textContent"),
      "1",
    );
    assert.equal(await evaluate("window.probe()"), "1");
    assert.equal(await evaluate("document.cookie"), "");
  },
);

test(
  "a page in the viewer cannot reach WebRTC, even from a script before its head",
  { skip },
  async () => {
    // Not compiled: served raw, as an owner sees an unbuilt single file.
    const evaluate = await open(`<!doctype html><script>
window.early = typeof RTCPeerConnection;
</script><html><head><title>rtc</title></head><body><p>x</p></body></html>`);
    assert.equal(await evaluate("window.early"), "undefined");
    assert.equal(await evaluate("typeof RTCPeerConnection"), "undefined");
    assert.equal(await evaluate("typeof webkitRTCPeerConnection"), "undefined");
    // It cannot be put back or deleted.
    assert.equal(
      await evaluate(
        "(() => { try { Object.defineProperty(window, 'RTCPeerConnection', { value: function () {} }); return 'redefined'; } catch (e) { return e.name; } })()",
      ),
      "TypeError",
    );
    assert.equal(await evaluate("delete window.RTCPeerConnection"), false);
    // A fresh realm does not bring it back: the sandbox makes the iframe a
    // different opaque origin.
    assert.equal(
      await evaluate(
        "(() => { const f = document.createElement('iframe'); document.body.appendChild(f); try { return typeof f.contentWindow.RTCPeerConnection; } catch (e) { return e.name; } })()",
      ),
      "SecurityError",
    );
  },
);
