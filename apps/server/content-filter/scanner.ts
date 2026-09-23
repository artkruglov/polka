// The content filter's scan of one document (docs/specs/CONTENT_FILTER.md).
// The HTML walk (html.ts), a script's strings, a text file, a title or a
// comment are fed in piece by piece; result() sums what was found.
//
// Linear in the input: every piece is normalised once, split into words by
// one global regex, and each word costs a hash lookup plus one lookup per
// distinct stem length (a small constant). Phrases are matched against the
// last MAX_PHRASE words, pairs against the last position of each group.
// No regex ever runs over a whole page with unbounded repetition.
import {
  filterLists,
  MAX_PHRASE,
  thresholds,
  type Category,
  type Term,
} from "./lists.ts";
import { RUN, normalizeText, tokens } from "./normalize.ts";
import {
  executableDownload,
  scanCode,
  type CodeSignal,
} from "./code-signals.ts";

export type CategoryHit = {
  score: number;
  /** List terms (ours, never the user's text); empty for detectors. */
  terms: string[];
};
export type FilterResult = {
  v: 1;
  hits: Partial<Record<Category, CategoryHit>>;
  /** Listed domains found in links and text. */
  domains?: string[];
  /** 64-bit SimHash of the visible text (16 hex digits), long texts only. */
  simhash?: string;
  /** data: images the page shows (rules cannot read them). */
  images?: number;
};

const MAX_TERMS = 10;
const MAX_PAIRS_PER_RULE = 5;
/** Only the first words feed the fingerprint and the keyword statistics. */
const MAX_WORDS_TRACKED = 50_000;
const SIMHASH_MIN_WORDS = 60;
const SAMPLE_CHARS = 24_000;
const MAX_SCRIPTS_CHARS = 200_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 2_000_000;

type Index = {
  exact: Map<string, Term[]>;
  stems: Map<string, Term[]>;
  stemLengths: number[];
  /** Every word of every term, for letters spaced apart. */
  vocabulary: Set<string>;
  longest: number;
};

let index: Index | null = null;
function termIndex(): Index {
  if (index) return index;
  const exact = new Map<string, Term[]>();
  const stems = new Map<string, Term[]>();
  const lengths = new Set<number>();
  const vocabulary = new Set<string>();
  let longest = 0;
  for (const list of filterLists().lists)
    for (const term of list.terms) {
      for (const word of term.words) {
        vocabulary.add(word.text);
        longest = Math.max(longest, word.text.length);
      }
      // Indexed by the last word: a phrase is recognised when it ends.
      const last = term.words[term.words.length - 1]!;
      const map = last.stem ? stems : exact;
      if (last.stem) lengths.add(last.text.length);
      map.set(last.text, [...(map.get(last.text) ?? []), term]);
    }
  index = {
    exact,
    stems,
    stemLengths: [...lengths].sort((a, b) => a - b),
    vocabulary,
    longest,
  };
  return index;
}

const wordMatches = (word: Term["words"][number], token: string) =>
  word.stem ? token.startsWith(word.text) : token === word.text;

