#!/usr/bin/env node
// Opens a Полка link the way a recipient does, in headless Chrome, and reports
// what the project page did: the frame's size, whether it built its interface,
// failed requests and console errors. Saves a screenshot.
//
//   node scripts/shared-link-smoke.mjs "https://polochka.app/s#…" out.png
//
// Needs playwright-core and a Chromium (npx playwright install chromium).
// A tab in a background window does not paint cross-origin frames, so a
// blank picture from an automated tab proves nothing: use this instead.
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";

const [link, out = "shared-link.png"] = process.argv.slice(2);
if (!link) {
  console.error('Usage: node scripts/shared-link-smoke.mjs "<link>" [out.png]');
  process.exit(2);
}
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const executablePath = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell"))
      .sort()
      .reverse()
      .flatMap((name) =>
        readdirSync(`${cache}/${name}`).map((arch) => `${cache}/${name}/${arch}/chrome-headless-shell`),
      )
      .find(existsSync)
  : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const problems = [];
page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url().slice(-80)}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 160)}`));
await page.goto(link, { waitUntil: "load" });
await page.waitForTimeout(9000);
await page.screenshot({ path: out });
const frame = page.frames().find((f) => new URL(f.url(), "http://x").pathname.startsWith("/project/"));
console.log(
  frame
    ? await frame.evaluate(() =>
        JSON.stringify({
          visible: document.visibilityState,
          width: innerWidth,
          height: innerHeight,
          bodyChildren: document.body.children.length,
        }),
      )
    : "no project frame",
);
console.log(problems.length ? problems.join("\n") : "no failed responses or console errors");
console.log(`screenshot: ${out}`);
await browser.close();
