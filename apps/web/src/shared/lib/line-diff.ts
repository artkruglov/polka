/**
 * Line diff for comparing two versions of a page's source (Myers, O((N+M)·D)).
 * Pure and synchronous; the browser runs it in a worker (line-diff-client.ts).
 * Guards keep a large or very different pair bounded: at most `maxLines`
 * lines per side are compared, and past `maxEdits` differing lines the
 * changed middle is reported as one replacement instead of a minimal diff.
 */
export type DiffLine = {
  kind: "same" | "add" | "del";
  text: string;
  /** 1-based line in the old text (same, del). */
  a?: number;
  /** 1-based line in the new text (same, add). */
  b?: number;
};
export type DiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** false: too many differences, the changed middle is a plain replacement. */
  exact: boolean;
  /** true: at least one side had more than maxLines lines; the rest was not compared. */
  clipped: boolean;
};
export type DiffLimits = { maxLines: number; maxEdits: number };
export const DIFF_LIMITS: DiffLimits = { maxLines: 50_000, maxEdits: 2_500 };

/** Lines of a text; a final newline does not add an empty line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Myers' shortest edit script over interned lines. Returns the edit path as
 * a list of V snapshots, or null when more than maxEdits edits are needed.
 * Snapshot d holds V before round d for diagonals -(d+1)..d+1 only, so memory
 * grows with D², not with D·(N+M).
 */
function editTrace(a: Int32Array, b: Int32Array, maxEdits: number) {
  const n = a.length,
    m = b.length,
    max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

export function diffLines(
  oldLines: string[],
  newLines: string[],
  maxEdits = DIFF_LIMITS.maxEdits,
): Omit<DiffResult, "clipped"> {
  // Common prefix and suffix: the usual edit touches a small middle.
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start++;
  let endOld = oldLines.length,
    endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++)
    lines.push({ kind: "same", text: oldLines[i], a: i + 1, b: i + 1 });

  // Intern the middle so the inner loop compares integers.
  const ids = new Map<string, number>();
  const intern = (list: string[], from: number, to: number) => {
    const out = new Int32Array(to - from);
    for (let i = from; i < to; i++) {
      let id = ids.get(list[i]);
      if (id === undefined) ids.set(list[i], (id = ids.size));
      out[i - from] = id;
    }
    return out;
  };
  const a = intern(oldLines, start, endOld),
    b = intern(newLines, start, endNew);
  const trace = a.length && b.length ? editTrace(a, b, maxEdits) : [];
  let added = 0,
    removed = 0;
  const middle: DiffLine[] = [];
  const same = (x: number, y: number) =>
    middle.push({
      kind: "same",
      text: oldLines[start + x],
      a: start + x + 1,
      b: start + y + 1,
    });
  const del = (x: number) => {
    removed++;
    middle.push({ kind: "del", text: oldLines[start + x], a: start + x + 1 });
  };
  const add = (y: number) => {
    added++;
    middle.push({ kind: "add", text: newLines[start + y], b: start + y + 1 });
  };
  if (!trace || !a.length || !b.length) {
    // One side is empty in the middle, or the sides are too different.
    for (let x = 0; x < a.length; x++) del(x);
    for (let y = 0; y < b.length; y++) add(y);
  } else {
    // Walk the snapshots back from (n, m), collecting the path in reverse.
    const reversed: Array<() => void> = [];
    let x = a.length,
      y = b.length;
    for (let d = trace.length - 1; d >= 0; d--) {
      const snapshot = trace[d],
        at = (k: number) => snapshot[k + d + 1];
      const k = x - y;
      const previousK =
        k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const previousX = d === 0 ? 0 : at(previousK),
        previousY = d === 0 ? 0 : previousX - previousK;
      while (x > previousX && y > previousY) {
        const [sx, sy] = [--x, --y];
        reversed.push(() => same(sx, sy));
      }
      if (d > 0) {
        if (x === previousX) {
          const sy = previousY;
          reversed.push(() => add(sy));
        } else {
          const sx = previousX;
          reversed.push(() => del(sx));
        }
      }
      x = previousX;
      y = previousY;
    }
    for (let i = reversed.length - 1; i >= 0; i--) reversed[i]();
  }
  lines.push(...middle);
  for (let i = 0; i < oldLines.length - endOld; i++)
    lines.push({
      kind: "same",
      text: oldLines[endOld + i],
      a: endOld + i + 1,
      b: endNew + i + 1,
    });
  return { lines, added, removed, exact: trace !== null };
}

/** Diff two texts within the limits; say when a limit was reached. */
export function diffTexts(
  oldText: string,
  newText: string,
  limits: DiffLimits = DIFF_LIMITS,
): DiffResult {
  const oldLines = splitLines(oldText),
    newLines = splitLines(newText);
  const clipped =
    oldLines.length > limits.maxLines || newLines.length > limits.maxLines;
  return {
    ...diffLines(
      oldLines.slice(0, limits.maxLines),
      newLines.slice(0, limits.maxLines),
      limits.maxEdits,
    ),
    clipped,
  };
}

export type DiffRow =
  | { kind: "line"; line: DiffLine }
  | { kind: "skip"; count: number };

/**
 * What to show: changed lines with `context` unchanged lines around them;
 * longer unchanged runs collapse into one "skip" row. Stops after
 * `maxChanged` changed lines and reports that the rest is not shown.
 */
export function collapseDiff(
  lines: DiffLine[],
  { context = 3, maxChanged = 2000 } = {},
): { rows: DiffRow[]; truncated: boolean } {
  const rows: DiffRow[] = [];
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++)
    if (lines[i].kind !== "same")
      for (
        let j = Math.max(0, i - context);
        j <= Math.min(lines.length - 1, i + context);
        j++
      )
        keep[j] = 1;
  let changed = 0,
    skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      skipped++;
      continue;
    }
    if (skipped) rows.push({ kind: "skip", count: skipped });
    skipped = 0;
    if (lines[i].kind !== "same" && ++changed > maxChanged)
      return { rows, truncated: true };
    rows.push({ kind: "line", line: lines[i] });
  }
  if (skipped && rows.length) rows.push({ kind: "skip", count: skipped });
  return { rows, truncated: false };
}
