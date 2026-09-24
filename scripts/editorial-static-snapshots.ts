// Renders each editorial original in headless Chrome and saves a script-free
// snapshot next to it (content/editorial/<slug>/static/index.html). The hosted
// build shows HTML only in the static sandbox, so these snapshots are what the
// catalogue can publish until the live viewer is enabled there.
//
//   npx tsx scripts/editorial-static-snapshots.ts            # regenerate
//   npx tsx scripts/editorial-static-snapshots.ts --check    # verify committed files
//   npx tsx scripts/editorial-static-snapshots.ts --screenshots <dir>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyHtml, looksLikeHtml } from "../apps/server/html.ts";
import {
  STATIC_EVIDENCE_PATH,
  STATIC_NOTICES,
  STATIC_SNAPSHOT_NOTE,
  interactiveCandidatesSchema,
  staticCandidatesSchema,
  staticSourcePath,
} from "./editorial-static-lib.ts";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const shotIndex = args.indexOf("--screenshots");
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1] ?? "") : null;

// Page-specific preparation: turn a one-step-at-a-time view into a readable
// page (every quiz answer explained, every slide shown) before the scripts go.
// These run in the page with the material's own top-level bindings in scope.
const prepare: Record<string, string> = {
  fractions: `(() => {
    const parts = [];
    for (let k = 0; k < tasks.length; k++) {
      index = k; render(); answer(tasks[k].c);
      root.querySelector('.actions')?.remove();
      parts.push('<div class="static-step" style="padding-bottom:22px;margin-bottom:22px;border-bottom:1px solid rgba(0,0,0,.08)">' + root.innerHTML + '</div>');
    }
    root.innerHTML = parts.join('');
    count.textContent = tasks.length + ' задач с разбором';
    bar.style.width = '100%';
  })()`,
  "city-observation": `(() => {
    const parts = [];
    for (let k = 0; k < slides.length; k++) {
      index = k; render();
      slide.querySelector('.actions')?.remove();
      parts.push('<div class="static-step" style="margin-bottom:34px">' + slide.innerHTML + '</div>');
    }
    slide.innerHTML = parts.join('');
    dots.remove();
    count.textContent = slides.length + ' шагов';
    bar.style.width = '100%';
  })()`,
  "reading-session": `(() => {
    document.querySelectorAll('.page').forEach((page) => {
      page.hidden = false;
      page.style.marginBottom = '26px';
    });
    document.querySelector('.controls')?.remove();
    document.querySelector('#session-status')?.remove();
    document.querySelector('#session-count').textContent = '4 шага';
    document.querySelector('#session-percent').textContent = '';
    document.querySelector('#progress-fill').style.width = '100%';
  })()`,
  "data-literacy": `(() => {
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.hidden = false;
      panel.style.marginBottom = '30px';
    });
    document.querySelector('.tabs')?.remove();
    document.querySelector('#reset')?.remove();
  })()`,
  "sorting-explainer": `(() => {
    const log = [];
    for (let k = 0; k < 10; k++) { nextStep(); log.push(status.textContent); }
    document.querySelector('#reset').click();
    status.textContent = 'Исходный ряд: 7, 3, 5, 2, 6. Ниже — все десять сравнений по порядку.';
    const list = document.createElement('ol');
    list.className = 'static-steps';
    list.style.cssText = 'margin:18px 0 0;padding-left:22px;line-height:1.6';
    for (const line of log) { const item = document.createElement('li'); item.textContent = line; list.append(item); }
    document.querySelector('.steps').after(list);
    document.querySelector('.actions')?.remove();
  })()`,
  "probability-lab": `document.querySelector('#run').click()`,
  // The stories are written to read in full without scripts: show that layout.
  "why-no-artifact-link": `document.documentElement.classList.remove('js')`,
  "one-regex-froze-server": `document.documentElement.classList.remove('js')`,
  "31-sandbox-escapes": `document.documentElement.classList.remove('js')`,
  "handwriting-research": `document.documentElement.classList.remove('js')`,
  "how-presentation-editors-work": `(() => {
    const panel = document.getElementById('panel');
    const parts = [];
    for (const button of document.querySelectorAll('.layer')) {
      button.click();
      parts.push('<h3 style="margin:14px 0 8px">' + button.querySelector('span').textContent + '</h3>' + panel.innerHTML);
    }
    panel.innerHTML = parts.join('');
    document.querySelectorAll('.layer').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    document.documentElement.classList.remove('js');
  })()`,
  "observability-to-ai-sre": `(() => {
    const panel = document.getElementById('panel');
    const parts = [];
    // Bottom floor first: the buttons are listed top-down, the text reads bottom-up.
    for (const key of ['1', '2', '3', '4', 'ai']) {
      document.querySelector('.floor[data-k="' + key + '"]').click();
      parts.push(panel.innerHTML);
    }
    panel.innerHTML = parts.join('');
    document.querySelectorAll('.floor').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    document.documentElement.classList.remove('js');
  })()`,
};

