// The page for companies (/enterprise) and its request form:
// POST /api/enterprise-requests validation, Origin, honeypot, the per-IP
// limit, idempotency and the operator letter written in MAIL_MODE=local.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  ENTERPRISE_REQUESTS_PER_IP,
  enterpriseLetter,
} from "../apps/server/enterprise-requests.ts";
import { linkPreviewTags } from "../apps/server/frontend.ts";
import { LOCAL_OPERATOR_MAIL_DIRECTORY } from "../apps/server/mailer.ts";
import { s3 } from "../apps/server/storage.ts";
import { EnterpriseContent } from "../apps/web/src/pages/enterprise/content.tsx";
import {
  EnterpriseForm,
  initialInterest,
} from "../apps/web/src/pages/enterprise/form.tsx";
import { LegalLinks } from "../apps/web/src/widgets/navigation/index.tsx";
import { routeTitle } from "../apps/web/src/app/routing/titles.ts";
import { isAppPage } from "../packages/contracts/app-routes.ts";
import { pageTitle } from "../apps/web/src/shared/lib/document-title.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
if (config.MAIL_MODE !== "local")
  throw new Error(
    "Enterprise request tests read operator letters from local mail",
  );
const operatorEmail = config.OPERATOR_EMAIL;
config.OPERATOR_EMAIL = "operator-enterprise@example.test";

after(async () => {
  config.OPERATOR_EMAIL = operatorEmail;
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () =>
  `2001:db8:e::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

const valid = (overrides: Record<string, unknown> = {}) => ({
  key: randomUUID(),
  name: "Анна Смирнова",
  company: `ООО «Пример» ${randomBytes(4).toString("hex")}`,
  contact: "Anna@Example.test",
  teamSize: "51-200",
  interest: "self-hosted",
  comment: "Нужна своя установка.",
  policyRead: true,
  ...overrides,
});

const post = (
  body: unknown,
  { ip = address(), headers = { origin } as Record<string, string> } = {},
) =>
  app.inject({
    method: "POST",
    url: "/api/enterprise-requests",
    headers,
    payload: body as any,
    remoteAddress: ip,
  });

const stored = async (company: string) =>
  (
    await db.query(
      "SELECT * FROM enterprise_requests WHERE company=$1 ORDER BY created_at",
      [company],
    )
  ).rows;

async function letterFor(marker: string) {
  let names: string[] = [];
  try {
    names = await readdir(LOCAL_OPERATOR_MAIL_DIRECTORY);
  } catch {}
  for (const name of names) {
    const letter = JSON.parse(
      await readFile(join(LOCAL_OPERATOR_MAIL_DIRECTORY, name), "utf8"),
    );
    if (String(letter.text).includes(marker)) return letter;
  }
  return null;
}

test("a request is stored and the operator gets a plain-text letter", async () => {
  const marker = randomBytes(6).toString("hex");
  const body = valid({
    name: "<b>Анна</b>",
    comment: `Строка 1\r\nСтрока 2 <script>alert(1)</script> ${marker}\u0007`,
  });
  const res = await post(body);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, contact: "anna@example.test" });

  const [row] = await stored(body.company);
  assert.ok(row);
  assert.equal(row.contact, "anna@example.test");
  assert.equal(row.team_size, "51-200");
  assert.equal(row.interest, "self-hosted");
  // CRLF becomes LF; other control characters go.
  assert.equal(
    row.comment,
    `Строка 1\nСтрока 2 <script>alert(1)</script> ${marker}`,
  );
  assert.ok(row.notified_at, "the letter was accepted");

  const letter = await letterFor(marker);
  assert.ok(letter, "letter written in MAIL_MODE=local");
  assert.equal(letter.to, "operator-enterprise@example.test");
  assert.equal(letter.replyTo, "anna@example.test");
  assert.equal(letter.subject, `Заявка «Для компаний»: ${body.company}`);
  assert.equal(letter.html, undefined, "no HTML part");
  // The fields go in as text, exactly; nothing is interpreted as markup.
  assert.ok(letter.text.includes("Имя: <b>Анна</b>\n"));
  assert.ok(letter.text.includes(`Компания: ${body.company}\n`));
  assert.ok(letter.text.includes("Контакт: anna@example.test\n"));
  assert.ok(letter.text.includes("Размер команды: 51–200 человек\n"));
  assert.ok(letter.text.includes("Что интересует: своя установка\n"));
  assert.ok(letter.text.includes("<script>alert(1)</script>"));
  assert.ok(letter.text.includes(row.id));
});

test("one field is enough: a Telegram name, nothing else", async () => {
  const marker = randomBytes(6).toString("hex");
  for (const [i, spelling] of ["@anna_" + marker, "https://t.me/anna_" + marker, "anna_" + marker].entries()) {
    const res = await post({ key: randomUUID(), contact: spelling, policyRead: true, comment: `${marker}-${i}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { ok: true, contact: `@anna_${marker}` });
  }
  const { rows } = await db.query("SELECT * FROM enterprise_requests WHERE contact=$1", [`@anna_${marker}`]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, null);
  assert.equal(rows[0].company, null);
  assert.equal(rows[0].team_size, null);
  assert.equal(rows[0].interest, "other");
  const letter = await letterFor(`${marker}-0`);
  assert.ok(letter);
  assert.equal(letter.replyTo, undefined, "a Telegram name is not a reply address");
  assert.ok(letter.text.includes(`Контакт: @anna_${marker} (Telegram: https://t.me/anna_${marker})`));
  assert.ok(!letter.text.includes("Имя:"));
  assert.equal(letter.subject, `Заявка «Для компаний»: @anna_${marker}`);
});

