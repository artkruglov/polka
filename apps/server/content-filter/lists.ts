// The lists of the content filter: one file per category in ./lists
// (format in lists/README.md). Read once per process (and once per
// classifier worker); a malformed line is an error at start-up, not a
// silently ignored term.
import { readFileSync } from "node:fs";
import { canonicalToken, normalizeText } from "./normalize.ts";

export const CATEGORIES = [
  "csam",
  "extremism_terror",
  "drugs",
  "weapons_explosives",
  "doxxing",
  "porn",
  "suicide",
  "gambling",
  "piracy",
  "blocklisted_domain",
  "fraud",
  "spam",
  "vpn",
  "malicious_code",
  // Only by the operator (a rights holder's claim), never by the filter.
  "copyright",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories read from term lists (the others come from detectors). */
export const LISTED: readonly Category[] = [
  "csam",
  "extremism_terror",
  "drugs",
  "weapons_explosives",
  "doxxing",
  "porn",
  "suicide",
  "gambling",
  "piracy",
  "vpn",
];

export type Word = { text: string; stem: boolean };
export type Term = {
  id: string;
  category: Category;
  words: Word[];
  weight: number;
  group: string | null;
};
export type PairRule = {
  a: string;
  b: string;
  window: number;
  weight: number;
};
export type CategoryList = {
  category: Category;
  threshold: number;
  high: number;
  /** csam only: the score that blocks without review. */
  block: number | null;
  pairs: PairRule[];
  terms: Term[];
};

/** A stem shorter than this matches too much. */
export const MIN_STEM = 4;
export const MAX_PHRASE = 4;

const listUrl = (name: string) => new URL(`./lists/${name}`, import.meta.url);

export function parseList(category: Category, source: string): CategoryList {
  const list: CategoryList = {
    category,
    threshold: 6,
    high: 10,
    block: null,
    pairs: [],
    terms: [],
  };
  const seen = new Set<string>();
  for (const [index, raw] of source.split("\n").entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const fail = (why: string): never => {
      throw new Error(`content-filter/lists/${category}.txt:${index + 1}: ${why}`);
    };
    if (line.startsWith("@")) {
      const [directive, ...args] = line.split(/\s+/);
      const number = (value: string | undefined) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100)
          fail(`${directive} needs a whole number`);
        return parsed;
      };
      if (directive === "@threshold") list.threshold = number(args[0]);
      else if (directive === "@high") list.high = number(args[0]);
      else if (directive === "@block") list.block = number(args[0]);
      else if (directive === "@pair") {
        if (args.length !== 4) fail("@pair <group> <group> <window> <weight>");
        list.pairs.push({
          a: args[0]!,
          b: args[1]!,
          window: number(args[2]),
          weight: number(args[3]),
        });
      } else fail(`unknown directive ${directive}`);
      continue;
    }
    const [body, groupPart] = line.split("|").map((part) => part.trim());
    const match = /^(\d{1,2})\s+(.+)$/.exec(body!);
    if (!match) fail("expected «<weight> <term> [| group]»");
    const weight = Number(match![1]);
    const words = normalizeText(match![2]!)
      .split(/\s+/)
      .filter(Boolean)
      .map((word): Word => {
        const stem = word.endsWith("*");
        const text = canonicalToken(stem ? word.slice(0, -1) : word);
        if (!/^[\p{L}\p{N}]+$/u.test(text))
          fail(`«${word}»: a term is letters and digits (split words by spaces)`);
        if (stem && [...text].length < MIN_STEM)
          fail(`«${word}»: a stem needs at least ${MIN_STEM} letters`);
        return { text, stem };
      });
    if (!words.length || words.length > MAX_PHRASE)
      fail(`a term is 1–${MAX_PHRASE} words`);
    const group = groupPart || null;
    if (group !== null && !/^[a-z_]{2,20}$/.test(group))
      fail(`group «${group}»: lowercase latin letters`);
    if (weight === 0 && group === null) fail("a weight of 0 needs a group");
    const id = match![2]!.trim().replace(/\s+/g, " ");
    if (seen.has(id)) fail(`«${id}» is listed twice`);
    seen.add(id);
    list.terms.push({ id, category, words, weight, group });
  }
  const groups = new Set(list.terms.map((term) => term.group).filter(Boolean));
  for (const pair of list.pairs)
    for (const group of [pair.a, pair.b])
      if (!groups.has(group))
        throw new Error(
          `content-filter/lists/${category}.txt: @pair names a group «${group}» with no terms`,
        );
  if (list.high < list.threshold)
    throw new Error(`content-filter/lists/${category}.txt: @high below @threshold`);
  return list;
}