// Card numbers every payment tutorial shows.
const TEST_CARDS = new Set([
  "4111111111111111",
  "4242424242424242",
  "5555555555554444",
  "5105105105105100",
  "4000000000000002",
  "4012888888881881",
  "378282246310005",
  "2200000000000004",
  "4000056655665556",
  "5200828282828210",
]);

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function snilsValid(digits: string) {
  const body = digits.slice(0, 9);
  if (/^(\d)\1{8}$/.test(body)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (body.charCodeAt(i) - 48) * (9 - i);
  let check = sum < 100 ? sum : sum % 101;
  if (check === 100) check = 0;
  return check === Number(digits.slice(9));
}

// Bounded: at most 26 characters per attempt, so the scan stays linear.
const NUMBER = /\+?\d[\d \-()]{8,24}\d/g;
const PASSPORT_CONTEXT = /паспорт|серия/;
const ADDRESS = /(?:^|[^\p{L}])(?:ул|улица|пр-кт|проспект|пер|переулок|кв|квартира|д|дом)\.?\s{0,2}\d/u;
const SNILS_SHAPE = /^\d{3}-\d{3}-\d{3}[ -]\d{2}$/;
const PASSPORT_SHAPE = /^\d{2} ?\d{2} ?\d{6}$/;

const STYLE_URL = /url\(\s{0,4}["']?([^"')\s]{1,2048})/gi;
const HOST = /^(?:[a-z][a-z0-9+.-]{0,20}:)?\/\/(?:[^@/?#\s]{0,256}@)?([^/?#:\s]{1,253})/i;
const BARE_HOST = /^(?:www\.)?((?:[a-z0-9-]{1,63}\.){1,6}[a-z]{2,24})(?:[/:?#].{0,2000})?$/i;

// FNV-1a, 32-bit.
function fnv(text: string, seed: number) {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class ContentScanner {
  private readonly lists = filterLists();
  private readonly index = termIndex();
  private position = 0;
  private readonly recent: string[] = [];
  private readonly found = new Map<Category, Set<string>>();
  private readonly lastGroup = new Map<string, { position: number; id: string }>();
  private readonly pairs = new Map<string, Map<string, string>>();
  private readonly records = new Map<string, number>();
  private readonly domains = new Set<string>();
  private readonly domainHits = new Map<Category, Set<string>>();
  // Page spam: link farms, keyword stuffing, hidden text.
  private readonly links = new Set<string>();
  private readonly linkHosts = new Set<string>();
  private hiddenChars = 0;
  private hiddenLinks = 0;
  private refresh = false;
  private words = 0;
  private readonly counts = new Map<string, number>();
  private readonly simhash = new Int32Array(64);
  private shingle: string[] = [];
  private sampleText = "";
  private imageCount = 0;
  private readonly codeSignals = new Map<string, CodeSignal>();
  readonly images: string[] = [];

  readonly scripts: string[] = [];
  private scriptChars = 0;

  constructor(
    private readonly options: { images?: boolean; sample?: boolean; scripts?: boolean } = {},
  ) {}

  get scriptsWanted() {
    return !!this.options.scripts;
  }

  get sampleWanted() {
    return !!this.options.sample;
  }

  get imagesWanted() {
    return !!this.options.images;
  }

  /** Visible text, a title, alt text, a script string, a comment. */
  text(value: string) {
    if (!value) return;
    if (this.options.sample && this.sampleText.length < SAMPLE_CHARS)
      this.sampleText += value.slice(0, SAMPLE_CHARS - this.sampleText.length) + " ";
    const normalized = normalizeText(value);
    for (const token of tokens(normalized))
      if (token.startsWith(RUN)) this.run(token.slice(1));
      else this.word(token);
    this.numbers(normalized);
    // Addresses written in the text («rutracker.org», https://…).
    if (normalized.includes(".")) {
      for (const chunk of normalized.split(/\s+/))
        if (chunk.length <= 2300 && chunk.includes(".")) this.textAddress(chunk);
    }
  }

  /** href, src, action and other URL attributes; script strings like URLs. */
  url(value: string) {
    const host = HOST.exec(value.trim())?.[1];
    if (host) this.host(host);
  }

  /** An <a>/<area> href: counted for link farms, checked like any URL. */
  link(value: string) {
    const trimmed = value.trim();
    const host = HOST.exec(trimmed)?.[1];
    if (!host) return;
    this.host(host);
    if (this.links.size < 10_000) this.links.add(trimmed.slice(0, 300));
    if (this.linkHosts.size < 10_000) this.linkHosts.add(host.toLowerCase());
  }

  /** CSS: a style attribute or a <style> element. */
  css(value: string) {
    if (!value.includes("url(")) return;
    STYLE_URL.lastIndex = 0;
    for (let match = STYLE_URL.exec(value); match; match = STYLE_URL.exec(value))
      this.url(match[1]!);
  }

  /** Text inside an element hidden by CSS or the hidden attribute. */
  hidden(chars: number, link = false) {
    this.hiddenChars += chars;
    if (link) this.hiddenLinks += 1;
  }

  metaRefresh() {
    this.refresh = true;
  }

  /** A script: inline, a bundle file, an event handler, a javascript: URL. */
  code(source: string) {
    scanCode(source, this.codeSignals);
    if (this.options.scripts && this.scriptChars < MAX_SCRIPTS_CHARS && source.trim()) {
      const piece = source.slice(0, MAX_SCRIPTS_CHARS - this.scriptChars);
      this.scripts.push(piece);
      this.scriptChars += piece.length;
    }
  }

  /** An <a download> link: an executable from data:/blob: is a strong signal. */
  download(href: string, name: string) {
    if (executableDownload(href, name) && !this.codeSignals.has("executable-download"))
      this.codeSignals.set("executable-download", {
        id: "executable-download",
        label: "ссылка на скачивание исполняемого файла",
        weight: 10,
      });
  }

  /** A data: image of the page, kept for the image classifier. */
  image(dataUri: string) {
    this.imageCount += 1;
    if (
      this.options.images &&
      this.images.length < MAX_IMAGES &&
      dataUri.length <= MAX_IMAGE_BASE64 &&
      /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(dataUri)
    )
      this.images.push(dataUri);
  }

  /** The first few thousand characters of visible text (for the model). */
  sample() {
    return this.sampleText.trim();
  }

  private host(raw: string) {
    const host = raw.toLowerCase().replace(/\.$/, "");
    const labels = host.split(".");
    if (labels[labels.length - 1] === "onion") {
      this.domainHit("blocklisted_domain", "*.onion");
      return;
    }
    for (let i = 0; i < labels.length - 1 && i < 8; i++) {
      const candidate = labels.slice(i).join(".");
      const category = this.lists.domains.get(candidate);
      if (category) {
        this.domainHit(category, candidate);
        return;
      }
    }
  }

  private textAddress(chunk: string) {
    const trimmed = chunk.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}/]+$/gu, "");
    const host = HOST.exec(trimmed)?.[1] ?? BARE_HOST.exec(trimmed)?.[1];
    if (host) this.host(host);
  }

  private domainHit(category: Category, domain: string) {
    if (this.domains.size < 50) this.domains.add(domain);
    const set = this.domainHits.get(category) ?? new Set();
    set.add(domain);
    this.domainHits.set(category, set);
  }

  private word(token: string) {
    this.position += 1;
    if (this.words < MAX_WORDS_TRACKED) {
      this.words += 1;
      if ([...token].length >= 4 && !/^\d+$/.test(token))
        this.counts.set(token, (this.counts.get(token) ?? 0) + 1);
      this.fingerprint(token);
    }
    this.recent.push(token);
    if (this.recent.length > MAX_PHRASE) this.recent.shift();
    const { exact, stems, stemLengths } = this.index;
    const candidates: Term[] = [...(exact.get(token) ?? [])];
    for (const length of stemLengths) {
      if (length > token.length) break;
      const terms = stems.get(token.slice(0, length));
      if (terms) candidates.push(...terms);
    }
    for (const term of candidates) {
      const n = term.words.length;
      if (n > this.recent.length) continue;
      let ok = true;
      for (let i = 0; i < n - 1 && ok; i++)
        ok = wordMatches(term.words[i]!, this.recent[this.recent.length - n + i]!);
      if (ok) this.hit(term);
    }
  }

  /**
   * Letters spaced apart («к у п и т ь м е ф»), joined into one run: the
   * words of the lists found in it, longest first, in order. Bounded by the
   * run's length times the longest list word.
   */
  private run(joined: string) {
    const { vocabulary, longest } = this.index;
    const chars = [...joined];
    let found = false;
    for (let at = 0; at < chars.length; ) {
      let matched = 0;
      for (let length = Math.min(longest, chars.length - at); length >= 2; length--)
        if (vocabulary.has(chars.slice(at, at + length).join(""))) {
          matched = length;
          break;
        }
      if (matched) {
        this.word(chars.slice(at, at + matched).join(""));
        found = true;
        at += matched;
      } else at += 1;
    }
    if (!found) this.word(joined);
  }

  private hit(term: Term) {
    const set = this.found.get(term.category) ?? new Set<string>();
    set.add(term.id);
    this.found.set(term.category, set);
    if (!term.group) return;
    const list = this.lists.lists.find((item) => item.category === term.category)!;
    const key = `${term.category}:${term.group}`;
    this.lastGroup.set(key, { position: this.position, id: term.id });
    for (const [ruleIndex, rule] of list.pairs.entries()) {
      const other =
        rule.a === term.group ? rule.b : rule.b === term.group ? rule.a : null;
      if (!other) continue;
      const last = this.lastGroup.get(`${term.category}:${other}`);
      if (!last || this.position - last.position > rule.window) continue;
      if (last.id === term.id) continue;
      // A pair counts once per distinct word of its second group (the
      // intent: купить, доставка, вступайте), whichever first word it met:
      // five substances next to one «купить» are one sale, while «купить,
      // доставка, закладки» are three signs of one.
      const [first, second] =
        rule.a === term.group ? [term.id, last.id] : [last.id, term.id];
      const pairKey = `${term.category}#${ruleIndex}`;
      const pairs = this.pairs.get(pairKey) ?? new Map<string, string>();
      if (pairs.size < MAX_PAIRS_PER_RULE && !pairs.has(second))
        pairs.set(second, `${first} + ${second}`);
      this.pairs.set(pairKey, pairs);
    }
  }

  private fingerprint(token: string) {
    this.shingle.push(token);
    if (this.shingle.length > 3) this.shingle.shift();
    if (this.shingle.length < 3) return;
    const text = this.shingle.join(" ");
    const low = fnv(text, 2166136261);
    const high = fnv(text, 84696351);
    for (let bit = 0; bit < 32; bit++) {
      this.simhash[bit]! += (low >>> bit) & 1 ? 1 : -1;
      this.simhash[bit + 32]! += (high >>> bit) & 1 ? 1 : -1;
    }
  }

  // Personal data in bulk: СНИЛС, cards, passports, phones next to addresses.
  private numbers(normalized: string) {
    if (!/\d{3}/.test(normalized)) return;
    const passport = PASSPORT_CONTEXT.test(normalized);
    const address = ADDRESS.test(normalized);
    NUMBER.lastIndex = 0;
    for (let match = NUMBER.exec(normalized); match; match = NUMBER.exec(normalized)) {
      const raw = match[0];
      const digits = raw.replace(/\D/g, "");
      let record: string | null = null;
      if (digits.length === 11 && SNILS_SHAPE.test(raw) && snilsValid(digits))
        record = `snils:${digits}`;
      else if (
        digits.length >= 15 &&
        digits.length <= 19 &&
        /^[2-6]/.test(digits) &&
        !TEST_CARDS.has(digits) &&
        luhn(digits)
      )
        record = `card:${digits}`;
      else if (digits.length === 10 && passport && PASSPORT_SHAPE.test(raw))
        record = `passport:${digits}`;
      else if (
        digits.length === 11 &&
        /^[78]/.test(digits) &&
        address &&
        !SNILS_SHAPE.test(raw)
      )
        record = `contact:${digits.slice(1)}`;
      if (record && this.records.size < 1000) this.records.set(record, 3);
    }
  }

  result(phishing: readonly string[] = []): FilterResult {
    const hits: FilterResult["hits"] = {};
    for (const list of this.lists.lists) {
      const found = this.found.get(list.category);
      let score = 0;
      const terms: string[] = [];
      for (const term of list.terms)
        if (found?.has(term.id) && term.weight > 0) {
          score += term.weight;
          terms.push(term.id);
        }
      for (const [ruleIndex, rule] of list.pairs.entries()) {
        const pairs = this.pairs.get(`${list.category}#${ruleIndex}`);
        if (!pairs) continue;
        score += pairs.size * rule.weight;
        terms.push(...pairs.values());
      }
      if (score > 0)
        hits[list.category] = { score, terms: terms.slice(0, MAX_TERMS) };
    }
    // doxxing: records from the detectors add to the listed phrases.
    if (this.records.size) {
      const kinds = new Map<string, number>();
      for (const record of this.records.keys()) {
        const kind = record.slice(0, record.indexOf(":"));
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      const label: Record<string, string> = {
        snils: "СНИЛС",
        card: "номер карты",
        passport: "паспорт",
        contact: "телефон с адресом",
      };
      const previous = hits.doxxing ?? { score: 0, terms: [] };
      hits.doxxing = {
        score: previous.score + this.records.size * 3,
        terms: [
          ...previous.terms,
          ...[...kinds].map(([kind, n]) => `${label[kind]} ×${n}`),
        ].slice(0, MAX_TERMS),
      };
    }
    for (const [category, domains] of this.domainHits) {
      const previous = hits[category] ?? { score: 0, terms: [] };
      hits[category] = {
        score: previous.score + domains.size * 6,
        terms: [...previous.terms, ...domains].slice(0, MAX_TERMS),
      };
    }
    const fraud = fraudScore(phishing);
    if (fraud) hits.fraud = fraud;
    const spam = this.spam();
    if (spam) hits.spam = spam;
    if (this.codeSignals.size) {
      const signals = [...this.codeSignals.values()];
      hits.malicious_code = {
        score: signals.reduce((sum, signal) => sum + signal.weight, 0),
        terms: signals.map((signal) => signal.label).slice(0, MAX_TERMS),
      };
    }
    const result: FilterResult = { v: 1, hits };
    if (this.domains.size) result.domains = [...this.domains].slice(0, 20);
    if (this.imageCount) result.images = this.imageCount;
    if (this.words >= SIMHASH_MIN_WORDS) {
      let low = 0,
        high = 0;
      for (let bit = 0; bit < 32; bit++) {
        if (this.simhash[bit]! > 0) low |= 1 << bit;
        if (this.simhash[bit + 32]! > 0) high |= 1 << bit;
      }
      result.simhash =
        (high >>> 0).toString(16).padStart(8, "0") +
        (low >>> 0).toString(16).padStart(8, "0");
    }
    return result;
  }

  private spam(): CategoryHit | null {
    let score = 0;
    const terms: string[] = [];
    if (this.links.size >= 60) {
      score += 4;
      terms.push(`внешних ссылок: ${this.links.size}`);
    }
    if (this.linkHosts.size >= 25) {
      score += 3;
      terms.push(`разных сайтов в ссылках: ${this.linkHosts.size}`);
    }
    if (this.hiddenChars >= 200 || this.hiddenLinks >= 5) {
      score += 4;
      terms.push("скрытый текст или ссылки");
    }
    if (this.refresh) {
      score += 3;
      terms.push("автоматическая переадресация");
    }
    if (this.words >= 300) {
      let top = 0,
        word = "";
      for (const [token, count] of this.counts)
        if (count > top) [top, word] = [count, token];
      if (top / this.words >= 0.06) {
        score += 4;
        terms.push(`повтор слова «${word.slice(0, 30)}»: ${Math.round((100 * top) / this.words)}%`);
      }
    }
    return score ? { score, terms } : null;
  }
}

/** Phishing signals (phishing-signals.ts) as the fraud category. */
export function fraudScore(signals: readonly string[]): CategoryHit | null {
  const has = (prefix: string) => signals.some((signal) => signal.startsWith(prefix));
  if (signals.includes("scan:incomplete"))
    return { score: 6, terms: ["страница не прочитана за отведённое время"] };
  if (!has("secret:") || !(has("brand:") || has("urgency:"))) return null;
  const score = 4 + (has("brand:") ? 3 : 0) + (has("urgency:") ? 3 : 0);
  return {
    score,
    terms: signals.filter((signal) => !signal.startsWith("link:")).slice(0, MAX_TERMS),
  };
}

/** One short text on its own: a title, a comment, a text file. */
export function scanText(value: string) {
  const scanner = new ContentScanner();
  scanner.text(value);
  return scanner.result();
}

/** Two results of one work (the page and its title) as one. */
export function mergeResults(
  ...results: Array<FilterResult | null | undefined>
): FilterResult {
  const merged: FilterResult = { v: 1, hits: {} };
  const domains = new Set<string>();
  for (const result of results) {
    if (!result?.hits) continue;
    for (const [category, hit] of Object.entries(result.hits) as [Category, CategoryHit][]) {
      const previous = merged.hits[category];
      merged.hits[category] = previous
        ? {
            score: previous.score + hit.score,
            terms: [...new Set([...previous.terms, ...hit.terms])].slice(0, MAX_TERMS),
          }
        : { score: hit.score, terms: [...hit.terms] };
    }
    for (const domain of result.domains ?? []) domains.add(domain);
    if (result.simhash && !merged.simhash) merged.simhash = result.simhash;
    if (result.images) merged.images = (merged.images ?? 0) + result.images;
  }
  if (domains.size) merged.domains = [...domains].slice(0, 20);
  return merged;
}

export type Level = "none" | "flag" | "high" | "block";

/** How far a score goes for its category. */
export function levelOf(category: Category, score: number): Level {
  const { threshold, high, block } = thresholds(category);
  if (block !== null && score >= block) return "block";
  if (score >= high) return "high";
  if (score >= threshold) return "flag";
  return "none";
}