test("a repeated submit with the same key is one request; another body under it is refused", async () => {
  const body = valid();
  const ip = address();
  assert.equal((await post(body, { ip })).statusCode, 200);
  assert.equal((await post(body, { ip })).statusCode, 200);
  assert.equal((await stored(body.company)).length, 1);
  const other = await post({ ...body, comment: "Другой текст" }, { ip });
  assert.equal(other.statusCode, 409, other.body);
});

test("fields are validated", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no name", { name: "  " }],
    ["long name", { name: "а".repeat(101) }],
    ["line break in the company", { company: "ООО\nBcc: x@example.test" }],
    ["bad contact", { contact: "not-an-email" }],
    ["no contact", { contact: "  " }],
    ["unknown team size", { teamSize: "5000" }],
    ["unknown interest", { interest: "free" }],
    ["long comment", { comment: "а".repeat(2001) }],
    ["policy not read", { policyRead: false }],
    ["unknown field", { phone: "+7 000" }],
    ["bad key", { key: "1" }],
  ];
  const ip = address();
  for (const [label, overrides] of cases) {
    const res = await post(valid(overrides), { ip });
    assert.equal(res.statusCode, 400, label);
    assert.equal(res.json().code, "invalid", label);
  }
  const { policyRead: _policy, ...withoutPolicy } = valid();
  assert.equal((await post(withoutPolicy, { ip })).statusCode, 400);
  // The limit is exactly 2000 characters.
  const long = valid({ comment: "а".repeat(2000) });
  assert.equal((await post(long)).statusCode, 200);
  assert.equal((await stored(long.company))[0].comment.length, 2000);
});

test("a browser POST from another origin, or none, is refused", async () => {
  for (const headers of [{}, { origin: "https://evil.example" }] as Array<
    Record<string, string>
  >) {
    const body = valid();
    const res = await post(body, { headers });
    assert.equal(res.statusCode, 403, JSON.stringify(headers));
    assert.equal((await stored(body.company)).length, 0);
  }
});

test("a filled honeypot looks accepted but nothing is stored or sent", async () => {
  const marker = randomBytes(6).toString("hex");
  const body = valid({ website: "https://spam.example", comment: marker });
  const res = await post(body);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal((await stored(body.company)).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await letterFor(marker), null);
});

test(`one IP may send ${ENTERPRISE_REQUESTS_PER_IP} requests an hour`, async () => {
  const ip = address();
  for (let i = 0; i < ENTERPRISE_REQUESTS_PER_IP; i++)
    assert.equal((await post(valid(), { ip })).statusCode, 200, `request ${i}`);
  const blocked = valid();
  const res = await post(blocked, { ip });
  assert.equal(res.statusCode, 429, res.body);
  assert.match(res.json().message, /через час/);
  // The window's reset time, not a guess: within the hour.
  const retryAfter = Number(res.headers["retry-after"]);
  assert.ok(retryAfter > 3500 && retryAfter <= 3600, String(retryAfter));
  assert.equal((await stored(blocked.company)).length, 0);
  // Another address is counted on its own.
  assert.equal((await post(valid())).statusCode, 200);
  // The counter keeps only a hash of the key, never the address.
  const { rows } = await db.query(
    "SELECT key FROM login_limits WHERE key LIKE $1",
    [`%${ip}%`],
  );
  assert.equal(rows.length, 0);
});

