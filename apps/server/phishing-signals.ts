// Signs that a saved page imitates a bank or a service to collect secrets
// (docs/specs/ABUSE_PROTECTION.md, section 6). This file is the whole list:
// add a pattern here and the scan in html.ts picks it up unchanged.
//
// A page is suspicious when it asks for a secret (a) AND names a brand (b)
// or presses with urgency (c). The aim is to stop the obvious with few false
// alarms; a suspicious link is held for review or reported to the operator,
// never deleted automatically.
//
// Every pattern is matched against one short piece of text at a time (a
// text node, an attribute value, one string literal of a script), never
// across tags, in windows of at most 4 KB. Patterns are plain alternatives
// with small bounded repetitions ({0,6}, {1,3}), so a match attempt costs a
// constant and the scan stays linear in the page: keep them that way (no *,
// + or nested quantifiers).

export type SignalFamily = "secret" | "brand" | "urgency";

type Signal = {
  family: SignalFamily;
  id: string;
  label: string;
  /** Regex source, matched case-insensitively with the u flag. */
  pattern: string;
};

// No letter or digit right before (and, for `end`, right after) the match.
// \b does not know Cyrillic.
const start = "(?<![\\p{L}\\p{N}])";
const end = "(?![\\p{L}\\p{N}])";
const word = (source: string) => `${start}(?:${source})${end}`;
const stem = (source: string) => `${start}(?:${source})`;

/** (a) Asks for a secret: field names, ids, placeholders, labels, script strings. */
// Latin names go without a leading boundary: fields are named userPassword
// or cardNumber as often as password or card_number.
const SECRETS: Signal[] = [
  { family: "secret", id: "password", label: "пароль", pattern: stem("парол[ьяюеи]") },
  { family: "secret", id: "password", label: "пароль", pattern: "pass[\\s_-]?word|passwd" },
  { family: "secret", id: "cvv", label: "CVV/CVC", pattern: "cvv|cvc" },
  {
    family: "secret",
    id: "card-number",
    label: "номер карты",
    pattern: stem("номер\\p{L}{0,6}\\s{1,3}(?:банковской\\s{1,3})?карт"),
  },
  {
    family: "secret",
    id: "card-number",
    label: "номер карты",
    pattern: "card[\\s_-]?(?:number|num)|cc[\\s_-]?number",
  },
  {
    family: "secret",
    id: "sms-code",
    label: "код из SMS",
    pattern: stem("код\\p{L}{0,6}\\s{1,3}из\\s{1,3}(?:смс|sms)|(?:смс|sms)[\\s-]?код"),
  },
  {
    family: "secret",
    id: "sms-code",
    label: "код из SMS",
    pattern: "sms[\\s_-]?code|otp[\\s_-]?code|one[\\s_-]?time[\\s_-]?(?:code|password)",
  },
  {
    family: "secret",
    id: "one-time-code",
    label: "одноразовый код",
    pattern: stem("одноразов\\p{L}{0,6}\\s{1,3}(?:код|парол)"),
  },
];

/** autocomplete tokens that name a secret field. */
export const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
]);

