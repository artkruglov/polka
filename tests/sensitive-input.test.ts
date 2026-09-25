// Does a page ask the reader for a secret? (docs/specs/CONTENT_FILTER.md,
// «Поля для секретов»): the detector on pages, scripts and components, the
// negatives a report or a dashboard must pass, bounded time, and the
// recipient's note built from the verdict. No database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectHtml } from "../apps/server/html.ts";
import { SignalCollector, scanScript } from "../apps/server/phishing-signals.ts";
import {
  fieldKinds,
  mergeSensitive,
  scriptSensitiveInput,
  sensitiveFields,
  sensitiveInputOf,
} from "../apps/server/content-filter/sensitive-input.ts";
import { autoCheckedClean } from "../apps/server/content-filter/policy.ts";
import {
  CHECKED,
  NOT_CHECKED,
  NOTE_ASKS,
  NOTE_QUIET,
  NOTE_UNKNOWN,
  recipientNote,
} from "../apps/web/src/entities/recipient-note/copy.ts";

const page = (body: string) => {
  const inspection = inspectHtml(
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
  );
  assert.equal(inspection.filter.sensitiveInput, inspection.sensitive!.sensitive);
  return inspection.sensitive!;
};

test("a password field, autocomplete tokens and named fields are found", () => {
  assert.deepEqual(page('<input type="password">').signals, ["password-field"]);
  assert.deepEqual(page("<input type=PASSWORD name=x>").signals, ["password-field"]);
  assert.deepEqual(page('<input autocomplete="cc-number">').signals, ["autocomplete-card"]);
  assert.deepEqual(page('<input autocomplete="cc-exp">').signals, ["autocomplete-card"]);
  assert.deepEqual(page('<input autocomplete="one-time-code" inputmode="numeric">').signals, [
    "autocomplete-otp",
  ]);
  assert.deepEqual(page('<input autocomplete="section-a current-password">').signals, [
    "autocomplete-password",
  ]);
  assert.deepEqual(page('<input autocomplete="new-password" type="text">').signals, [
    "autocomplete-password",
  ]);
  const positives: Array<[string, string]> = [
    ['<input name="userPassword">', "password"],
    ['<input placeholder="Пароль">', "password"],
    ['<input aria-label="Введите пароль от почты">', "password"],
    ['<input id="cardNumber">', "card-number"],
    ['<input placeholder="Номер карты">', "card-number"],
    ['<input placeholder="Номер банковской карты">', "card-number"],
    ['<input name="card_cvv" maxlength="3">', "card-cvv"],
    ['<input placeholder="CVC">', "card-cvv"],
    ['<input placeholder="ММ/ГГ">', "card-expiry"],
    ['<input placeholder="Срок действия карты">', "card-expiry"],
    ['<input name="cc-exp">', "card-expiry"],
    ['<input name="otp">', "otp"],
    ['<input placeholder="Код из SMS">', "otp"],
    ['<input placeholder="SMS code">', "otp"],
    ['<input placeholder="Одноразовый код">', "otp"],
    ['<input placeholder="PIN-код">', "pin"],
    ['<input name="pin" maxlength="4">', "pin"],
    ['<textarea placeholder="Seed phrase (12 words)"></textarea>', "seed-phrase"],
    ['<textarea placeholder="Мнемоническая фраза"></textarea>', "seed-phrase"],
    ['<label for="k">Пароль</label><input id="k">', "password"],
    ['<label>Номер карты <input name="n"></label>', "card-number"],
  ];
  for (const [html, signal] of positives) {
    const found = page(html);
    assert.equal(found.sensitive, true, html);
    assert.ok(found.signals.includes(signal), `${html}: ${found.signals}`);
  }
  const pair = page('<input name="login"><input name="password" type="text">');
  assert.deepEqual(pair.signals, ["password", "login-password"]);
});

