#!/usr/bin/env node
// Renders the link-preview cards docs/design/og/{share,default}.svg to the
// 1200×630 PNGs in apps/web/public/og/, with headless Chrome over the
// DevTools protocol (no dependency).
// Fonts are inlined as data URIs, so the result does not depend on file://
// font access or on system fonts.
//
//   node scripts/render-og-images.mjs     (CHROME=/path/to/chrome to override)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "docs/design/og");
const pub = join(root, "apps/web/public");
const chrome =
  process.env.CHROME ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome");

/** An HTML page that shows one SVG filling the viewport. */
function page(svgPath) {
  const svg = readFileSync(svgPath, "utf8").replace(
    /url\("([^"]+\.ttf)"\)/g,
    (_, font) =>
      `url("data:font/ttf;base64,${readFileSync(join(dirname(svgPath), font)).toString("base64")}")`,
  );
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`;
}

const profile = mkdtempSync(join(tmpdir(), "polka-og-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
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
  await send("Page.enable");

  const scratch = join(profile, "page.html");
  async function render(svgPath, width, height = width, transparent = true) {
    writeFileSync(scratch, page(svgPath));
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setDefaultBackgroundColorOverride", {
      color: transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: 255, g: 255, b: 255, a: 1 },
    });
    const loaded = new Promise((ok) => events.set("Page.loadEventFired", ok));
    await send("Page.navigate", { url: `file://${scratch}?${Math.random()}` });
    await loaded;
    await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return Buffer.from(data, "base64");
  }
  const write = (path, data) => {
    writeFileSync(join(pub, path), data);
    console.log(`apps/web/public/${path}`);
  };

  for (const name of ["share", "default"])
    write(`og/${name}.png`, await render(join(source, `${name}.svg`), 1200, 630, false));
  socket.close();
} finally {
  browser.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(profile, { recursive: true, force: true });
}