export type DomainEntry = { domain: string; category: Category };

export function parseDomains(source: string) {
  const domains = new Map<string, Category>();
  for (const [index, raw] of source.split("\n").entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [domain, category = "blocklisted_domain", ...rest] = line.split(/\s+/);
    if (
      rest.length ||
      !/^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/.test(domain!) ||
      !(CATEGORIES as readonly string[]).includes(category)
    )
      throw new Error(`content-filter/lists/domains.txt:${index + 1}: «${line}»`);
    domains.set(domain!, category as Category);
  }
  return domains;
}

/** Addresses from throwaway mail services, refused at sign-up. */
export function parseEmailDomains(source: string) {
  const domains = new Set<string>();
  for (const [index, raw] of source.split("\n").entries()) {
    const line = raw.replace(/#.*$/, "").trim().toLowerCase();
    if (!line) continue;
    if (!/^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(line))
      throw new Error(`content-filter/lists/disposable_email.txt:${index + 1}: «${line}»`);
    domains.add(line);
  }
  return domains;
}

let loaded: {
  lists: CategoryList[];
  domains: Map<string, Category>;
  disposable: Set<string>;
} | null = null;

export function filterLists() {
  if (!loaded)
    loaded = {
      lists: LISTED.map((category) =>
        parseList(category, readFileSync(listUrl(`${category}.txt`), "utf8")),
      ),
      domains: parseDomains(readFileSync(listUrl("domains.txt"), "utf8")),
      disposable: parseEmailDomains(
        readFileSync(listUrl("disposable_email.txt"), "utf8"),
      ),
    };
  return loaded;
}

/** Thresholds of every category, the detector ones included. */
export function thresholds(category: Category) {
  const list = filterLists().lists.find((item) => item.category === category);
  if (list) return { threshold: list.threshold, high: list.high, block: list.block };
  return DETECTOR_THRESHOLDS[category];
}

const DETECTOR_THRESHOLDS: Record<
  Category,
  { threshold: number; high: number; block: number | null }
> = {
  csam: { threshold: 6, high: 12, block: 12 },
  extremism_terror: { threshold: 6, high: 10, block: null },
  drugs: { threshold: 6, high: 10, block: null },
  weapons_explosives: { threshold: 6, high: 10, block: null },
  // Three distinct records (3 points each) are a list; six are a large one.
  doxxing: { threshold: 9, high: 18, block: null },
  porn: { threshold: 6, high: 10, block: null },
  suicide: { threshold: 6, high: 10, block: null },
  gambling: { threshold: 6, high: 10, block: null },
  piracy: { threshold: 6, high: 10, block: null },
  // One listed domain flags a page; three make it «high».
  blocklisted_domain: { threshold: 6, high: 18, block: null },
  // phishing-signals: a secret with a brand or urgency; all three is high.
  fraud: { threshold: 6, high: 10, block: null },
  spam: { threshold: 6, high: 10, block: null },
  vpn: { threshold: 6, high: 10, block: null },
  // Intent in code (code-signals.ts): a miner or an executable alone is high.
  malicious_code: { threshold: 6, high: 10, block: null },
  copyright: { threshold: 6, high: 10, block: null },
};