test("a dashboard with a search box and sliders, a comment box and a name field is not sensitive", () => {
  const dashboard = page(`
    <h1>Продажи за квартал</h1>
    <p>Сбросов пароля в поддержке стало меньше на 12%; средний чек по картам вырос.</p>
    <input type="search" name="q" placeholder="Поиск по отчёту" aria-label="Поиск">
    <input type="range" id="year" min="2020" max="2026">
    <input type="range" name="pin" aria-label="Порог">
    <label><input type="checkbox" name="compare"> Сравнить с прошлым годом</label>
    <label><input type="radio" name="view" value="card"> Карточки</label>
    <select name="region"><option>Москва</option></select>
    <label for="name">Имя</label><input id="name" name="name" placeholder="Как вас зовут">
    <input type="email" name="email" placeholder="Почта">
    <textarea name="comment" placeholder="Комментарий"></textarea>
    <input type="hidden" name="password_policy" value="v2">
    <button type="submit">Отправить</button>
    <script>
      const data = [{ name: "Сбросы пароля", value: 12 }, { name: "Оплата картой", value: 40 }];
      document.querySelector("input[type=range]").oninput = (e) => draw(e.target.value);
      const title = "Password resets";
    </script>`);
  assert.deepEqual(dashboard, { sensitive: false, signals: [] });
  // Text about passwords is not a field.
  assert.equal(page("<p>Никому не сообщайте код из SMS и пароль.</p>").sensitive, false);
  assert.equal(page('<input placeholder="Поиск">').sensitive, false);
  assert.equal(page('<input name="footprint"><input name="passport">').sensitive, false);
});

test("scripts that build fields at run time: JSX, createElement, HTML strings", () => {
  const jsx = `export default function App() {
    const [show, setShow] = useState(false);
    return <form><label htmlFor="u">Логин</label><input id="u" />
      <input type={show ? "text" : "password"} autoComplete="current-password" /></form>;
  }`;
  const found = scriptSensitiveInput(jsx);
  assert.equal(found.sensitive, true);
  assert.ok(found.signals.includes("password-field"), found.signals.join());
  assert.ok(found.signals.includes("autocomplete-password"));
  assert.ok(found.signals.includes("login-password"));
  assert.ok(scriptSensitiveInput('const i = document.createElement("input"); i.type = "password";').sensitive);
  assert.ok(scriptSensitiveInput(`el.setAttribute("type", "password")`).sensitive);
  assert.ok(scriptSensitiveInput(`root.innerHTML = '<input type=password name=p>';`).sensitive);
  assert.ok(scriptSensitiveInput(`root.innerHTML = "<input name=\\"cardNumber\\">";`).sensitive);
  assert.ok(scriptSensitiveInput(`<input placeholder="Код из SMS" maxLength={6} />`).signals.includes("otp"));
  assert.ok(scriptSensitiveInput(`<Input name="cvv" />`).signals.includes("card-cvv"));
  assert.ok(scriptSensitiveInput(`<textarea placeholder="Seed phrase"></textarea>`).signals.includes("seed-phrase"));
  assert.ok(scriptSensitiveInput(`<input autoComplete="cc-number" />`).signals.includes("autocomplete-card"));
  assert.ok(scriptSensitiveInput(`<label>Номер карты</label><input />`).signals.includes("card-number"));
  assert.ok(scriptSensitiveInput(`const code = prompt("Введите код из SMS");`).signals.includes("prompt"));
  // An inline script of a page counts as well.
  assert.equal(page(`<div id=root></div><script>document.body.innerHTML='<input type="password">'</script>`).sensitive, true);
  // And a bundle's script through the collector (artifacts.ts).
  const collector = new SignalCollector();
  scanScript(`<input name="password" />`, collector);
  assert.equal(collector.sensitive.result().sensitive, true);
});

test("scripts of a dashboard (search, sliders, chart data about passwords) are not sensitive", () => {
  const dashboard = `import { useState } from "react";
  import { BarChart, Bar, XAxis } from "recharts";
  const data = [
    { name: "Сбросы пароля", value: 12 },
    { name: "Оплата картой", value: 40 },
    { id: "pin-map", label: "Пароли и коды", title: "Password resets" },
  ];
  export default function Dashboard() {
    const [q, setQ] = useState("");
    const [year, setYear] = useState(2026);
    return (<div>
      <h1>Безопасность: пароли и коды из SMS</h1>
      <input type="search" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
      <input type="range" min={2020} max={2026} value={year} onChange={(e) => setYear(+e.target.value)} />
      <label><input type="checkbox" /> Сравнить</label>
      <input name="name" placeholder="Ваше имя" />
      <textarea placeholder="Комментарий" />
      <input autoComplete="off" />
      <BarChart data={data}><Bar dataKey="value" /><XAxis dataKey="name" /></BarChart>
    </div>);
  }`;
  assert.deepEqual(scriptSensitiveInput(dashboard), { sensitive: false, signals: [] });
  // Chart data alone, with no field at all.
  assert.equal(scriptSensitiveInput(`const rows = [{ name: "password", id: "pin" }];`).sensitive, false);
  assert.equal(scriptSensitiveInput(`alert("Пароль изменён")`).sensitive, false);
});