test("maintenance keeps a request for one year", async () => {
  const old = valid();
  const fresh = valid();
  assert.equal((await post(old)).statusCode, 200);
  assert.equal((await post(fresh)).statusCode, 200);
  await db.query(
    "UPDATE enterprise_requests SET created_at=now()-interval '1 year 1 day' WHERE company=$1",
    [old.company],
  );
  const cleanup = readFileSync("scripts/maintenance-cleanup.ts", "utf8");
  const sql = cleanup.match(/"(DELETE FROM enterprise_requests [^"]+)"/)?.[1];
  assert.ok(sql);
  await db.query(sql);
  assert.equal((await stored(old.company)).length, 0);
  assert.equal((await stored(fresh.company)).length, 1);
});

test("the letter never carries an HTML part", () => {
  const letter = enterpriseLetter({
    id: randomUUID(),
    name: "Имя",
    company: "Компания",
    contact: "a@example.test",
    team_size: "1000+",
    interest: "commercial-license",
    comment: null,
    created_at: new Date("2026-09-24T09:00:00Z"),
  });
  assert.equal("html" in letter, false);
  assert.match(letter.text, /Комментарий:\n—\n/);
  assert.match(letter.text, /Что интересует: коммерческая лицензия/);
});

const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const read = (path: string) => readFileSync(path, "utf8");

test("/enterprise: value, deployment, questions and the request form", () => {
  const html = render(React.createElement(EnterpriseContent, { search: "" }));
  assert.match(html, /<h1>[^<]*ИИ/);
  for (const text of [
    "Данные под вашим контролем",
    "Библиотеки шаблонов команды",
    "Агенты сохраняют сами",
    "Модерация и защита от злоупотреблений",
    "Открытый код и коммерческая лицензия",
    "Вход через SSO и доступ по домену",
    "Облако polochka.app",
    "Своя установка",
    "Коммерческая редакция",
    "По договору",
    "/llms.txt",
    "SHA-256",
  ])
    assert.ok(html.includes(text), text);
  // Automatic moderation is not on main: said, not promised. SSO works
  // (OpenID Connect, Яндекс ID, domain access), SAML and SCIM do not.
  assert.ok((html.match(/в разработке/g) ?? []).length >= 1);
  assert.ok(html.includes("OpenID Connect"));
  assert.ok(html.includes("SAML и SCIM пока"));
  assert.ok(html.includes('id="deploy"'));
  assert.ok(html.includes('id="request"'));
  // What the first pilots shape is not built: every card of it says so.
  const next = html.slice(html.indexOf("enterprise-next"), html.indexOf('id="deploy"'));
  // The commercial edition: what is ready says so, the rest is in progress.
  assert.ok(next.includes("Коммерческая редакция"));
  assert.ok(next.includes("облако polochka.app работает на открытом ядре") || next.includes("Облако polochka.app работает на открытом ядре"));
  assert.equal((next.match(/в разработке/g) ?? []).length, 1);
  assert.equal((next.match(/>есть</g) ?? []).length, 4);
  assert.ok(next.indexOf("Центр управления агентами") < next.indexOf("Контроль ссылок"));
  assert.ok(html.includes("Как Полка работает с нашими системами?"));
  // Department shelves work (TEAM_SHELVES stages 1–4): the page lists them
  // among what works, links out of them as still in progress, and what comes
  // next starts with access and control.
  assert.ok(html.includes("Как это работает в компании"));
  const works = html.slice(html.indexOf("enterprise-values-title"), html.indexOf("enterprise-next"));
  assert.ok(works.includes("Полки отделов"));
  assert.ok(works.includes("Ссылки наружу с полки отдела выпускают куратор"));
  assert.ok(works.includes("обсуждение видят все участники полки"));
  assert.ok(html.includes("На общей полке отдела — да"));
  assert.ok(!next.includes("Общие полки отделов"));
  assert.ok(next.indexOf("Контроль ссылок") < next.indexOf("Встраивание в ваши системы"));
  assert.doesNotMatch(html, /Лицензионного ключа нет/);
  assert.doesNotMatch(html, /Одна полка для всего/);
  const questions = (html.match(/<details>/g) ?? []).length;
  assert.ok(questions >= 5 && questions <= 8, String(questions));
  // The control centre leads: what a company sees, then what it does not.
  const control = html.slice(html.indexOf('id="control"'), html.indexOf("enterprise-how-title"));
  for (const text of ["Секреты", "Адреса и MCP-серверы", "Опасные действия", "Расход и люди", "Сессии и расшифровки", "Codex cloud"])
    assert.ok(control.includes(text), text);
  assert.ok(html.indexOf('id="control"') < html.indexOf("enterprise-values-title"));
  // Three pillars first: one drive for agents, every session kept, control.
  const pillars = html.slice(html.indexOf('id="pillars"'), html.indexOf('id="control"'));
  for (const text of ["Общая полка для работ агентов", "Память всех сессий", "Центр управления"])
    assert.ok(pillars.includes(text), text);
  // No invented price.
  assert.doesNotMatch(html, /₽|\$|руб\.|€/);
  // The form: every field, the honeypot out of reach, the policy and a contact.
  // The request is one field and a button; the comment is optional.
  for (const name of ["contact", "interest", "comment", "policyRead", "website"])
    assert.ok(html.includes(`name="${name}"`), name);
  for (const name of ["name", "company", "teamSize"])
    assert.ok(!html.includes(`name="${name}"`), name);
  assert.match(html, /Попросить пилот/);
  assert.match(html, /maxLength="2000"/i);
  assert.match(html, /class="enterprise-trap" aria-hidden="true"/);
  assert.match(
    html,
    /<input type="text" tabindex="-1" autoComplete="off" name="website"/i,
  );
  assert.match(
    html,
    /<a href="\/privacy"[^>]*>Политику обработки персональных данных<\/a>/,
  );
  assert.match(
    html,
    /href="mailto:hello@polochka\.app">hello@polochka\.app<\/a>/,
  );
  assert.ok(html.includes('href="/pricing"'));
});

