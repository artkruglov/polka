// Does a page ask the reader for a secret? (docs/specs/CONTENT_FILTER.md,
// «Поля для секретов»). The recipient page warns about passwords, SMS codes
// and cards only when it does, or when nobody has looked yet: a report or a
// dashboard with a search box and sliders gets a quiet line instead.
//
// Read from the stored source at save time, in the same walk as the content
// filter (html.ts, phishing-signals.ts): form fields of a page (type,
// autocomplete, name, id, placeholder, aria-label, title, label text) and the
// text of scripts, which may build the same fields at run time (JSX,
// createElement, an HTML string). The code is never run.
//
// Unlike the phishing signal «secret» (any script string that mentions a
// password), a script's names and placeholders count here only when the
// script makes a text field at all, and a field's name only when it is an
// identifier, not a phrase: chart data about password resets is not a form.
//
// Linear: values are short (≤ 200 characters) and matched against patterns
// with bounded repetition; a script is walked by global regexes with bounded
// repetition, at most MAX_MATCHES times each.

export type SensitiveInput = {
  /** The page has a field for a password, a card, a one-time code or a seed phrase. */
  sensitive: boolean;
  /** Which kinds, as stable ids (SENSITIVE_SIGNALS), at most MAX_SIGNALS. */
  signals: string[];
};

/** Stable signal ids, in the order they are listed. */
export const SENSITIVE_SIGNALS = [
  "password-field",
  "autocomplete-password",
  "autocomplete-card",
  "autocomplete-otp",
  "password",
  "login-password",
  "card-number",
  "card-cvv",
  "card-expiry",
  "otp",
  "pin",
  "seed-phrase",
  "prompt",
] as const;
export type SensitiveSignal = (typeof SENSITIVE_SIGNALS)[number];

const MAX_SIGNALS = SENSITIVE_SIGNALS.length;
const MAX_VALUE = 200;
const MAX_LABELS = 200;
const MAX_MATCHES = 5_000;
const MAX_SCRIPT = 8_000_000;

// No letter or digit right before / after. \b does not know Cyrillic.
const W = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

/**
 * What a field's name, placeholder or label says it is for. The value is
 * normalised first: camelCase and snake_case become words, so cardNumber,
 * card_number and «Card number» read the same.
 */
const KINDS: Array<[SensitiveSignal | "login", RegExp]> = (
  [
    [
      "password",
      `${W}парол[ьяюеи]|${W}(?:pass\\s?word|passwd|pwd|passcode)${E}`,
    ],
    [
      "card-number",
      `${W}(?:card\\s?(?:number|num|no)|cc\\s?(?:number|num)|credit\\s?card|debit\\s?card)${E}` +
        `|${W}номер\\p{L}{0,6}\\s{1,3}(?:банковской\\s{1,3}|платёжной\\s{1,3}|платежной\\s{1,3})?карт`,
    ],
    ["card-cvv", `${W}(?:cvv|cvc|csc|cvv2|cvc2|security\\s?code)${E}`],
    [
      "card-expiry",
      `${W}(?:card|cc)\\s?exp(?:iry|iration|ires)?${E}` +
        `|${W}срок\\p{L}{0,6}\\s{1,3}действия\\s{1,3}(?:банковской\\s{1,3})?карт` +
        `|^(?:mm|мм)\\s?/\\s?(?:yy|yyyy|гг|гггг)$`,
    ],
    [
      "otp",
      `${W}(?:otp|totp|2fa|mfa)${E}` +
        `|${W}one\\s?time\\s?(?:code|password|pin)` +
        `|${W}(?:sms|смс)\\s?(?:code|код)` +
        `|${W}код\\p{L}{0,6}\\s{1,3}из\\s{1,3}(?:смс|sms)` +
        `|${W}одноразов\\p{L}{0,6}\\s{1,3}(?:код|парол)` +
        `|${W}verification\\s?code|${W}код\\p{L}{0,3}\\s{1,3}подтвержден` +
        `|${W}two\\s?factor`,
    ],
    // «pin» alone names a map pin as often as a PIN: only the whole value,
    // or «PIN code», «пин-код».
    ["pin", `^(?:pin|пин)$|${W}(?:pin|пин)\\s?(?:code|код)${E}`],
    [
      "seed-phrase",
      `${W}(?:seed|recovery|secret(?:\\s?recovery)?)\\s?(?:phrase|words)` +
        `|${W}mnemonic|${W}мнемоническ|${W}сид\\s?фраз|${W}секретн\\p{L}{0,4}\\s{1,3}фраз` +
        `|${W}private\\s?key|${W}приватн\\p{L}{0,4}\\s{1,3}ключ`,
    ],
    ["login", `${W}(?:login|log\\s?in|username|user\\s?name|логин)${E}`],
  ] as const
).map(([kind, source]) => [kind, new RegExp(source, "iu")]);