/** (b) Banks and services people are most often phished for. */
const BRANDS: Signal[] = [
  {
    family: "brand",
    id: "sber",
    label: "Сбер",
    // Not «сбережения» (savings).
    pattern: word("сбер(?:банк\\p{L}{0,3}|а|у|ом|е)?|sber(?:bank)?"),
  },
  { family: "brand", id: "tbank", label: "Т-Банк", pattern: word("т[\\s-]?банк\\p{L}{0,6}|t[\\s-]?bank") },
  { family: "brand", id: "tinkoff", label: "Тинькофф", pattern: stem("тинькоф|tinkoff") },
  { family: "brand", id: "alfa", label: "Альфа-Банк", pattern: stem("альфа[\\s-]?банк|alfa[\\s-]?bank") },
  { family: "brand", id: "vtb", label: "ВТБ", pattern: word("втб|vtb") },
  { family: "brand", id: "gazprombank", label: "Газпромбанк", pattern: stem("газпромбанк|gazprombank") },
  { family: "brand", id: "gosuslugi", label: "Госуслуги", pattern: stem("госуслуг|gosuslugi") },
  { family: "brand", id: "pochta", label: "Почта России", pattern: stem("почт\\p{L}{0,6}\\s{1,3}росси|pochta\\s?rossii") },
  { family: "brand", id: "yandex", label: "Яндекс", pattern: stem("яндекс|yandex") },
  { family: "brand", id: "vk", label: "VK", pattern: word("vk|вк|вконтакте|vkontakte") },
  { family: "brand", id: "telegram", label: "Telegram", pattern: stem("telegram|телеграм") },
  { family: "brand", id: "whatsapp", label: "WhatsApp", pattern: stem("whatsapp|ватсап|вотсап") },
  { family: "brand", id: "apple", label: "Apple", pattern: word("apple(?:\\s?id)?|icloud") },
  { family: "brand", id: "google", label: "Google", pattern: word("google|gmail|гугл") },
  { family: "brand", id: "microsoft", label: "Microsoft", pattern: word("microsoft|outlook|office\\s?365") },
  { family: "brand", id: "paypal", label: "PayPal", pattern: word("paypal") },
  { family: "brand", id: "ozon", label: "Ozon", pattern: word("ozon|озон") },
  { family: "brand", id: "wildberries", label: "Wildberries", pattern: stem("wildberries|вайлдберриз") },
  { family: "brand", id: "avito", label: "Авито", pattern: stem("авито|avito") },
];

/** (c) Pressure to act now. */
const URGENCY: Signal[] = [
  { family: "urgency", id: "blocked", label: "«заблокирован»", pattern: stem("заблокир") },
  // «Подтвердите пароль» is the second field of any sign-up form, not pressure.
  { family: "urgency", id: "confirm", label: "«подтвердите»", pattern: `${word("подтвердите")}(?!\\s{1,3}(?:новый\\s{1,3})?парол)` },
  { family: "urgency", id: "urgent", label: "«срочно»", pattern: stem("срочн") },
  { family: "urgency", id: "last-warning", label: "«последнее предупреждение»", pattern: stem("последнее\\s{1,3}предупреждение") },
  { family: "urgency", id: "suspicious-activity", label: "«подозрительная активность»", pattern: stem("подозрительн\\p{L}{0,6}\\s{1,3}(?:активност|вход)") },
  { family: "urgency", id: "verify", label: "«verify»", pattern: word("verify|verification required") },
  { family: "urgency", id: "suspended", label: "«suspended»", pattern: word("suspended") },
  { family: "urgency", id: "unusual-activity", label: "«unusual activity»", pattern: word("unusual\\s{1,3}(?:activity|sign-in|login)") },
];

const compiled = [...SECRETS, ...BRANDS, ...URGENCY].map((signal) => ({
  ...signal,
  key: `${signal.family}:${signal.id}`,
  regex: new RegExp(signal.pattern, "iu"),
}));
const byFamily = (family: SignalFamily) =>
  compiled.filter((signal) => signal.family === family);
const SECRET_SIGNALS = byFamily("secret");
const CONTEXT_SIGNALS = [...byFamily("brand"), ...byFamily("urgency")];

/** Longer pieces are cut: a signal is a phrase, not a document. */
const MAX_PIECE = 4096;

/** A collector for one save: signals found in all its pieces of text. */
export class SignalCollector {
  readonly found = new Set<string>();

  /** A field name, id, placeholder, label or script string: secrets. */
  secret(value: string) {
    this.match(value, SECRET_SIGNALS);
  }

  /** Visible text, titles, script strings: brands and urgency. */
  context(value: string) {
    this.match(value, CONTEXT_SIGNALS);
  }

  add(key: string) {
    this.found.add(key);
  }

