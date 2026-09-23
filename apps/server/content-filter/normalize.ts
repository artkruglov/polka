// Text normalisation for the content filter (docs/specs/CONTENT_FILTER.md,
// «Откуда берутся признаки»). The same functions prepare the lists and the
// text, so a term matches however it was typed: case, ё/й, compatibility
// forms (ｎａｒｋｏ, ᴘᴏʀɴ), invisible characters, Latin look-alikes inside a
// Cyrillic word, digits inside a Latin word, and letters spaced apart.
//
// Everything here is linear in the input: one pass of a global regex with no
// nested quantifiers, and per-token work bounded by the token's length.

// Zero-width, soft hyphen, combining grapheme joiner, bidi controls, variation
// selectors, Hangul fillers: invisible characters that split a word.
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const MARKS = /\p{Mn}/gu;

/**
 * NFKC, lower case, no invisible characters, no diacritics (so ё is е and й
 * is и, in the lists as well).
 */
export function normalizeText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(INVISIBLE, "")
    .normalize("NFD")
    .replace(MARKS, "")
    .normalize("NFC");
}

// Latin letters and digits that pass for Cyrillic ones inside a Cyrillic word.
const TO_CYRILLIC: Record<string, string> = {
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  k: "к",
  m: "м",
  n: "п",
  o: "о",
  p: "р",
  r: "г",
  t: "т",
  u: "и",
  x: "х",
  y: "у",
  i: "и",
  "0": "о",
  "3": "з",
  "4": "ч",
  "6": "б",
};
// Digits that pass for letters inside a Latin word (p0rn, c4sino).
const TO_LATIN: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
};
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LETTER = /\p{L}/u;
const DIGITS = /^\p{N}+$/u;

/**
 * One word as the lists see it: look-alikes read in the word's own script.
 * A word of digits only stays as it is (1488 is a term).
 */
export function canonicalToken(token: string) {
  if (DIGITS.test(token)) return token;
  if (CYRILLIC.test(token)) {
    let out = "";
    for (const ch of token) out += TO_CYRILLIC[ch] ?? ch;
    return out;
  }
  if (!LETTER.test(token)) return token;
  let out = "";
  for (const ch of token) out += TO_LATIN[ch] ?? ch;
  return out;
}

/** Marks a run of spaced letters among the words tokens() yields. */
export const RUN = "\u0000";

/**
 * Canonical words of normalised text, in order. Three or more single letters
 * in a row, separated by at most two other characters each («н а р к о»,
 * «н.а.р.к.о»), come as one more item marked with RUN: the scanner looks
 * for the words of its lists inside it.
 */
export function* tokens(normalized: string): Generator<string> {
  // Its own regex: generators may interleave, a shared lastIndex would not.
  const WORD = /[\p{L}\p{N}]+/gu;
  let run = "";
  let runEnd = -1;
  let runCount = 0;
  const flush = function* () {
    if (runCount >= 3) yield RUN + canonicalToken(run);
    run = "";
    runCount = 0;
  };
  for (let match = WORD.exec(normalized); match; match = WORD.exec(normalized)) {
    const word = match[0];
    const single = [...word].length === 1 && LETTER.test(word);
    if (single) {
      if (runCount && match.index - runEnd > 2) yield* flush();
      run += word;
      runCount += 1;
      runEnd = match.index + word.length;
    } else if (runCount) yield* flush();
    yield canonicalToken(word);
  }
  if (runCount) yield* flush();
}