/** A field's name or label as words: userPassword → «user password». */
export function fieldWords(value: string) {
  return value
    .slice(0, MAX_VALUE)
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]:#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The kinds a field's name, placeholder or label names. */
export function fieldKinds(value: string): Array<SensitiveSignal | "login"> {
  const words = fieldWords(value);
  if (!words) return [];
  return KINDS.filter(([, pattern]) => pattern.test(words)).map(
    ([kind]) => kind,
  );
}

/** autocomplete tokens (WHATWG autofill) of a secret. */
export function autocompleteKinds(value: string): SensitiveSignal[] {
  const kinds = new Set<SensitiveSignal>();
  for (const token of value.toLowerCase().split(/\s+/).slice(0, 8)) {
    if (token === "current-password" || token === "new-password")
      kinds.add("autocomplete-password");
    else if (token === "one-time-code") kinds.add("autocomplete-otp");
    else if (token.startsWith("cc-")) kinds.add("autocomplete-card");
  }
  return [...kinds];
}

// Input types that take no typed text: their names say nothing about secrets.
const NOT_TEXT = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);
// A field's own words. `title` and aria-label are what a screen reader reads.
const NAMING = new Set(["name", "id", "placeholder", "aria-label", "title"]);

// Scripts. A script "makes a field" when it has one of these.
const MAKES_FIELD =
  /<input\b|<textarea\b|createElement\(\s{0,3}["'`](?:input|textarea)["'`]|<(?:Input|TextField|TextInput|PasswordInput|InputOTP|OTPInput)\b/i;
// type="password", type: 'password', .type = "password", setAttribute("type","password"),
// an HTML string <input type=password>, and the show/hide toggle "text" : "password".
const PASSWORD_TYPE =
  /type\s{0,3}[=:]\s{0,3}\{?\s{0,3}\\?["'`]password\\?["'`]|setAttribute\(\s{0,3}["'`]type["'`]\s{0,3},\s{0,3}["'`]password["'`]|<input\b[^>]{0,300}type=password(?![\w-])|["'`]password["'`]\s{0,3}:\s{0,3}["'`]text["'`]|["'`]text["'`]\s{0,3}:\s{0,3}["'`]password["'`]/i;
const AUTOCOMPLETE =
  /auto-?complete\s{0,3}[=:]\s{0,3}\{?\s{0,3}\\?["'`]([^"'`\\\n]{1,100})|setAttribute\(\s{0,3}["'`]autocomplete["'`]\s{0,3},\s{0,3}["'`]([^"'`\n]{1,100})/gi;
// name / id: identifiers only (field names are identifiers, chart labels are
// phrases); placeholder and aria-label: any short text. Not title: a
// chart's title is not a field's.
const NAMED =
  /(?<![\w$-])(?:name|id|htmlFor|for)\s{0,3}[=:]\s{0,3}\{?\s{0,3}\\?["'`]([\p{L}\p{N}_.[\]-]{1,60})\\?["'`]|(?<![\w$-])(?:placeholder|aria-label|ariaLabel)\s{0,3}[=:]\s{0,3}\{?\s{0,3}\\?["'`]([^"'`\\\n]{1,200})|setAttribute\(\s{0,3}["'`](?:name|id|placeholder|aria-label)["'`]\s{0,3},\s{0,3}["'`]([^"'`\n]{1,200})/giu;
// <label …>Пароль</label>, <Label>, <FormLabel> in JSX or an HTML string.
const LABEL = /<(?:label|FormLabel)\b[^>]{0,300}>\s{0,20}([^<{]{1,120})/giu;
// window.prompt("Введите пароль") asks for the secret without any form.
const PROMPT =
  /(?<![\w$.])(?:window\.)?prompt\s{0,3}\(\s{0,3}["'`]([^"'`\n]{1,200})/gu;

function* matches(pattern: RegExp, source: string) {
  pattern.lastIndex = 0;
  let n = 0;
  for (
    let match = pattern.exec(source);
    match && n < MAX_MATCHES;
    match = pattern.exec(source)
  ) {
    n++;
    if (match[0].length === 0) pattern.lastIndex++;
    yield match;
  }
}

/** One save's detector: HTML fields and scripts go in, one verdict comes out. */
export class SensitiveInputDetector {
  private readonly found = new Set<SensitiveSignal>();
  private login = false;
  private textFields = 0;
  private readonly labels: string[] = [];

  /** An element of a page (only fields matter). */
  element(tag: string, attrs: ReadonlyArray<{ name: string; value: string }>) {
    if (tag !== "input" && tag !== "textarea") return;
    const attr = (name: string) =>
      attrs.find((item) => item.name.toLowerCase() === name)?.value;
    const type =
      tag === "input"
        ? (attr("type") ?? "text").trim().toLowerCase()
        : "textarea";
    if (type === "password") this.found.add("password-field");
    if (NOT_TEXT.has(type)) return;
    this.textFields++;
    for (const { name, value } of attrs) {
      const key = name.toLowerCase();
      if (key === "autocomplete")
        for (const kind of autocompleteKinds(value)) this.found.add(kind);
      else if (NAMING.has(key)) this.named(value);
    }
  }

  /** Text of a <label> (counted once the page has a text field). */
  label(text: string) {
    const value = text.trim();
    if (value && value.length <= 120 && this.labels.length < MAX_LABELS)
      this.labels.push(value);
  }

  /** A script: inline, a bundle file, a component's source, an event handler. */
  script(source: string) {
    if (!source) return;
    const text =
      source.length > MAX_SCRIPT ? source.slice(0, MAX_SCRIPT) : source;
    if (PASSWORD_TYPE.test(text)) this.found.add("password-field");
    for (const match of matches(AUTOCOMPLETE, text))
      for (const kind of autocompleteKinds(match[1] ?? match[2] ?? ""))
        this.found.add(kind);
    for (const match of matches(PROMPT, text))
      if (fieldKinds(match[1]!).some((kind) => kind !== "login"))
        this.found.add("prompt");
    if (!MAKES_FIELD.test(text)) return;
    this.textFields++;
    for (const match of matches(NAMED, text))
      this.named(match[1] ?? match[2] ?? match[3] ?? "");
    for (const match of matches(LABEL, text)) this.label(match[1]!);
  }

  private named(value: string) {
    for (const kind of fieldKinds(value))
      if (kind === "login") this.login = true;
      else this.found.add(kind);
  }

  result(): SensitiveInput {
    if (this.textFields) for (const label of this.labels) this.named(label);
    if (
      this.login &&
      (this.found.has("password") ||
        this.found.has("password-field") ||
        this.found.has("autocomplete-password"))
    )
      this.found.add("login-password");
    const signals = SENSITIVE_SIGNALS.filter((signal) =>
      this.found.has(signal),
    ).slice(0, MAX_SIGNALS);
    return { sensitive: signals.length > 0, signals };
  }
}

/** The detector over one script alone (tests, the backfill). */
export function scriptSensitiveInput(source: string) {
  const detector = new SensitiveInputDetector();
  detector.script(source);
  return detector.result();
}

/** Several verdicts of one work (pages and scripts of a bundle) as one. */
export function mergeSensitive(
  ...results: Array<SensitiveInput | null | undefined>
): SensitiveInput | null {
  const signals = new Set<string>();
  let unknown = false;
  for (const result of results) {
    if (!result) unknown = true;
    else for (const signal of result.signals) signals.add(signal);
  }
  const ordered = SENSITIVE_SIGNALS.filter((signal) => signals.has(signal));
  if (ordered.length) return { sensitive: true, signals: ordered };
  return unknown ? null : { sensitive: false, signals: [] };
}

/** The fields kept in revisions.content_filter (absent: not known yet). */
export function sensitiveFields(result: SensitiveInput | null | undefined) {
  if (!result) return {};
  return {
    sensitiveInput: result.sensitive,
    ...(result.signals.length ? { sensitiveSignals: result.signals } : {}),
  };
}

/** What the recipient is told: true, false, or null for a revision saved before. */
export function sensitiveInputOf(contentFilter: unknown): boolean | null {
  const value = (contentFilter as { sensitiveInput?: unknown } | null)
    ?.sensitiveInput;
  return typeof value === "boolean" ? value : null;
}