  private match(value: string, signals: typeof compiled) {
    if (!value) return;
    // A very long text node is read in overlapping windows, so a phrase at a
    // boundary still matches and every regex run stays short.
    for (let at = 0; at < value.length; at += MAX_PIECE - 64) {
      const piece = value.slice(at, at + MAX_PIECE);
      for (const signal of signals)
        if (!this.found.has(signal.key) && signal.regex.test(piece))
          this.found.add(signal.key);
      if (at + MAX_PIECE >= value.length) break;
    }
  }

  list() {
    return [...this.found].sort();
  }
}

/**
 * A page too deeply nested to read within the deadline (html.ts,
 * inspectHtmlBounded). It cannot be checked, so it counts as suspicious:
 * otherwise nesting would be a way around the check.
 */
export const SCAN_INCOMPLETE = "scan:incomplete";

export const isSuspicious = (signals: readonly string[]) =>
  signals.includes(SCAN_INCOMPLETE) ||
  (signals.some((signal) => signal.startsWith("secret:")) &&
    signals.some(
      (signal) => signal.startsWith("brand:") || signal.startsWith("urgency:"),
    ));

/** Human wording of stored signals, for the operator's mail. */
export function describeSignals(signals: readonly string[]) {
  const labels = new Map(
    compiled.map((signal) => [signal.key, signal.label] as const),
  );
  labels.set("secret:password-field", "поле пароля");
  labels.set("secret:autocomplete", "поле для пароля, кода или карты");
  const part = (family: SignalFamily, title: string) => {
    const names = [
      ...new Set(
        signals
          .filter((signal) => signal.startsWith(`${family}:`))
          .map((signal) => labels.get(signal) ?? signal),
      ),
    ];
    return names.length ? `${title}: ${names.join(", ")}` : null;
  };
  return [
    signals.includes(SCAN_INCOMPLETE)
      ? "страницу не удалось прочитать за отведённое время (глубокая вложенность)"
      : null,
    part("secret", "просит секрет"),
    part("brand", "бренд"),
    part("urgency", "срочность"),
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The strings of a script, read in one pass: quoted and template literals,
 * and text between JSX tags (`<h1>Сбербанк</h1>`). Comments are skipped.
 * Not a JavaScript parser: a regex literal with a quote may swallow the rest
 * of its line, which only costs a missed or extra phrase.
 */
export function scriptStrings(
  source: string,
  visit: (text: string, kind: "literal" | "jsx-text") => void,
) {
  const n = source.length;
  let at = 0;
  while (at < n) {
    const ch = source[at];
    if (ch === "/" && source[at + 1] === "/") {
      const next = source.indexOf("\n", at + 2);
      at = next === -1 ? n : next + 1;
    } else if (ch === "/" && source[at + 1] === "*") {
      const next = source.indexOf("*/", at + 2);
      at = next === -1 ? n : next + 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let end = at + 1;
      while (end < n && source[end] !== ch) {
        if (source[end] === "\\") end += 1;
        else if (ch !== "`" && source[end] === "\n") break;
        end += 1;
      }
      visit(source.slice(at + 1, Math.min(end, n)), "literal");
      at = end + 1;
    } else if (ch === ">") {
      // JSX text runs to the next tag or expression.
      let end = at + 1;
      while (end < n && !"<{};=()\"'`".includes(source[end])) end += 1;
      if (end < n && (source[end] === "<" || source[end] === "{")) {
        const text = source.slice(at + 1, end).trim();
        if (/\p{L}/u.test(text)) visit(text, "jsx-text");
      }
      at = end;
    } else at += 1;
  }
}

/** Signals of a JavaScript/JSX/TypeScript file of a saved bundle. */
export function scanScript(source: string, collector: SignalCollector) {
  // A literal is where a field's name or placeholder lives; JSX text is what
  // the page says, like visible text of a static page.
  scriptStrings(source, (text, kind) => {
    if (kind === "literal") collector.secret(text);
    collector.context(text);
  });
}
