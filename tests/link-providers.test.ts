// The provider table (packages/contracts/link-providers.ts): which links the
// server never opens, which it reads through an API or the renderer, and the
// card a Claude link gets on /bring. One table for server, web and renderer.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LINK_PROVIDERS,
  defaultLinkTitle,
  matchLink,
  renderable,
} from "../packages/contracts/link-providers.ts";
import { classify } from "../apps/web/src/features/import-url/classify-link.ts";
import { ProviderGuide, agentPhrase } from "../apps/web/src/features/import-url/provider-guide.tsx";
import { prepareImport } from "../apps/server/url-import/prepare.ts";

test("every AI chat whose terms forbid extraction is extension-only", () => {
  const cases: Array<[string, string, string]> = [
    ["https://claude.ai/public/artifacts/0b5c2f0e-1111-4222-8333-444455556666", "claude", "extension"],
    ["https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo", "claude", "extension"],
    ["https://claude.ai/share/0b5c2f0e-1111-4222-8333-444455556666", "claude", "extension"],
    ["https://abc.claude.site/artifacts/x", "claude", "extension"],
    ["https://chatgpt.com/share/abc", "chatgpt", "extension"],
    ["https://chat.openai.com/share/abc", "chatgpt", "extension"],
    ["https://chatgpt.com/canvas/shared/abc", "chatgpt", "extension"],
    ["https://v0.app/chat/some-slug", "v0", "extension"],
    ["https://v0.dev/chat/some-slug", "v0", "extension"],
    ["https://www.perplexity.ai/page/some-page", "perplexity", "extension"],
    ["https://aistudio.google.com/apps/drive/123", "aistudio", "extension"],
    ["https://gist.github.com/octocat/aa5a315d61ae9438b18d", "gist", "server-api"],
    ["https://gistpreview.github.io/?aa5a315d61ae9438b18d", "gist", "server-api"],
    ["https://my-app.lovable.app/", "lovable", "server-render"],
    ["https://demo.bolt.host/", "bolt", "server-render"],
    ["https://tool.replit.app/", "replit", "server-render"],
    ["https://octocat.github.io/project/", "github-pages", "server-render"],
    ["https://gemini.google.com/share/abc123def", "gemini", "server-render"],
    ["https://g.co/gemini/share/abc123def", "gemini", "server-render"],
  ];
  for (const [url, id, route] of cases) {
    const match = matchLink(url)!;
    assert.equal(match.provider?.id, id, url);
    assert.equal(match.route, route, url);
    assert.equal(match.closed, false, url);
  }
});

test("the renderer allowlist is exact: lookalikes, bare suffixes and closed paths are not renderable", () => {
  for (const url of [
    "https://lovable.app/",
    "https://evil-lovable.app/",
    "https://my-app.lovable.app.evil.example/",
    "https://github.io/",
    "https://example.com/",
    "http://my-app.lovable.app/",
    "https://gemini.google.com/app/abc",
    "https://g.co/kgs/abc",
    "https://claude.ai/public/artifacts/x",
    "https://gistpreview.github.io/?aa5a315d61ae9438b18d",
  ])
    assert.equal(renderable(url), false, url);
  assert.equal(renderable("https://my-app.lovable.app/about"), true);
  // g.co outside the Gemini share path is an ordinary short link, not Gemini.
  assert.equal(matchLink("https://g.co/kgs/abc")?.provider, null);
  // gemini.google.com/app is a private chat behind a login.
  assert.equal(matchLink("https://gemini.google.com/app/abc")?.closed, true);
});

test("default titles and every provider has a badge", () => {
  assert.equal(defaultLinkTitle("https://claude.ai/public/artifacts/x"), "Артефакт Claude");
  assert.equal(defaultLinkTitle("https://claude.ai/share/x"), "Чат Claude");
  assert.equal(defaultLinkTitle("https://chatgpt.com/share/x"), "Чат ChatGPT");
  assert.equal(defaultLinkTitle("https://chatgpt.com/canvas/shared/x"), "Canvas ChatGPT");
  assert.equal(defaultLinkTitle("https://my-app.lovable.app/"), "my-app.lovable.app");
  assert.equal(defaultLinkTitle("https://www.example.com/a"), "example.com");
  for (const provider of LINK_PROVIDERS) {
    assert.match(provider.mark, /^.{2}$/u, provider.id);
    assert.match(provider.color, /^#[0-9a-f]{6}$/i, provider.id);
  }
});

test("the server refuses extension-only links before any request", async () => {
  for (const url of [
    "https://claude.ai/public/artifacts/x",
    "https://chatgpt.com/share/x",
    "https://v0.app/chat/x",
    "https://www.perplexity.ai/page/x",
    "https://aistudio.google.com/apps/x",
  ])
    await assert.rejects(prepareImport(url), { code: "provider_adapter_required" }, url);
});

test("web classification follows the table and this installation's sources", () => {
  assert.equal(classify("https://v0.app/chat/x").status, "provider");
  assert.equal(classify("https://www.perplexity.ai/page/x").source, "perplexity");
  const gist = "https://gist.github.com/octocat/aa5a315d61ae9438b18d";
  assert.equal(classify(gist).status, "unsupported_host");
  assert.equal(classify(gist, ["standalone-html", "github-gist"]).status, "ready");
  const lovable = "https://my-app.lovable.app/";
  assert.equal(classify(lovable, ["standalone-html", "github-gist"]).status, "unsupported_host");
  const rendered = classify(lovable, ["standalone-html", "github-gist", "rendered-spa"]);
  assert.equal(rendered.status, "ready");
  assert.match(rendered.explain, /интерактив может не работать/);
});

test("a Claude link gets the card: extension, agent phrase, file", () => {
  const url = "https://claude.ai/public/artifacts/0b5c2f0e-1111-4222-8333-444455556666";
  const html = renderToStaticMarkup(
    React.createElement(ProviderGuide, {
      result: classify(url),
      url,
      onFile: () => {},
      saveLink: React.createElement("button", null, "Сохранить как ссылку"),
    }),
  );
  assert.match(html, /Артефакт Claude/);
  assert.match(html, /claude\.ai/);
  assert.match(html, /запрещает автоматическое извлечение/);
  // The extension is looked for in the browser; until then its row says so.
  assert.match(html, /Расширение «На Полку»/);
  assert.match(html, /Попросить агента/);
  assert.ok(html.includes(agentPhrase(url)), "the copyable phrase carries the link");
  assert.match(html, /Скопировать фразу/);
  assert.match(html, /Загрузить файл/);
  assert.match(html, /Сохранить как ссылку/);
  // A v0 link: the extension does not open it yet, and the card says so instead of offering a button.
  const v0 = "https://v0.app/chat/demo";
  const other = renderToStaticMarkup(
    React.createElement(ProviderGuide, { result: classify(v0), url: v0, onFile: () => {} }),
  );
  assert.match(other, /Пока сохраняет артефакты Claude и ChatGPT/);
  assert.doesNotMatch(other, /Сохранить расширением/);
});
