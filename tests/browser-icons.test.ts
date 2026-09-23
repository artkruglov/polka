import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import { registerFrontend } from "../apps/server/frontend.ts";

// The public folder is what Vite copies into the served build.
const PUBLIC = "apps/web/public";

test("the app shell links the browser icons and the manifest", () => {
  const html = readFileSync("apps/web/index.html", "utf8");
  for (const href of ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/manifest.webmanifest"]) {
    assert.ok(html.includes(`href="${href}"`), href);
    assert.ok(existsSync(`${PUBLIC}${href}`), `${href} exists`);
  }
});

test("the manifest parses and every icon it names exists", () => {
  const manifest = JSON.parse(readFileSync(`${PUBLIC}/manifest.webmanifest`, "utf8"));
  assert.equal(manifest.name, "Полка");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable"));
  for (const icon of manifest.icons) assert.ok(existsSync(`${PUBLIC}${icon.src}`), icon.src);
});

test("icons are served with their own content types, not the JSON 404", async () => {
  const app = Fastify();
  await registerFrontend(app, `${process.cwd()}/${PUBLIC}`);
  for (const [path, type] of [
    ["/favicon.ico", /^image\/(x-icon|vnd\.microsoft\.icon)/],
    ["/favicon.svg", /^image\/svg\+xml/],
    ["/apple-touch-icon.png", /^image\/png/],
    ["/icon-512-maskable.png", /^image\/png/],
    ["/manifest.webmanifest", /^application\/manifest\+json/],
  ] as const) {
    const response = await app.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200, path);
    assert.match(String(response.headers["content-type"]), type, path);
  }
  await app.close();
});
