// Signs that a saved page imitates a bank or a service to collect secrets
// (docs/specs/ABUSE_PROTECTION.md, section 6). This file is the whole list:
// add a pattern here and the scan in html.ts picks it up unchanged.
//
// Nothing typed into a page on Полка can leave it: the viewer forbids
// connections, form submission, navigation of the top window and popups
// (connect-src 'none', form-action 'none', img-src data:, the sandbox;
// html.ts, project-viewer.ts), WebRTC is removed, and external links go
// through the signed /away page. A login form, a brand name and
// «подтвердите» are what every prototype of a B2B product shows; on their
// own they steal nothing. The risk is a page that sends the reader OFF the
// page: tell the code to someone, write to a Telegram account, call a
// number, transfer money, open a look-alike of a bank's site. So a page is
// suspicious only with an off-page channel (d) or a look-alike domain (e);
// a request for a secret (a), a brand (b) and urgency (c) only add to its
// score (content-filter/fraud-score.ts). The aim is to stop the obvious with
// few false alarms; a suspicious link is held for review or reported to the
// operator, never deleted automatically.
//
// Every pattern is matched against one short piece of text at a time (a
// text node, an attribute value, one string literal of a script), never
// across tags, in windows of at most 4 KB. Patterns are plain alternatives
// with small bounded repetitions ({0,6}, {1,3}, {0,60}), so a match attempt
// costs a constant and the scan stays linear in the page: keep them that way
// (no *, + or unbounded nesting; a GAP of three short words is the most).

import { domainToUnicode } from "node:url";
import { ContentScanner } from "./content-filter/scanner.ts";
import { SensitiveInputDetector } from "./content-filter/sensitive-input.ts";
import { fraudScoreOf } from "./content-filter/fraud-score.ts";

export type SignalFamily = "secret" | "brand" | "urgency" | "channel" | "lookalike";

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

// (d) Off-page channels: the page tells the reader to hand something over
// outside it. «Не сообщайте код» is the usual warning, not a request.
// A verb as a whole word, the checks behind it made after it matched (a
// lookbehind before the verb would run at every position of the text).
const word1 = (verbs: string) => `(?:${verbs})(?<![\\p{L}\\p{N}](?:${verbs}))`;
const lead = (verbs: string) =>
  `${word1(verbs)}(?<!(?:не|never|not|n't)\\s{1,3}(?:${verbs}))`;
// Up to three short words between a verb and its object: «сообщите нам
// полученный код».
const GAP = "(?:\\s{1,3}[\\p{L}\\p{N}-]{1,14}){0,3}?\\s{1,3}";
// A secret named so that it cannot be program code: «код из SMS», «пароль».
const NAMED_SECRET =
  "(?:код\\p{L}{0,3}\\s{1,3}(?:из|с|подтвержден)|(?:смс|sms)[\\s-]?код|одноразов\\p{L}{0,4}\\s{1,3}(?:код|парол)|парол|пин[\\s-]?код|cvv|cvc|(?:данные|номер|реквизиты)\\s{1,3}(?:вашей\\s{1,3})?карт)";
// Telling a secret goes to a person by itself: «продиктуйте код».
const TELL_RU = "сообщите|сообщи|продиктуйте|продиктуй|назовите|назови|скажите|скажи";
// Sending one needs an addressee: «отправьте код подтверждения повторно» is
// a button of a sign-in form, «пришлите нам пароль» and «отправьте код из
// SMS в Telegram» are not.
const SEND_RU = "отправьте|отправь|пришлите|перешлите|скиньте|скинь|передайте|передай";
const TO_SOMEONE_RU =
  "нам|мне|оператору|сотруднику|специалисту|менеджеру|администратору|куратору";
const DESTINATION =
  "в\\s{1,3}(?:telegram|телеграм|whatsapp|ватсап|вотсап|viber|вайбер|чат|личн|ответ|поддержк)|на\\s{1,3}(?:почту|email|e-mail|адрес|номер)|(?<![\\p{L}\\p{N}_.])@[a-z][a-z0-9_]{3,31}|t\\.me\\/|wa\\.me\\/|нам|мне|оператор|сотрудник|менеджер|to\\s{1,3}(?:us|me|our|the\\s{1,3}(?:agent|operator|support))";
