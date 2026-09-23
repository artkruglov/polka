// The patch edit engine (apps/server/edit-patch.ts) and the quote matcher the
// comment overlay runs in the browser (ANCHOR_SOURCE in comment-overlay.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANCHOR_SOURCE } from "../apps/server/comment-overlay.ts";
import { EditFailed, applyEdits } from "../apps/server/edit-patch.ts";

function failure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof EditFailed, String(error));
    assert.equal(error.status, 422);
    assert.equal(error.failure.code, "edit_failed");
    return error.failure;
  }
  assert.fail("expected the edit to be refused");
}

const PAGE = `<!doctype html>\r\n<html><body>\r\n<h1>Отчёт за "квартал"</h1>   \r\n<p>Выручка — 12%.</p>\r\n<p>Итог: рост.</p>\r\n</body></html>\r\n`;

test("an exact match replaces only its span", () => {
  const next = applyEdits(PAGE, [
    { oldText: "<p>Итог: рост.</p>", newText: "<p>Итог: уверенный рост.</p>" },
  ]);
  assert.equal(
    next,
    PAGE.replace("<p>Итог: рост.</p>", "<p>Итог: уверенный рост.</p>"),
  );
  // Line endings and trailing spaces elsewhere are untouched.
  assert.ok(next.includes("</h1>   \r\n"));
});

test("a normalized match (quotes, dashes, NFKC, trailing spaces) maps back to the original", () => {
  // The agent typed ASCII quotes and a hyphen, LF and no trailing spaces.
  const next = applyEdits(PAGE, [
    {
      oldText: '<h1>Отчёт за "квартал"</h1>\n<p>Выручка - 12%.</p>',
      newText: "<h1>Отчёт за квартал</h1>\n<p>Выручка — 14%.</p>",
    },
  ]);
  assert.equal(
    next,
    PAGE.replace(
      '<h1>Отчёт за "квартал"</h1>   \r\n<p>Выручка — 12%.</p>',
      "<h1>Отчёт за квартал</h1>\n<p>Выручка — 14%.</p>",
    ),
  );
  // The rest of the document keeps its bytes (CRLF, the em dash elsewhere).
  assert.ok(next.startsWith("<!doctype html>\r\n<html><body>\r\n"));
  assert.ok(next.endsWith("<p>Итог: рост.</p>\r\n</body></html>\r\n"));
  // Typographic quotes in the document, ASCII in the edit.
  const typographic = "<p>Он сказал «да» — и ушёл…</p><p>ﬁnal</p>";
  assert.equal(
    applyEdits(typographic, [{ oldText: 'сказал "да" - и', newText: "ответил" }]),
    "<p>Он ответил ушёл…</p><p>ﬁnal</p>",
  );
  // NFKC per character: the ligature matches "fi".
  assert.equal(
    applyEdits(typographic, [{ oldText: "final", newText: "last" }]),
    "<p>Он сказал «да» — и ушёл…</p><p>last</p>",
  );
});

test("several edits apply against the same base in any order", () => {
  const next = applyEdits("a1 b2 c3", [
    { oldText: "c3", newText: "C" },
    { oldText: "a1", newText: "AAAA" },
  ]);
  assert.equal(next, "AAAA b2 C");
});

test("refusals name the failing edit", () => {
  const notFound = failure(() =>
    applyEdits(PAGE, [
      { oldText: "<p>Итог: рост.</p>", newText: "x" },
      { oldText: "нет такого текста", newText: "y" },
    ]),
  );
  assert.equal(notFound.reason, "not_found");
  assert.equal(notFound.editIndex, 1);
  assert.match(notFound.message, /Правка 2/);

  const ambiguous = failure(() =>
    applyEdits("<p>да</p><p>да</p>", [{ oldText: "<p>да</p>", newText: "" }]),
  );
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.occurrences, 2);
  assert.equal(ambiguous.editIndex, 0);

  // Unique exactly? No: two matches after normalization count as ambiguous.
  const normalizedTwice = failure(() =>
    applyEdits("«да» и \"да\"", [{ oldText: "'да'", newText: "нет" }]),
  );
  assert.equal(normalizedTwice.reason, "not_found");
  const twiceAfterNormalizing = failure(() =>
    applyEdits("«да» и “да”", [{ oldText: '"да"', newText: "нет" }]),
  );
  assert.equal(twiceAfterNormalizing.reason, "ambiguous");

  const overlap = failure(() =>
    applyEdits("abcdef", [
      { oldText: "cde", newText: "x" },
      { oldText: "abc", newText: "y" },
    ]),
  );
  assert.equal(overlap.reason, "overlap");
  assert.equal(overlap.editIndex, 0);
  assert.equal(overlap.otherEditIndex, 1);

  const empty = failure(() =>
    applyEdits("abc", [
      { oldText: "a", newText: "b" },
      { oldText: "", newText: "x" },
    ]),
  );
  assert.equal(empty.reason, "empty_old_text");
  assert.equal(empty.editIndex, 1);

  const same = failure(() => applyEdits("abc", [{ oldText: "b", newText: "b" }]));
  assert.equal(same.reason, "no_change");
});

// The overlay's matcher, evaluated as the browser gets it.
const findQuote = new Function(`${ANCHOR_SOURCE}; return polkaFindQuote;`)() as (
  text: string,
  quote: { exact: string; prefix?: string; suffix?: string },
) => [number, number] | null;

test("anchors re-resolve on a new version: moved, duplicated, deleted", () => {
  const v1 = "Введение. Выручка выросла на 12%. Итоги квартала.";
  const quote = {
    exact: "Выручка выросла на 12%.",
    prefix: "Введение. ",
    suffix: " Итоги",
  };
  const [start, end] = findQuote(v1, quote)!;
  assert.equal(v1.slice(start, end), quote.exact);
  // Moved: a new paragraph before it.
  const moved = "Новый абзац сверху. Введение. Выручка выросла на 12%. Итоги квартала.";
  const at = findQuote(moved, quote)!;
  assert.equal(moved.slice(at[0], at[1]), quote.exact);
  assert.equal(at[0], moved.indexOf(quote.exact));
  // Duplicated: the context picks the right copy.
  const duplicated =
    "Резюме: Выручка выросла на 12%. Далее. Введение. Выручка выросла на 12%. Итоги квартала.";
  const picked = findQuote(duplicated, quote)!;
  assert.equal(picked[0], duplicated.lastIndexOf(quote.exact));
  // Duplicated with nothing to tell the copies apart: refused, the comment
  // becomes a comment on the whole work.
  assert.equal(
    findQuote("Выручка выросла на 12%. Выручка выросла на 12%.", {
      exact: quote.exact,
      prefix: "",
      suffix: "",
    }),
    null,
  );
  assert.equal(
    findQuote("A Выручка выросла на 12%. B Выручка выросла на 12%. C", {
      exact: quote.exact,
      prefix: "zz",
      suffix: "yy",
    }),
    null,
  );
  // Deleted or rewritten: not found.
  assert.equal(
    findQuote("Введение. Выручка выросла на 14%. Итоги квартала.", quote),
    null,
  );
  // Whitespace reflowed: still found, mapped to the original offsets.
  const reflowed = "Введение.\n  Выручка выросла\n на 12%. Итоги.";
  const loose = findQuote(reflowed, quote)!;
  assert.equal(reflowed.slice(loose[0], loose[1]), "Выручка выросла\n на 12%.");
  assert.equal(findQuote("anything", { exact: "" }), null);
});