test("/enterprise?interest= preselects a known choice only", () => {
  assert.equal(
    initialInterest("?interest=commercial-license"),
    "commercial-license",
  );
  assert.equal(initialInterest("?interest=cloud"), "cloud");
  assert.equal(initialInterest("?interest=<x>"), "");
  assert.equal(initialInterest(""), "");
  const html = render(
    React.createElement(EnterpriseContent, { search: "?interest=self-hosted" }),
  );
  assert.match(html, /<input type="hidden" name="interest" value="self-hosted"\/>/);
});

test("after sending, the form shows where the answer goes", () => {
  const html = render(
    React.createElement(EnterpriseForm, {
      interest: "",
      onInterest: () => {},
      initialSent: { contact: "anna@example.test" },
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Заявка отправлена/);
  assert.match(html, /<strong>anna@example\.test<\/strong>/);
  assert.doesNotMatch(html, /<form/);
});

test("/enterprise is routed and linked from the footer, /pricing and the landing", () => {
  assert.match(
    read("apps/web/src/app/routing/index.tsx"),
    /path === "\/enterprise"\) return <Enterprise \/>/,
  );
  assert.ok(isAppPage("/enterprise"));
  assert.match(
    render(React.createElement(LegalLinks)),
    /<a href="\/enterprise">Для компаний<\/a>/,
  );
  const pricing = read("apps/web/src/pages/pricing/plans.tsx");
  assert.match(
    pricing,
    /href="\/enterprise\?interest=commercial-license#request"/,
  );
  assert.match(pricing, /href="\/enterprise"/);
  assert.match(
    read("apps/web/src/pages/landing/index.tsx"),
    /href="\/enterprise"/,
  );
  // The link preview is the default Полка card.
  assert.equal(linkPreviewTags("/enterprise"), linkPreviewTags("/"));
});

test("each page names its browser tab; a recipient's tab and /s previews stay generic", () => {
  assert.equal(pageTitle(routeTitle("/enterprise")), "Для компаний — Полка");
  assert.equal(pageTitle(routeTitle("/privacy")), "Политика обработки персональных данных — Полка");
  assert.equal(pageTitle(routeTitle("/landing")), "Полка");
  // Recipients never see the work's own title in the tab.
  assert.equal(pageTitle(routeTitle("/s")), "Работа по ссылке — Полка");
  // The workspace and /discover name their own tabs (the work, an item).
  assert.equal(routeTitle("/"), undefined);
  assert.equal(routeTitle("/works/00000000-0000-4000-8000-000000000000"), undefined);
  // An address the app has no page for.
  assert.equal(pageTitle(routeTitle("/works/x")), "Страница не найдена — Полка");
  assert.equal(pageTitle(routeTitle("/nope")), "Страница не найдена — Полка");
  assert.equal(routeTitle("/discover"), undefined);
  // The page the server sends keeps «Полка»; the recipient page never retitles.
  assert.match(read("apps/web/index.html"), /<title>Полка<\/title>/);
  assert.doesNotMatch(read("apps/web/src/pages/recipient/index.tsx"), /document\.title/);
});
