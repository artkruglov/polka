#!/usr/bin/env node
// Renders the images the GitHub README uses, with headless Chrome over the
// DevTools protocol (no dependency; the same approach as render-og-images.mjs).
//
//   node scripts/render-readme-assets.mjs social
//       docs/assets/social-preview.svg -> docs/assets/social-preview.png (1280×640)
//   node scripts/render-readme-assets.mjs shot <url> <out.png> [height] [wait-ms]
//       a 1440-wide screenshot of a page (e.g. polochka.app) into docs/screenshots/
//       (SHOT_WIDTH=390 for the phone layout)
//   node scripts/render-readme-assets.mjs links <url>
//       prints the links on a page (to pick an editorial work from /discover)
//
// POLKA_SESSION=<cookie> signs the shot in (a local demo account, never a real
// one). CHROME=/path/to/chrome overrides the browser. Screenshots are PNG; run
// `cwebp -q 82` or keep the PNG when it is under 400 KB.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome =
  process.env.CHROME ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome");
const [mode, ...args] = process.argv.slice(2);
if (!["social", "shot", "links"].includes(mode)) {
  console.error("usage: render-readme-assets.mjs social | shot <url> <out.png> [height] [wait-ms] | links <url>");
  process.exit(2);
}

/** An HTML page that shows one SVG filling the viewport, fonts inlined. */
function svgPage(svgPath) {
  const svg = readFileSync(svgPath, "utf8").replace(
    /url\("([^"]+\.ttf)"\)/g,
    (_, font) =>
      `url("data:font/ttf;base64,${readFileSync(join(dirname(svgPath), font)).toString("base64")}")`,
  );
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>${svg}`;
}

const profile = mkdtempSync(join(tmpdir(), "polka-readme-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--lang=ru-RU",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; !existsSync(portFile); i++) {
    if (i > 100) throw new Error("Chrome did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    socket.onopen = ok;
    socket.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  const events = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { ok, fail } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? fail(new Error(message.error.message)) : ok(message.result);
    } else if (message.method) events.get(message.method)?.();
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      pending.set(++id, { ok, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });

  // A signed-in page (e.g. /settings/agents on a local install with a demo
  // account): POLKA_SESSION=<polka_session cookie value>.
  if (process.env.POLKA_SESSION && mode === "shot")
    await send("Network.setCookie", {
      name: "polka_session",
      value: process.env.POLKA_SESSION,
      url: new URL(args[0]).origin,
    });

  async function open(url, width, height) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const loaded = new Promise((ok) => events.set("Page.loadEventFired", ok));
    await send("Page.navigate", { url });
    await loaded;
    await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  }
  async function capture(out, width, height) {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(out);
  }

  if (mode === "social") {
    const scratch = join(profile, "page.html");
    writeFileSync(scratch, svgPage(join(root, "docs/assets/social-preview.svg")));
    await open(`file://${scratch}`, 1280, 640);
    await capture(join(root, "docs/assets/social-preview.png"), 1280, 640);
  } else if (mode === "shot") {
    const [url, out, height = "900", wait = "2500"] = args;
    // SHOT_WIDTH=390 renders the phone layout; the default is the desktop width.
    const width = Number(process.env.SHOT_WIDTH ?? 1440);
    await open(url, width, Number(height));
    await sleep(Number(wait));
    // A local install shows its own address in commands; SHOW_ORIGIN puts the
    // public one there (as the hosted page shows it).
    if (process.env.SHOW_ORIGIN)
      await send("Runtime.evaluate", {
        expression: `(() => { const from = ${JSON.stringify(new URL(url).origin)}, to = ${JSON.stringify(process.env.SHOW_ORIGIN)};
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n; (n = walk.nextNode()); ) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.replaceAll(from, to);
          for (const el of document.querySelectorAll("input, textarea")) if (el.value.includes(from)) el.value = el.value.replaceAll(from, to);
        })()`,
      });
    // SHOT_JS=<expression> runs in the page before the capture (a state the
    // page cannot show by itself, e.g. a star count the repository has not yet).
    if (process.env.SHOT_JS) await send("Runtime.evaluate", { expression: process.env.SHOT_JS });
    await capture(resolve(out), width, Number(height));
  } else {
    await open(args[0], 1440, 900);
    await sleep(3000);
    const { result } = await send("Runtime.evaluate", {
      expression:
        "JSON.stringify([...document.querySelectorAll('a[href]')].map(a => [a.href, a.textContent.trim().slice(0, 80)]))",
      returnByValue: true,
    });
    for (const [href, text] of JSON.parse(result.value)) console.log(href, "\t", text);
  }
  socket.close();
} finally {
  browser.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(profile, { recursive: true, force: true });
}
