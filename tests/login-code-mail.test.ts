// The sign-in code letter (apps/server/mail-templates/login-code.ts): the code
// grouped in the subject, text and HTML alike, everything escaped, and no
// address in the HTML but the installation's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeMailHtml,
  groupCode,
  loginCodeMail,
} from "../apps/server/mail-templates/login-code.ts";

test("the code is grouped as two fours", () => {
  assert.equal(groupCode("12345678"), "1234 5678");
  assert.equal(groupCode("1234 5678"), "1234 5678");
  assert.equal(groupCode("123"), "123");
});

test("the subject, the text and the HTML all carry the grouped code", () => {
  const mail = loginCodeMail({ code: "04718263" });
  assert.equal(mail.subject, "0471 8263 — код для входа в Полку");
  assert.match(mail.text, /Ваш код: 0471 8263/);
  assert.match(mail.text, /10 минут/);
  assert.match(mail.text, /просто проигнорируйте письмо/);
  assert.match(mail.text, /https:\/\/polochka\.app · hello@polochka\.app/);
  assert.match(mail.html, />0471 8263</);
  assert.match(mail.html, /Код для входа в Полку/);
  assert.match(mail.html, /Введите его на странице входа/);
  assert.match(mail.html, /Код действует 10 минут/);
  assert.match(mail.html, /hello@polochka\.app/);
  assert.match(mail.html, /prefers-color-scheme: dark/);
});

test("no image, script, web font or address other than polochka.app", () => {
  const { html, text } = loginCodeMail({ code: "12345678" });
  assert.doesNotMatch(html, /<img|<script|<link|@import|@font-face|url\(/i);
  const urls = html.match(/(?:https?:)?\/\/[^\s"'<>)]+/gi) ?? [];
  assert.deepEqual([...new Set(urls)], ["https://polochka.app"]);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["https://polochka.app"]);
  assert.doesNotMatch(html, /mailto:/);
  assert.deepEqual(text.match(/https?:\/\/\S+/g), ["https://polochka.app"]);
});

test("everything interpolated is escaped", () => {
  assert.equal(
    escapeMailHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
  const mail = loginCodeMail({
    code: "<b>1234</b>",
    origin: 'https://evil.test/"><script>',
    contact: "<i>x</i>@example.test",
  });
  assert.doesNotMatch(mail.html, /<b>|<script>|<i>/);
  assert.match(mail.html, /&lt;i&gt;x&lt;\/i&gt;@example\.test/);
  assert.match(
    mail.html,
    /href="https:\/\/evil\.test\/&quot;&gt;&lt;script&gt;"/,
  );
});

test("a self-hosted installation names itself, and a missing contact is left out", () => {
  const mail = loginCodeMail({
    code: "11112222",
    origin: "https://polka.example.ru",
    contact: null,
  });
  assert.match(mail.html, /href="https:\/\/polka\.example\.ru"/);
  assert.match(mail.html, />polka\.example\.ru</);
  assert.doesNotMatch(mail.html, /polochka|&middot;/);
  assert.match(mail.text, /Полка · https:\/\/polka\.example\.ru\n/);
});