// Freezes form state into attributes, then strips everything executable.
const finalize = `(() => {
  for (const el of document.querySelectorAll('input')) {
    if (el.type === 'checkbox' || el.type === 'radio') el.toggleAttribute('checked', el.checked);
    else el.setAttribute('value', el.value);
  }
  for (const el of document.querySelectorAll('option')) el.toggleAttribute('selected', el.selected);
  for (const el of document.querySelectorAll('textarea')) el.textContent = el.value;
  for (const el of document.querySelectorAll('button')) el.setAttribute('disabled', '');
  for (const el of document.querySelectorAll('script,noscript')) el.remove();
  for (const el of document.querySelectorAll('*'))
    for (const attr of [...el.attributes])
      if (/^on/i.test(attr.name) || /^\\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
  const note = document.createElement('p');
  note.className = 'polka-static-note';
  note.setAttribute('style', 'margin:28px 0 8px;padding-top:12px;border-top:1px solid rgba(0,0,0,.12);font:13px/1.5 system-ui,-apple-system,sans-serif;color:#6b6b6b');
  note.textContent = ${JSON.stringify(STATIC_SNAPSHOT_NOTE)};
  (document.querySelector('main') ?? document.body).append(note);
  return '<!DOCTYPE html>\\n' + document.documentElement.outerHTML + '\\n';
})()`;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), "polka-editorial-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port = "";
  for (let i = 0; i < 80 && !port; i++) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
    } catch {
      await wait(125);
    }
  }
  if (!port) throw new Error("Chrome did not start");
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.addEventListener("open", done);
    ws.addEventListener("error", fail);
  });
  let id = 0;
  const pending = new Map<number, (message: any) => void>();
  const events = new Map<string, () => void>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    } else if (message.method && events.has(message.method)) {
      events.get(message.method)!();
      events.delete(message.method);
    }
  });
  const cmd = (method: string, params: object = {}) =>
    new Promise<any>((done, fail) => {
      const i = ++id;
      pending.set(i, (message) =>
        message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result),
      );
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const navigate = async (url: string) => {
    const loaded = new Promise<void>((done) => events.set("Page.loadEventFired", done));
    await cmd("Page.navigate", { url });
    await loaded;
    await wait(300);
  };
  const evaluate = async (expression: string) => {
    const result = await cmd("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(`Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  const viewport = (width: number, height: number) =>
    cmd("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: width < 600 ? 2 : 1,
      mobile: width < 600,
    });
  const screenshot = async (path: string) => {
    const { cssContentSize } = await cmd("Page.getLayoutMetrics");
    const shot = await cmd("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
    });
    await writeFile(path, Buffer.from(shot.data, "base64"));
  };
  await cmd("Page.enable");
  return {
    cmd,
    navigate,
    evaluate,
    viewport,
    screenshot,
    async close() {
      ws.close();
      chrome.kill();
      await wait(200);
      await rm(profile, { recursive: true, force: true });
    },
  };
}

const interactive = interactiveCandidatesSchema.parse(
  JSON.parse(await readFile(join(root, "content/editorial/candidates.json"), "utf8")),
);
const browser = await launchChrome();
const items = [];
let mismatches = 0;
try {
  for (const candidate of interactive.items) {
    const original = await readFile(join(root, candidate.sourcePath));
    if (sha256(original) !== candidate.sourceSha256)
      throw new Error(`${candidate.slug}: interactive source hash mismatch`);
    await browser.cmd("Emulation.setScriptExecutionDisabled", { value: false });
    await browser.viewport(1100, 900);
    await browser.navigate(pathToFileURL(join(root, candidate.sourcePath)).href);
    if (prepare[candidate.slug]) await browser.evaluate(prepare[candidate.slug]!);
    const html: string = await browser.evaluate(finalize);
    const profile = classifyHtml(html);
    if (!looksLikeHtml(html) || profile !== "static")
      throw new Error(`${candidate.slug}: snapshot classifies as ${profile}`);
    const path = staticSourcePath(candidate.slug);
    const hash = sha256(html);
    if (check) {
      const committed = await readFile(join(root, path), "utf8").catch(() => "");
      if (sha256(committed) !== hash) {
        mismatches++;
        console.log(JSON.stringify({ slug: candidate.slug, status: "differs" }));
      } else console.log(JSON.stringify({ slug: candidate.slug, status: "same" }));
    } else {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), html);
      console.log(JSON.stringify({ slug: candidate.slug, sha256: hash, bytes: Buffer.byteLength(html) }));
    }
    items.push({
      slug: candidate.slug,
      title: candidate.title,
      topic: candidate.topic,
      task: candidate.task,
      action: candidate.action,
      author: candidate.author,
      license: candidate.license,
      notices: STATIC_NOTICES,
      htmlProfile: "static" as const,
      sourcePath: path,
      sourceSha256: hash,
      interactiveSourcePath: candidate.sourcePath,
      interactiveSourceSha256: candidate.sourceSha256,
      evidencePath: STATIC_EVIDENCE_PATH,
    });
  }
  if (shotDir) {
    // Scripts off, as in the hosted static sandbox.
    await mkdir(shotDir, { recursive: true });
    await browser.cmd("Emulation.setScriptExecutionDisabled", { value: true });
    for (const item of items)
      for (const width of [1100, 390]) {
        await browser.viewport(width, 900);
        await browser.navigate(pathToFileURL(join(root, item.sourcePath)).href);
        await browser.screenshot(join(shotDir, `static-${item.slug}-${width}.png`));
      }
  }
} finally {
  await browser.close();
}

const manifest = staticCandidatesSchema.parse({
  version: 1,
  status: "static-snapshots",
  publication: "requires-explicit-registration",
  generator: "scripts/editorial-static-snapshots.ts",
  items,
});
const manifestPath = join(root, "content/editorial/static-candidates.json");
if (check) {
  const committed = await readFile(manifestPath, "utf8").catch(() => "");
  if (committed !== `${JSON.stringify(manifest, null, 2)}\n`) {
    mismatches++;
    console.log(JSON.stringify({ file: "static-candidates.json", status: "differs" }));
  }
  if (mismatches) process.exitCode = 1;
} else await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
