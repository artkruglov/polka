import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiffView,
  lines,
  MAX_SHOWN_CHANGES,
} from "../apps/web/src/features/compare-revisions/DiffView.tsx";
import {
  decodeText,
  fileChanges,
  readSource,
  unavailableReason,
} from "../apps/web/src/features/compare-revisions/source.ts";
import { diffTexts } from "../apps/web/src/shared/lib/line-diff.ts";
import type { Revision } from "../packages/contracts/index.ts";

const revision = (patch: Partial<Revision>): Revision => ({
  id: "r",
  number: 1,
  filename: "page.html",
  mime: "text/html",
  size: 1,
  sha256: "0".repeat(64),
  storageKind: "single",
  totalSize: 1,
  htmlProfile: "static",
  inlineBuild: null,
  createdAt: "2026-09-23T10:00:00.000Z",
  ...patch,
});

test("Russian line counts", () => {
  assert.equal(lines(1), "1 строка");
  assert.equal(lines(3), "3 строки");
  assert.equal(lines(11), "11 строк");
  assert.equal(lines(21), "21 строка");
  assert.equal(lines(2000).replace(/\s/g, " "), "2 000 строк");
});

test("images and binary files are not compared; text and HTML are", async () => {
  assert.match(unavailableReason(revision({ mime: "image/png", number: 4 }))!, /Версия 4 — изображение/);
  assert.match(unavailableReason(revision({ mime: "application/pdf" }))!, /не текст/);
  for (const mime of ["text/html", "text/plain", "text/markdown", "application/json", "image/svg+xml"])
    assert.equal(unavailableReason(revision({ mime })), null, mime);
  assert.equal(decodeText(new Uint8Array([0x3c, 0x70, 0x3e])), "<p>");
  assert.equal(decodeText(new Uint8Array([0x3c, 0, 0x3e])), null);
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0xfd])), null);
  const html = await readSource(revision({}), new Blob(["<h1>Привет</h1>\n"]));
  assert.deepEqual(html, { text: "<h1>Привет</h1>\n", files: null });
  const binary = await readSource(revision({ mime: "text/plain" }), new Blob([new Uint8Array([1, 0, 2])]));
  assert.ok("unavailable" in binary);
});

test("a bundle compares its entry point and lists changed files", async () => {
  const exported = (entry: string, extra: Record<string, string>) =>
    new Blob([
      JSON.stringify({
        manifest: { entrypoint: "index.html" },
        manifestSha256: "x",
        files: [
          { path: "index.html", mime: "text/html", size: 1, sha256: entry, encoding: "base64", data: Buffer.from(`<p>${entry}</p>`).toString("base64") },
          ...Object.entries(extra).map(([path, sha256]) => ({ path, mime: "text/css", size: 1, sha256, encoding: "base64", data: "" })),
        ],
      }),
    ]);
  const bundle = revision({ storageKind: "bundle" });
  const before = await readSource(bundle, exported("a", { "a.css": "1", "old.js": "2" }));
  const after = await readSource(bundle, exported("b", { "a.css": "9", "new.js": "3" }));
  assert.ok("text" in before && "text" in after);
  assert.equal(before.text, "<p>a</p>");
  assert.equal(after.text, "<p>b</p>");
  assert.deepEqual(fileChanges(before.files!, after.files!), {
    added: ["new.js"],
    removed: ["old.js"],
    changed: ["index.html", "a.css"],
  });
});

test("DiffView: counts, highlighted rows, folded context and honest notes", () => {
  const old = Array.from({ length: 40 }, (_, i) => `<li>${i}</li>`);
  const next = [...old];
  next[5] = "<li>five</li>";
  next.push("<li>new</li>");
  const html = renderToStaticMarkup(
    React.createElement(DiffView, { from: 1, to: 2, result: diffTexts(old.join("\n"), next.join("\n")) }),
  );
  assert.match(html, /Версия 1 → версия 2/);
  assert.match(html, /\+2 строки/);
  assert.match(html, /−1 строка/);
  assert.match(html, /revision-diff-row--del[^]*&lt;li&gt;5&lt;\/li&gt;/);
  assert.match(html, /revision-diff-row--add[^]*&lt;li&gt;five&lt;\/li&gt;/);
  assert.match(html, /Удалено, строка 6/);
  assert.match(html, /Добавлено, строка 6/);
  assert.match(html, /revision-diff-skip">2 строки без изменений/);
  assert.match(html, /revision-diff-skip">28 строк без изменений/);
  assert.doesNotMatch(html, /показано не всё/);

  const same = renderToStaticMarkup(
    React.createElement(DiffView, { from: 1, to: 2, result: diffTexts("a", "a") }),
  );
  assert.match(same, /исходный код не изменился/);
  assert.doesNotMatch(same, /revision-diff-row/);

  const many = Array.from({ length: MAX_SHOWN_CHANGES + 50 }, (_, i) => `line ${i}`);
  const capped = renderToStaticMarkup(
    React.createElement(DiffView, { from: 1, to: 3, result: diffTexts("", many.join("\n")) }),
  );
  assert.match(capped, /показано не всё/);
  assert.equal(capped.match(/revision-diff-row--add/g)!.length, MAX_SHOWN_CHANGES);
  const long = renderToStaticMarkup(
    React.createElement(DiffView, { from: 1, to: 2, result: diffTexts("a", "x".repeat(5000)) }),
  );
  assert.match(long, /… ещё 3(?:\s|&nbsp;)?000 символов/);
});
