// Patch edits: `[{oldText, newText}]` applied to one text file of a revision
// (docs/specs/COMMENTS.md, «Агенты»). Each oldText must match exactly once:
// first as written, then normalized (NFKC per character, typographic quotes
// and dashes, special spaces, CRLF and trailing whitespace of each line).
// Only the matched spans change; every other byte of the file is kept, so a
// normalized match never rewrites the rest of the document.
//
// Adapted from the edit engine of just-html (lib/docs/edit-diff.ts, MIT,
// © 2026 Kernel Technologies, Inc.), itself adapted from pi's coding-agent
// edit tool (github.com/earendil-works/pi, packages/coding-agent/src/core/
// tools/edit-diff.ts): the same order (exact, then normalized), the same
// refusals (empty, not found, several matches, overlap, no change) with the
// index of the failing edit. Unlike both, a normalized match is mapped back
// to the original text instead of normalizing the whole document.
import type { EditFailure } from "../../packages/contracts/comments.ts";
import { Problem } from "./errors.ts";

export type Edit = { oldText: string; newText: string };

/** A refused patch: HTTP 422 with the failing edit named. */
export class EditFailed extends Problem {
  constructor(readonly failure: EditFailure) {
    super(422, "invalid", failure.message, failure);
  }
}

const QUOTES: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u201f": '"',
  "\u00ab": '"',
  "\u00bb": '"',
};
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/;
const SPACES = /[\u00a0\u2002-\u200a\u202f\u205f\u3000]/;

/** One character (code point) as the fuzzy match sees it. */
function normalizeChar(char: string) {
  return [...char.normalize("NFKC")]
    .map((c) =>
      QUOTES[c] ?? (DASHES.test(c) ? "-" : SPACES.test(c) ? " " : c),
    )
    .join("");
}

/**
 * The normalized text and, for each of its characters, the span of the
 * original it came from. Trailing whitespace of a line is dropped; CRLF and
 * lone CR become LF.
 */
function normalizeWithMap(text: string) {
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  const flushTrailing = () => {
    while (chars.length && /^[^\S\n]$/.test(chars[chars.length - 1]!)) {
      chars.pop();
      from.pop();
      to.pop();
    }
  };
  while (at < text.length) {
    const cp = text.codePointAt(at)!;
    const width = cp > 0xffff ? 2 : 1;
    if (text[at] === "\r") {
      const end = text[at + 1] === "\n" ? at + 2 : at + 1;
      flushTrailing();
      chars.push("\n");
      from.push(at);
      to.push(end);
      at = end;
      continue;
    }
    if (text[at] === "\n") flushTrailing();
    for (const c of normalizeChar(text.slice(at, at + width))) {
      chars.push(c);
      from.push(at);
      to.push(at + width);
    }
    at += width;
  }
  flushTrailing();
  return { text: chars.join(""), from, to };
}

const normalize = (text: string) => normalizeWithMap(text).text;

function occurrences(haystack: string, needle: string, limit = 50) {
  const found: number[] = [];
  let from = 0;
  let at: number;
  while ((at = haystack.indexOf(needle, from)) !== -1) {
    found.push(at);
    if (found.length >= limit) break;
    from = at + 1;
  }
  return found;
}

function fail(failure: Omit<EditFailure, "code">): never {
  throw new EditFailed({ code: "edit_failed", ...failure });
}

type Match = { index: number; start: number; end: number; newText: string };

/**
 * Applies every edit to the same base text. Throws EditFailed naming the
 * first edit that cannot be applied; returns the new text otherwise.
 */
export function applyEdits(content: string, edits: Edit[]): string {
  const several = edits.length > 1;
  const name = (i: number) => (several ? `Правка ${i + 1}` : "Правка");
  let normalized: ReturnType<typeof normalizeWithMap> | null = null;
  const matches: Match[] = [];
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText)
      fail({
        editIndex: index,
        reason: "empty_old_text",
        message: `${name(index)}: oldText пуст. Укажите текст, который нужно заменить.`,
      });
    const exact = occurrences(content, edit.oldText);
    if (exact.length > 1)
      fail({
        editIndex: index,
        reason: "ambiguous",
        occurrences: exact.length,
        message: `${name(index)}: oldText встречается в документе ${exact.length >= 50 ? "50 и более" : exact.length} раз. Добавьте окружающий текст, чтобы место было единственным.`,
      });
    if (exact.length === 1) {
      matches.push({
        index,
        start: exact[0]!,
        end: exact[0]! + edit.oldText.length,
        newText: edit.newText,
      });
      continue;
    }
    normalized ??= normalizeWithMap(content);
    const needle = normalize(edit.oldText);
    const fuzzy = needle ? occurrences(normalized.text, needle) : [];
    if (fuzzy.length === 0)
      fail({
        editIndex: index,
        reason: "not_found",
        message: `${name(index)}: oldText не найден в документе ни точно, ни после нормализации (NFKC, кавычки, тире, пробелы в конце строк). Скопируйте текст из текущей версии.`,
      });
    if (fuzzy.length > 1)
      fail({
        editIndex: index,
        reason: "ambiguous",
        occurrences: fuzzy.length,
        message: `${name(index)}: после нормализации oldText встречается ${fuzzy.length >= 50 ? "50 и более" : fuzzy.length} раз. Добавьте окружающий текст.`,
      });
    const first = fuzzy[0]!;
    const last = first + needle.length - 1;
    matches.push({
      index,
      start: normalized.from[first]!,
      end: normalized.to[last]!,
      newText: edit.newText,
    });
  }
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (previous.end > current.start) {
      const [first, second] =
        previous.index < current.index
          ? [previous.index, current.index]
          : [current.index, previous.index];
      fail({
        editIndex: first,
        otherEditIndex: second,
        reason: "overlap",
        message: `Правки ${first + 1} и ${second + 1} задевают один и тот же текст. Объедините их в одну или разведите по разным местам.`,
      });
    }
  }
  let result = content;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const match = ordered[i]!;
    result =
      result.slice(0, match.start) + match.newText + result.slice(match.end);
  }
  if (result === content)
    fail({
      editIndex: 0,
      reason: "no_change",
      message: "Правки не меняют документ: новый текст совпадает со старым.",
    });
  return result;
}
