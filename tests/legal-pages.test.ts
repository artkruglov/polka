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
  assert.match(html, /Продолжая, вы принимаете/);
  assert.match(html, /<a href="\/terms">Соглашение<\/a>/);
  assert.match(html, /<a href="\/privacy">Политику обработки данных<\/a>/);
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
  test(`${name} text renders as a draft with visible placeholders`, () => {
    const html = render(React.createElement(Markdown, { source: doc(name) }));
    assert.match(html, new RegExp(`^<h1>${title}</h1>`));
    assert.match(html, /<aside class="legal-note" role="note"><strong>Черновик для проверки юристом\.<\/strong>/);
    assert.match(html, /<mark class="legal-placeholder">\[ИМЯ ОПЕРАТОРА\]<\/mark>/);
    assert.match(html, /<mark class="legal-placeholder">\[КОНТАКТНЫЙ E-MAIL\]<\/mark>/);
    assert.ok((html.match(/<h2>/g) ?? []).length >= 8);
    // No Markdown syntax leaks into the page.
    assert.doesNotMatch(html, /\*\*|\]\(|^- |<p>- /m);
  });

test("links between the texts point at the site routes", () => {
  const html = render(React.createElement(Markdown, { source: doc("terms") }));
  assert.match(html, /<a href="\/privacy">Политику обработки персональных данных<\/a>/);
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