const EN_SECRET = `(?:(?:sms|verification|security|one[\\s-]?time|2fa|otp|login|confirmation)\\s{1,3}code|password|pin|cvv|cvc|card\\s{1,3}(?:number|details))${end}`;
const TRANSFER_RU =
  "переведите|переведи|перечислите|перечисли|оплатите|оплати|пополните|пополни|внесите|внеси|скиньте|скинь|отправьте|отправь";
const CONTACT_RU =
  "напишите|напиши|пишите|отправьте|отправь|пришлите|перешлите|сообщите|сообщи|свяжитесь|обратитесь";
const CALL_RU = "позвоните|позвони|звоните|звони|перезвоните|перезвони|наберите|набери";
const PHONE = "\\+?\\d[\\d\\s()-]{8,16}\\d";
const CHANNELS: Signal[] = [
  {
    family: "channel",
    id: "handover",
    label: "просит передать код, пароль или данные карты",
    pattern: [
      `${lead(`${TELL_RU}`)}${GAP}(?:${NAMED_SECRET}|код)`,
      `${lead(`${SEND_RU}`)}\\s{1,3}(?:${TO_SOMEONE_RU})${GAP}${NAMED_SECRET}`,
      `${lead(`${SEND_RU}`)}${GAP}${NAMED_SECRET}[^!?\\n]{0,40}?${start}(?:${DESTINATION})`,
    ].join("|"),
  },
  {
    family: "channel",
    id: "handover",
    label: "просит передать код, пароль или данные карты",
    pattern: [
      `${lead(`tell|give|read\\s{1,3}out`)}(?:\\s{1,3}(?:us|me|the|your|this|that|our)){0,3}\\s{1,3}${EN_SECRET}`,
      `${lead(`send|share|forward|text|dm`)}\\s{1,3}(?:us|me)(?:\\s{1,3}(?:the|your|this|that)){0,2}\\s{1,3}${EN_SECRET}`,
      `${lead(`send|share|forward|text|reply\\s{1,3}with`)}(?:\\s{1,3}(?:the|your|this|that)){0,2}\\s{1,3}${EN_SECRET}[^!?\\n]{0,40}?${start}(?:${DESTINATION})`,
    ].join("|"),
  },
  {
    family: "channel",
    id: "transfer",
    label: "просит перевести деньги",
    pattern: `${lead(`${TRANSFER_RU}`)}[^!?\\n]{0,60}?(?:на|по)\\s{1,3}(?:карт\\p{L}{0,3}|сч[её]т\\p{L}{0,2}|кошел\\p{L}{0,4}|номер\\p{L}{0,2}|телефон\\p{L}{0,2})[^!?\\n]{0,30}?\\d{4}`,
  },
  {
    family: "channel",
    id: "transfer",
    label: "просит перевести деньги",
    pattern: `${lead(`transfer|send|pay|wire|deposit`)}[^!?\\n]{0,60}?to\\s{1,3}(?:(?:the|this|my|our)\\s{1,3})?(?:card|account|wallet)[^!?\\n]{0,30}?\\d{4}`,
  },
  {
    family: "channel",
    id: "messenger",
    label: "Telegram или WhatsApp вне страницы",
    pattern: `${word1(`${CONTACT_RU}|write|message|text|dm|contact|send`)}[^!?\\n]{0,60}?(?:t\\.me\\/|telegram\\.me\\/|wa\\.me\\/|whatsapp\\.com\\/|(?<![\\p{L}\\p{N}_.@])@[a-z][a-z0-9_]{3,31}(?![\\p{L}\\p{N}_@])|в\\s{1,3}(?:telegram|телеграм|whatsapp|ватсап|вотсап|viber|вайбер))`,
  },
  {
    family: "channel",
    id: "phone",
    label: "просит позвонить",
    pattern: `${word1(`${CALL_RU}|call`)}[^!?\\n]{0,40}?${PHONE}|${PHONE}[^!?\\n]{0,40}?(?:${CALL_RU}|${TELL_RU})${end}`,
  },
  {
    family: "channel",
    id: "email",
    label: "просит прислать письмо",
    pattern: `${word1(`${CONTACT_RU}|send|email|e-mail|reply`)}[^!?\\n]{0,60}?(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}\\.[a-z0-9.-]{2,60}`,
  },
];

