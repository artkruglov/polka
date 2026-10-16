// What pasted text is saved as on «Сохранить работу» (apps/web/src/entities/artifact/upload.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pastedFilename, pastedMime } from "../apps/web/src/entities/artifact/upload.ts";

test("pasted HTML is a page, Markdown a document, the rest plain text", () => {
  assert.equal(pastedMime("<!DOCTYPE html><html><body>Отчёт</body></html>"), "text/html");
  assert.equal(pastedMime("  <html lang=ru>\n<p>x</p></html>"), "text/html");
  assert.equal(pastedMime('<div class="card"><h1>Итоги</h1></div>'), "text/html");
  assert.equal(pastedMime("# Итоги недели\n\n- выручка выросла\n- **риски**: нет"), "text/markdown");
  assert.equal(pastedMime("## План\n\nСм. [доску](https://example.com)."), "text/markdown");
  // A lone «#» line or angle brackets in prose are not enough.
  assert.equal(pastedMime("# 1 место — команда А"), "text/plain");
  assert.equal(pastedMime("если a < b и b > c, то <div> не нужен"), "text/plain");
  assert.equal(pastedMime("Просто заметка агента."), "text/plain");
});

test("a new version keeps its work's format", () => {
  assert.equal(pastedMime("просто текст", "text/html"), "text/html");
  assert.equal(pastedMime("<div>x</div>", "text/markdown"), "text/markdown");
  assert.equal(pastedMime("a,b\n1,2", "text/csv"), "text/csv");
  // An image or a PDF cannot take pasted text: decided by the text itself.
  assert.equal(pastedMime("# Заголовок\n- пункт", "image/png"), "text/markdown");
});

test("the file name carries the format's extension", () => {
  assert.equal(pastedFilename("Отчёт", "text/html"), "Отчёт.html");
  assert.equal(pastedFilename("Итоги", "text/markdown"), "Итоги.md");
  assert.equal(pastedFilename("  ", "text/plain"), "Текст.txt");
});
