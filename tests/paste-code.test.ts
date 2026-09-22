import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BYTES, looksLikeHtml } from "../packages/contracts/index.ts";
import { looksLikeHtml as serverLooksLikeHtml } from "../apps/server/html.ts";
import { describePaste } from "../apps/web/src/features/paste-code/model.ts";

test("pasted HTML is saved as a page named by its own title", () => {
  const pasted = describePaste(
    '<!doctype html><html><head><title>  Отчёт &amp; план\n за Q3 </title></head><body><h1>Другое</h1></body></html>',
  );
  assert.equal(pasted?.kind, "html");
  assert.equal(pasted?.mime, "text/html");
  assert.equal(pasted?.filename, "code.html");
  assert.equal(pasted?.title, "Отчёт & план за Q3");
  assert.equal(pasted?.tooLarge, false);
});

test("a fragment without <title> takes its first heading; none gives a neutral name", () => {
  assert.equal(
    describePaste('<div class="card"><h1>Итоги <b>недели</b></h1><p>…</p></div>')
      ?.title,
    "Итоги недели",
  );
  assert.equal(
    describePaste("<section><p>Без заголовка</p></section>")?.title,
    "Страница из чата",
  );
});

test("Markdown and prose are saved as text named by the first line", () => {
  const pasted = describePaste("\n\n## Протокол встречи\n\n- решили: выпускать");
  assert.equal(pasted?.kind, "text");
  assert.equal(pasted?.mime, "text/plain");
  assert.equal(pasted?.filename, "code.txt");
  assert.equal(pasted?.title, "Протокол встречи");
  assert.equal(describePaste("   \n  "), null);
  assert.equal(describePaste("a".repeat(400))?.title.length, 160);
});

test("React component source is not mistaken for a page", () => {
  const component = `import React, { useState } from "react";

export default function Counter() {
  const [n, setN] = useState(0);
  return <div className="p-4"><h1>Счётчик</h1><button onClick={() => setN(n + 1)}>{n}</button></div>;
}`;
  // The shared check alone would call it HTML: it contains <div> and <h1>.
  assert.equal(looksLikeHtml(component), true);
  const pasted = describePaste(component);
  assert.equal(pasted?.kind, "component");
  assert.equal(pasted?.mime, "text/plain");
  assert.equal(pasted?.title, "Код компонента");
  // A real page that happens to contain a module script stays a page.
  assert.equal(
    describePaste(
      '<!doctype html><html><body><script type="module">\nimport x from "./x.js";\n</script></body></html>',
    )?.kind,
    "html",
  );
});

test("size is measured in UTF-8 bytes against the upload limit", () => {
  const pasted = describePaste("я".repeat(MAX_BYTES / 2 + 1));
  assert.equal(pasted?.size, MAX_BYTES + 2);
  assert.equal(pasted?.tooLarge, true);
});

test("the web app and the server share one HTML check", () => {
  assert.equal(serverLooksLikeHtml, looksLikeHtml);
});