const compiled = [...SECRETS, ...BRANDS, ...URGENCY, ...CHANNELS].map((signal) => ({
  ...signal,
  key: `${signal.family}:${signal.id}`,
  regex: new RegExp(signal.pattern, "iu"),
}));
const byFamily = (family: SignalFamily) =>
  compiled.filter((signal) => signal.family === family);
const SECRET_SIGNALS = byFamily("secret");
const CONTEXT_SIGNALS = [...byFamily("brand"), ...byFamily("urgency")];
const CHANNEL_SIGNALS = byFamily("channel");
// Every channel pattern (and the wallet's) needs one of these verbs: one
// cheap pass over a piece spares the rest on most text.
const CHANNEL_GATE =
  /переве|перечисл|оплат|пополн|внес|скин|отправ|пришл|перешл|переда|сообщ|продикт|назов|скаж|напиш|пиш|свяж|обрат|звон|перезв|набер|send|share|tell|give|read|forward|text|dm|reply|transfer|pay|wire|deposit|write|message|contact|call|mail/i;

// A crypto wallet with a request to send to it, in one piece of text. Case
// matters for base58, so no i flag on the address.
const WALLET =
  /(?<![A-Za-z0-9])(?:bc1[ac-hj-np-z02-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33})(?![A-Za-z0-9])/;
const WALLET_VERB = new RegExp(
  `${start}(?:переведите|переведи|отправьте|отправь|пополните|пришлите|send|transfer|deposit)${end}`,
  "iu",
);

// (e) Look-alike domains: a brand inside a host that is not the brand's.
// Official hosts are matched on the host as written (punycode stays
// punycode); the brand is looked for after decoding IDN and reading
// look-alike letters (Cyrillic «а», digits «0», «1», «3») as Latin.
const BRAND_HOSTS: Array<{ id: string; tokens: string[]; official: string[] }> = [
  {
    id: "yandex",
    tokens: ["yandex", "yndx"],
    official: ["yandex.ru", "yandex.com", "yandex.net", "yandex.by", "yandex.kz", "yandex.uz", "yandex.com.tr", "yandex.com.am", "yandex.com.ge", "yandex.cloud", "yandex-team.ru", "yandex.st", "ya.ru", "yastatic.net", "yandex.eu"],
  },
  { id: "apple", tokens: ["apple", "appleid", "icloud"], official: ["apple.com", "icloud.com", "apple.news", "me.com", "mzstatic.com", "cdn-apple.com", "apple-mapkit.com", "apple-cloudkit.com", "apple-dns.net"] },
  {
    id: "google",
    tokens: ["google", "gmail"],
    official: ["google.com", "google.ru", "google.by", "google.kz", "google.co.uk", "google.de", "googleapis.com", "gstatic.com", "googleusercontent.com", "google-analytics.com", "googletagmanager.com", "gmail.com", "googlemail.com", "withgoogle.com"],
  },
  { id: "microsoft", tokens: ["microsoft", "office365", "outlook"], official: ["microsoft.com", "office.com", "office365.com", "outlook.com", "live.com", "microsoftonline.com", "azure.com", "windows.net"] },
  { id: "paypal", tokens: ["paypal"], official: ["paypal.com", "paypal.me", "paypalobjects.com"] },
  { id: "sber", tokens: ["sber", "sberbank"], official: ["sberbank.ru", "sber.ru", "sberbank.com", "sberbank-ast.ru"] },
  { id: "tbank", tokens: ["tbank", "t-bank", "tinkoff"], official: ["tbank.ru", "tinkoff.ru", "tinkoff.com"] },
  { id: "alfa", tokens: ["alfabank", "alfa-bank"], official: ["alfabank.ru", "alfabank.com", "alfa-bank.info"] },
  { id: "vtb", tokens: ["vtb"], official: ["vtb.ru", "vtb.com", "vtb24.ru"] },
  { id: "gazprombank", tokens: ["gazprombank"], official: ["gazprombank.ru"] },
  { id: "gosuslugi", tokens: ["gosuslugi", "gosuslugl"], official: ["gosuslugi.ru"] },
  { id: "pochta", tokens: ["pochta"], official: ["pochta.ru"] },
  { id: "vk", tokens: ["vk", "vkontakte"], official: ["vk.com", "vk.ru", "vk.me", "vk.cc", "vkontakte.ru", "userapi.com", "vk-portal.net", "vk-cdn.net", "vkuser.net", "vk.link"] },
  { id: "telegram", tokens: ["telegram", "telegramm"], official: ["telegram.org", "telegram.me", "t.me", "telegra.ph"] },
  { id: "whatsapp", tokens: ["whatsapp"], official: ["whatsapp.com", "whatsapp.net", "wa.me"] },
  { id: "ozon", tokens: ["ozon"], official: ["ozon.ru", "ozon.com", "ozon.kz", "ozon.by", "ozon.travel", "ozone.ru"] },
  { id: "wildberries", tokens: ["wildberries"], official: ["wildberries.ru", "wildberries.by", "wildberries.kz", "wb.ru"] },
  { id: "avito", tokens: ["avito"], official: ["avito.ru", "avito.st"] },
];
const BRAND_HOST_TOKENS = BRAND_HOSTS.map((brand) => ({
  ...brand,
  regex: new RegExp(`(?:^|[^a-z])(?:${brand.tokens.join("|")})(?:[^a-z]|$)`),
}));
const isOfficial = (host: string, official: readonly string[]) =>
  official.some((domain) => host === domain || host.endsWith(`.${domain}`));