test("field words: camelCase and snake_case read as words; lookalikes do not match", () => {
  assert.deepEqual(fieldKinds("newPassword"), ["password"]);
  assert.deepEqual(fieldKinds("card_number"), ["card-number"]);
  assert.deepEqual(fieldKinds("userOtp"), ["otp"]);
  assert.deepEqual(fieldKinds("footprint"), []);
  assert.deepEqual(fieldKinds("passport"), []);
  assert.deepEqual(fieldKinds("spinner"), []);
  assert.deepEqual(fieldKinds("Имя пользователя"), []);
  assert.deepEqual(fieldKinds("username"), ["login"]);
});

test("verdicts merge; stored fields; old revisions are unknown", () => {
  const no = { sensitive: false, signals: [] };
  const yes = { sensitive: true, signals: ["password-field"] };
  assert.deepEqual(mergeSensitive(no, no), no);
  assert.deepEqual(mergeSensitive(no, yes, undefined), yes);
  // A page that could not be read leaves the work unknown.
  assert.equal(mergeSensitive(no, undefined), null);
  assert.deepEqual(sensitiveFields(no), { sensitiveInput: false });
  assert.deepEqual(sensitiveFields(yes), { sensitiveInput: true, sensitiveSignals: ["password-field"] });
  assert.deepEqual(sensitiveFields(null), {});
  assert.equal(sensitiveInputOf({ v: 1, hits: {} }), null);
  assert.equal(sensitiveInputOf({}), null);
  assert.equal(sensitiveInputOf(null), null);
  assert.equal(sensitiveInputOf({ sensitiveInput: false }), false);
  assert.equal(sensitiveInputOf({ sensitiveInput: true }), true);
});

test("autoChecked: the models answered and nobody found anything", () => {
  const clean = { v: 1, hits: {}, model: { state: "checked", findings: [], answers: [{ source: "text", answer: "none" }] } };
  assert.equal(autoCheckedClean(clean), true);
  assert.equal(autoCheckedClean({ v: 1, hits: {} }), false);
  assert.equal(autoCheckedClean({ ...clean, model: { state: "unchecked", findings: [] } }), false);
  assert.equal(
    autoCheckedClean({ ...clean, model: { state: "checked", findings: [{ category: "spam", agreed: false, source: "text", reason: "x" }] } }),
    false,
  );
  // A rules finding at the flag level.
  assert.equal(autoCheckedClean({ ...clean, hits: { malicious_code: { score: 100, terms: ["x"] } } }), false);
  // Below every threshold: nothing found.
  assert.equal(autoCheckedClean({ ...clean, hits: { spam: { score: 1, terms: ["x"] } } }), true);
});

test("the recipient's note: quiet without fields, a warning with them or when unknown", () => {
  const user = { publisher: "user" as const };
  const quiet = recipientNote({ ...user, sensitiveInput: false, autoChecked: true });
  assert.equal(quiet.tone, "quiet");
  assert.equal(quiet.line, NOTE_QUIET);
  assert.ok(quiet.details.includes(CHECKED));
  assert.ok(!/не проверена|пароли/.test(quiet.line + quiet.details));
  const asks = recipientNote({ ...user, sensitiveInput: true, autoChecked: false });
  assert.equal(asks.tone, "warning");
  assert.equal(asks.line, NOTE_ASKS);
  assert.ok(asks.details.includes(NOT_CHECKED));
  const unknown = recipientNote({ ...user, sensitiveInput: null, autoChecked: false });
  assert.equal(unknown.tone, "warning");
  assert.equal(unknown.line, NOTE_UNKNOWN);
  assert.ok(!unknown.line.includes("не проверена"));
  assert.ok(unknown.details.includes(NOT_CHECKED));
  assert.ok(recipientNote({ ...user, sensitiveInput: null, autoChecked: true }).details.includes(CHECKED));
  const editorial = recipientNote({ publisher: "editorial", sensitiveInput: false, autoChecked: false });
  assert.deepEqual(editorial, {
    tone: "editorial",
    line: "Редакция Полки",
    details: "Эту страницу подготовила редакция Полки.",
  });
});

test("bounded time on a large script and a large page", () => {
  const script = `<input />` + "const a = { name: 'x', placeholder: 'y' };\n".repeat(60_000) + "x".repeat(1_000_000);
  let started = performance.now();
  scriptSensitiveInput(script);
  assert.ok(performance.now() - started < 2_000, "script scan too slow");
  started = performance.now();
  inspectHtml(`<form>${'<input type="text" name="n" placeholder="Имя"><label>Имя</label>'.repeat(5_000)}</form>`);
  assert.ok(performance.now() - started < 3_000, "page scan too slow");
});
