// The code screen on /signup (apps/web/src/pages/signup/code-help.tsx): the
// server answers «код отправлен» for every address, so the page repeats the
// public domain rule after «Получить код» and offers the providers instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OutsideDomainHelp,
  SPAM_HINT,
  codeScreenNotice,
  outsideSignupDomains,
  signupDomainsPhrase,
  typedDomainOf,
} from "../apps/web/src/pages/signup/code-help.tsx";
import type { SignInProvider } from "../apps/web/src/entities/capabilities/useCapabilities.ts";
import { RU_MAIL_DOMAINS } from "../apps/server/mail-domains.ts";

const ruOnly = [...RU_MAIL_DOMAINS];
const base = {
  delivery: "smtp",
  inviteOnly: false,
  signupDomains: ruOnly,
  loginDomains: "any" as const,
};

test("the typed domain and the outside check", () => {
  assert.equal(typedDomainOf(" Dmitry@Gmail.COM "), "gmail.com");
  assert.equal(typedDomainOf("nobody"), "");
  assert.equal(outsideSignupDomains("gmail.com", ruOnly), true);
  assert.equal(outsideSignupDomains("yandex.ru", ruOnly), false);
  assert.equal(outsideSignupDomains("gmail.com", "any"), false);
  assert.equal(outsideSignupDomains("gmail", ruOnly), false);
});

test("an allowed address gets no notice on the code screen", () => {
  assert.equal(codeScreenNotice({ ...base, email: "d@yandex.ru" }), null);
  assert.equal(codeScreenNotice({ ...base, email: "d@bk.ru" }), null);
  assert.equal(
    codeScreenNotice({ ...base, signupDomains: "any", email: "d@gmail.com" }),
    null,
  );
});

test("an address outside the list keeps the rule on the code screen", () => {
  assert.deepEqual(codeScreenNotice({ ...base, email: "dmitry@gmail.com" }), {
    kind: "if-shelf",
    text: "Если полки на адресе @gmail.com ещё нет, код не придёт: новые полки открываются на почте Яндекса, Mail.ru, Рамблера и VK.",
  });
  const never = codeScreenNotice({
    ...base,
    loginDomains: "signup",
    email: "dmitry@gmail.com",
  });
  assert.equal(never?.kind, "never");
  assert.match(never!.text, /не отправляется/);
});

test("invitations and the local test box say nothing about domains", () => {
  assert.equal(
    codeScreenNotice({ ...base, inviteOnly: true, email: "d@gmail.com" }),
    null,
  );
  assert.equal(
    codeScreenNotice({ ...base, delivery: "local", email: "d@gmail.com" }),
    null,
  );
});

test("the phrase follows the configured list", () => {
  assert.equal(
    signupDomainsPhrase(ruOnly),
    "на почте Яндекса, Mail.ru, Рамблера и VK",
  );
  assert.equal(
    signupDomainsPhrase(["example.ru", "yandex.ru"]),
    "на адресах @example.ru, @yandex.ru",
  );
});

test("the help puts the sign-up providers first and a way back to the address", () => {
  const notice = codeScreenNotice({ ...base, email: "dmitry@gmail.com" })!;
  const providers: SignInProvider[] = [
    { id: "yandex", name: "Яндекс ID", signup: true },
    { id: "vk", name: "VK ID", signup: true },
    { id: "google", name: "Google", signup: false },
    { id: "oidc", name: "Вход компании", signup: true },
  ];
  const html = renderToStaticMarkup(
    React.createElement(OutsideDomainHelp, {
      notice,
      providers,
      next: "/start",
      busy: false,
      onChangeAddress: () => {},
    }),
  );
  assert.match(html, /@gmail\.com ещё нет, код не придёт/);
  assert.match(html, /Войти с Яндекс ID/);
  assert.match(html, /Войти с VK ID/);
  assert.doesNotMatch(html, /Google|Вход компании/);
  assert.match(html, /Изменить адрес/);
  assert.match(html, /или введите код, если полка уже есть/);
  assert.ok(html.indexOf("Яндекс ID") < html.indexOf("Изменить адрес"));
});

test("the spam hint names both folders", () => {
  assert.equal(
    SPAM_HINT,
    "Письмо не пришло за минуту? Проверьте «Спам» и «Промоакции».",
  );
});
