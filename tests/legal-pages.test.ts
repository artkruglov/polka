import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../apps/web/src/pages/legal/markdown.tsx";
import { SignupConsent } from "../apps/web/src/pages/signup/consent.tsx";
import { LegalLinks } from "../apps/web/src/widgets/navigation/index.tsx";

const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const doc = (name: string) => readFileSync(`docs/legal/${name}.md`, "utf8");

test("signup shows the terms and privacy links under the email form", () => {
  const html = render(React.createElement(SignupConsent));
  assert.match(html, /Продолжая, вы принимаете <a href="\/terms">Соглашение<\/a>/);
  // The policy is read, not "accepted": no consent is bundled with the terms.
  assert.match(
    html,
    /подтверждаете,\s+что прочитали <a href="\/privacy">Политику обработки данных<\/a>/,
  );
  const page = readFileSync("apps/web/src/pages/signup/index.tsx", "utf8");
  assert.ok(
    page.indexOf("<SignupConsent />") > page.indexOf("</form>"),
    "consent line follows the email form",
  );
});

test("every page shell links to the policy and the terms", () => {
  const html = render(React.createElement(LegalLinks));
  assert.match(html, /<a href="\/privacy">Политика<\/a>/);
  assert.match(html, /<a href="\/terms">Соглашение<\/a>/);
});

test("client routing opens /privacy and /terms", () => {
  const routes = readFileSync("apps/web/src/app/routing/index.tsx", "utf8");
  assert.match(routes, /path === "\/privacy"\) return <PrivacyPage \/>/);
  assert.match(routes, /path === "\/terms"\) return <TermsPage \/>/);
});

for (const [name, title] of [
  ["privacy", "Политика обработки персональных данных"],
  ["terms", "Пользовательское соглашение"],
] as const)
  test(`${name} text names the operator and has no unfilled fields`, () => {
    const html = render(React.createElement(Markdown, { source: doc(name) }));
    assert.match(html, new RegExp(`^<h1>${title}</h1>`));
    assert.match(html, /Круглов Артем Игоревич/);
    assert.match(html, /artkruglov@gmail\.com/);
    assert.match(html, /<aside class="legal-note" role="note">/);
    // Every field is filled: no placeholder is left for readers to see.
    assert.doesNotMatch(html, /legal-placeholder|\[[А-ЯЁ][А-ЯЁ ,.…—-]*\]/);
    assert.ok((html.match(/<h2>/g) ?? []).length >= 8);
    // No Markdown syntax leaks into the page.
    assert.doesNotMatch(html, /\*\*|\]\(|^- |<p>- /m);
  });

test("links between the texts point at the site routes", () => {
  const html = render(React.createElement(Markdown, { source: doc("terms") }));
  assert.match(html, /<a href="\/privacy">Политик[еу] обработки персональных данных<\/a>/);
  assert.doesNotMatch(html, /privacy\.md/);
});

test("markdown renderer never emits raw HTML or unsafe links", () => {
  const html = render(
    React.createElement(Markdown, {
      source:
        '# T <img src=x onerror="alert(1)">\n\n[click](javascript:void) [ok](https://example.org)',
    }),
  );
  assert.doesNotMatch(html, /<img|href="javascript/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<p>click <a href="https:\/\/example.org">ok<\/a><\/p>/);
});

// The promises the operator has to keep, and the terms the legal review
// (docs/reviews/2026-09-23-legal) fixed on purpose. Changing one of them is a
// decision, not an edit: update the review note too.
test("the texts keep the reviewed legal terms", () => {
  const privacy = doc("privacy");
  for (const phrase of [
    "10 рабочих дней",
    "ещё на 5 рабочих дней",
    "не позже 30 дней после запроса",
    "в течение 24 часов",
    "в течение 72 часов",
    "п. 5 ч. 1 ст. 6",
    "п. 7 ч. 1 ст. 6",
    "Google LLC (США)",
    "ООО «Яндекс.Облако»",
    "с 14 лет",
  ])
    assert.ok(privacy.includes(phrase), `privacy: ${phrase}`);
  // Processing rests on the agreement: there is no consent to withdraw.
  assert.doesNotMatch(privacy, /отозвать согласие/);
  const terms = doc("terms");
  for (const phrase of [
    "публичная оферта",
    "п. 3 ст. 438",
    "простую (неисключительную) лицензию",
    "на территории всего мира",
    "п. 4 ст. 401",
    "не позже чем за 30 дней",
    "не позже чем за 10 дней",
    "Это не обязательное условие для обращения в суд",
    "по месту вашего жительства",
    "38-ФЗ",
  ])
    assert.ok(terms.includes(phrase), `terms: ${phrase}`);
});