const ALL_OFFICIAL = BRAND_HOSTS.flatMap((brand) => brand.official);
// Latin look-alikes of Cyrillic letters in a host, and digits for letters.
const HOMOGLYPHS: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p",
  с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ӏ: "l", ԁ: "d", ɡ: "g",
};
const LEET: Record<string, string> = { "0": "o", "1": "l", "3": "e" };
// Words of a sign-in page, in a host or a path: yandex-360-login.ru,
// apple-id-verify.com, example.com/signin.
const LOGIN_WORDS =
  /(?:^|[^a-z])(?:log-?in|sign-?in|signon|auth|oauth|verify|verification|secure|security|account|accounts|passport|password|id|2fa|otp|confirm|unlock|recovery|support)(?:[^a-z]|$)/;
// An address as written: with a scheme or // (group 1: host, group 2: the
// rest), or a bare host with a dot (group 3: host, group 4: the rest).
const ADDRESS =
  /^(?:[a-z][a-z0-9+.-]{0,20}:)?\/\/(?:[^@/?#\s]{0,256}@)?([^/?#:\s]{1,253})(?::\d{1,5})?([/?#][^\s]{0,2000})?$|^(?:www\.)?((?:[\p{L}\p{N}-]{1,63}\.){1,6}[\p{L}]{2,24})([/?#:][^\s]{0,2000})?$/iu;
const TEXT_TLD =
  /\.(?:ru|рф|su|com|net|org|info|biz|io|app|me|online|site|xyz|top|by|kz|ua|uz|am|ge|cc|link|page|shop|store|pro|club|live|co|uk|de|us|eu|tech|website|space|click|cloud|support|help|services|center|finance|bank|pay|money|icu|vip|win|tk|ml|ga|cf|gq)$/u;
/** At most this many addresses per save are looked at. */
const MAX_ADDRESSES = 5_000;

/** Longer pieces are cut: a signal is a phrase, not a document. */
const MAX_PIECE = 4096;

/**
 * A collector for one save: signals found in all its pieces of text. The
 * content filter (content-filter/scanner.ts) reads the same pieces.
 */
export class SignalCollector {
  readonly found = new Set<string>();
  readonly content: ContentScanner;
  /** Fields for a password, a card, a code (content-filter/sensitive-input.ts). */
  readonly sensitive = new SensitiveInputDetector();

  constructor(options: ConstructorParameters<typeof ContentScanner>[0] = {}) {
    this.content = new ContentScanner(options);
  }

  /** A field name, id, placeholder, label or script string: secrets. */
  secret(value: string) {
    this.match(value, SECRET_SIGNALS);
  }

  /**
   * Visible text, titles, script strings: brands, urgency, off-page
   * channels, and addresses written in the text.
   */
  context(value: string) {
    this.match(value, CONTEXT_SIGNALS);
    this.content.text(value);
    if (value.includes(".") && this.addresses < MAX_ADDRESSES)
      for (const chunk of value.split(/\s+/)) {
        if (this.addresses >= MAX_ADDRESSES) break;
        if (chunk.length > 3 && chunk.length <= 2300 && chunk.includes("."))
          this.address(chunk.replace(/^[^\p{L}\p{N}/]{1,20}|[^\p{L}\p{N}/]{1,20}$/gu, ""), true);
      }
  }

  /**
   * An address the page links to, loads or shows: a look-alike of a brand's
   * domain, or a sign-in page elsewhere.
   */
  address(value: string, text = false) {
    if (this.addresses >= MAX_ADDRESSES) return;
    this.addresses += 1;
    const match = ADDRESS.exec(value.trim().slice(0, 2300));
    if (!match) return;
    const raw = (match[1] ?? match[3] ?? "").toLowerCase().replace(/\.$/, "");
    if (!raw.includes(".")) return;
    const rest = (match[2] ?? match[4] ?? "").toLowerCase();
    // An attribute without a scheme is a relative path («apple.html»). A
    // bare word with a dot in the text («file.ts», «Yandex.Market») is no
    // address either: only a host on a common top-level domain counts.
    if (!match[1] && (!text || !TEXT_TLD.test(raw))) return;
    let unicode = raw;
    try {
      unicode = domainToUnicode(raw) || raw;
    } catch {}
    let latin = "";
    for (const ch of unicode) latin += HOMOGLYPHS[ch] ?? ch;
    let digits = "";
    for (const ch of latin) digits += LEET[ch] ?? ch;
    for (const brand of BRAND_HOST_TOKENS) {
      if (!brand.regex.test(latin) && !brand.regex.test(digits)) continue;
      if (isOfficial(raw, brand.official)) continue;
      this.found.add(`lookalike:${brand.id}`);
      if (LOGIN_WORDS.test(latin) || LOGIN_WORDS.test(rest))
        this.found.add("channel:lookalike-login");
    }
    // A sign-in page on another site, linked or named with its scheme.
    if (
      match[1] &&
      /^(?:https?:)?\/\//i.test(value.trim()) &&
      LOGIN_WORDS.test(rest.split(/[?#]/, 1)[0] ?? "") &&
      !isOfficial(raw, ALL_OFFICIAL)
    )
      this.found.add("channel:login-link");
  }

  add(key: string) {
    this.found.add(key);
  }

  private addresses = 0;

  private match(value: string, signals: typeof compiled) {
    if (!value) return;
    // A very long text node is read in overlapping windows, so a phrase at a
    // boundary still matches and every regex run stays short.
    for (let at = 0; at < value.length; at += MAX_PIECE - 64) {
      const piece = value.slice(at, at + MAX_PIECE);
      for (const signal of signals)
        if (!this.found.has(signal.key) && signal.regex.test(piece))
          this.found.add(signal.key);
      if (signals === CONTEXT_SIGNALS && CHANNEL_GATE.test(piece)) {
        for (const signal of CHANNEL_SIGNALS)
          if (!this.found.has(signal.key) && signal.regex.test(piece))
            this.found.add(signal.key);
        if (
          !this.found.has("channel:crypto") &&
          WALLET.test(piece) &&
          WALLET_VERB.test(piece)
        )
          this.found.add("channel:crypto");
      }
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

/**
 * The page reaches the fraud score (content-filter/fraud-score.ts): an
 * off-page channel or a look-alike domain with enough around it, or a page
 * that could not be read.
 */
export const isSuspicious = (signals: readonly string[]) =>
  signals.includes(SCAN_INCOMPLETE) || fraudScoreOf(signals).suspicious;

/** Human wording of stored signals, for the operator's mail. */
export function describeSignals(signals: readonly string[]) {
  const labels = new Map(
    compiled.map((signal) => [signal.key, signal.label] as const),
  );
  labels.set("secret:password-field", "поле пароля");
  labels.set("secret:autocomplete", "поле для пароля, кода или карты");
  labels.set("channel:crypto", "просит перевести криптовалюту");
  labels.set("channel:lookalike-login", "вход на сайте под видом бренда");
  labels.set("channel:login-link", "ссылка на страницу входа другого сайта");
  for (const brand of BRAND_HOSTS)
    labels.set(`lookalike:${brand.id}`, `адрес под видом ${brand.id}`);
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
    part("channel", "уводит со страницы"),
    part("lookalike", "похожий домен"),
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
    if (kind === "literal") {
      collector.secret(text);
      // An address in a string: fetch("https://…"), <a href={"…"}>.
      if (/^(?:https?:)?\/\//i.test(text)) {
        collector.content.url(text);
        collector.address(text);
      }
    }
    collector.context(text);
  });
  collector.content.code(source);
  collector.sensitive.script(source);
}
