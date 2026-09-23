import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collapseDiff,
  diffLines,
  diffTexts,
  splitLines,
  type DiffLine,
} from "../apps/web/src/shared/lib/line-diff.ts";

const sides = (lines: DiffLine[]) => ({
  old: lines.filter((l) => l.kind !== "add").map((l) => l.text),
  new: lines.filter((l) => l.kind !== "del").map((l) => l.text),
});

/** Length of the longest common subsequence, by dynamic programming. */
function lcs(a: string[], b: string[]) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = up;
    }
  }
  return row[b.length];
}

// Deterministic pseudo-random sequences (mulberry32).
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("splitLines handles CRLF, CR and a final newline", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines("a\r\nb\rc\n\n"), ["a", "b", "c", ""]);
});

test("a small edit: numbering, kinds and counts", () => {
  const result = diffLines(["<p>", "one", "two", "</p>"], ["<p>", "one", "2", "three", "</p>"]);
  assert.equal(result.exact, true);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.lines, [
    { kind: "same", text: "<p>", a: 1, b: 1 },
    { kind: "same", text: "one", a: 2, b: 2 },
    { kind: "del", text: "two", a: 3 },
    { kind: "add", text: "2", b: 3 },
    { kind: "add", text: "three", b: 4 },
    { kind: "same", text: "</p>", a: 4, b: 5 },
  ]);
});

test("identical, empty and one-sided inputs", () => {
  assert.deepEqual(diffLines([], []), { lines: [], added: 0, removed: 0, exact: true });
  const same = diffLines(["a", "b"], ["a", "b"]);
  assert.equal(same.added + same.removed, 0);
  assert.equal(same.lines.length, 2);
  const created = diffLines([], ["a", "b"]);
  assert.deepEqual(created.lines.map((l) => l.kind), ["add", "add"]);
  const cleared = diffLines(["a", "b"], []);
  assert.deepEqual(cleared.lines.map((l) => [l.kind, l.a]), [["del", 1], ["del", 2]]);
});

test("random pairs: both texts are reproduced and the edit script is minimal", () => {
  const next = random(20260923);
  for (let round = 0; round < 400; round++) {
    const alphabet = 1 + Math.floor(next() * 6);
    const make = () =>
      Array.from({ length: Math.floor(next() * 30) }, () =>
        String.fromCharCode(97 + Math.floor(next() * alphabet)),
      );
    const a = make(),
      b = make();
    const result = diffLines(a, b);
    assert.deepEqual(sides(result.lines), { old: a, new: b }, `${a} → ${b}`);
    const common = lcs(a, b);
    assert.equal(result.removed, a.length - common, `${a} → ${b}`);
    assert.equal(result.added, b.length - common, `${a} → ${b}`);
    // Line numbers count up on each side without gaps.
    let x = 0,
      y = 0;
    for (const line of result.lines) {
      if (line.kind !== "add") assert.equal(line.a, ++x);
      if (line.kind !== "del") assert.equal(line.b, ++y);
    }
  }
});

test("past maxEdits the changed middle becomes one replacement, still correct", () => {
  const a = ["head", ...Array.from({ length: 40 }, (_, i) => `old ${i}`), "tail"];
  const b = ["head", ...Array.from({ length: 40 }, (_, i) => `new ${i}`), "tail"];
  const result = diffLines(a, b, 10);
  assert.equal(result.exact, false);
  assert.deepEqual(sides(result.lines), { old: a, new: b });
  assert.equal(result.removed, 40);
  assert.equal(result.added, 40);
  assert.equal(result.lines[0].kind, "same");
  assert.equal(result.lines.at(-1)!.kind, "same");
});

test("diffTexts compares at most maxLines lines per side and says so", () => {
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const result = diffTexts(long, `${long}\nextra`, { maxLines: 10, maxEdits: 100 });
  assert.equal(result.clipped, true);
  assert.equal(result.added + result.removed, 0);
  assert.equal(result.lines.length, 10);
  assert.equal(diffTexts("a\nb", "a\nc").clipped, false);
});

test("large inputs stay fast: a 5 MB page with a few edits, and two unrelated pages", () => {
  const big = Array.from({ length: 50_000 }, (_, i) => `<div class="row">${i} ${"x".repeat(80)}</div>`);
  const edited = [...big];
  edited[100] = "<div>changed</div>";
  edited.splice(30_000, 0, "<p>inserted</p>");
  edited.splice(45_000, 3);
  let started = performance.now();
  const small = diffTexts(big.join("\n"), edited.join("\n"));
  assert.ok(performance.now() - started < 3000, "small edit in a large page");
  assert.equal(small.exact, true);
  assert.equal(small.added, 2);
  assert.equal(small.removed, 4);

  const other = Array.from({ length: 50_000 }, (_, i) => `<span>${i}</span>`);
  started = performance.now();
  const unrelated = diffTexts(big.join("\n"), other.join("\n"));
  assert.ok(performance.now() - started < 10_000, "unrelated pages hit the edit bound");
  assert.equal(unrelated.exact, false);
  assert.equal(unrelated.removed, 50_000);
  assert.equal(unrelated.added, 50_000);
});

test("collapseDiff keeps context, folds unchanged runs and caps changed lines", () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const b = [...a];
  b[2] = "changed";
  b[15] = "changed too";
  const { rows, truncated } = collapseDiff(diffLines(a, b).lines, { context: 2 });
  assert.equal(truncated, false);
  const shape = rows.map((r) => (r.kind === "skip" ? `skip${r.count}` : r.line.kind));
  assert.deepEqual(shape, [
    "same", "same", "del", "add", "same", "same",
    "skip8",
    "same", "same", "del", "add", "same", "same",
    "skip2",
  ]);
  const capped = collapseDiff(diffLines(a, b).lines, { context: 0, maxChanged: 3 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.rows.filter((r) => r.kind === "line").length, 3);
  assert.deepEqual(collapseDiff(diffLines(a, a).lines), { rows: [], truncated: false });
});
