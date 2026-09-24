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
  fetchable,
  matchLink,
  renderable,
} from "../packages/contracts/link-providers.ts";
import { classify } from "../apps/web/src/features/import-url/classify-link.ts";
import { CLAUDE_PHRASE, ProviderGuide, agentPhrase } from "../apps/web/src/features/import-url/provider-guide.tsx";
import { prepareImport } from "../apps/server/url-import/prepare.ts";

test("each link source has its route: fetch, one try, render, API or the user's side", () => {
  const cases: Array<[string, string, string]> = [
    ["https://claude.ai/public/artifacts/0b5c2f0e-1111-4222-8333-444455556666", "claude", "server-try"],
    ["https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo", "claude", "server-try"],
    ["https://claude.ai/share/0b5c2f0e-1111-4222-8333-444455556666", "claude", "extension"],
    ["https://abc.claude.site/artifacts/x", "claude", "extension"],
    ["https://claude.site/artifacts/x", "claude", "extension"],
    ["https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed", "chatgpt", "server-fetch"],
    ["https://chat.openai.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed", "chatgpt", "server-fetch"],
    ["https://chatgpt.com/canvas/shared/68d0334db1c08191b91094c29bee3c78", "chatgpt", "server-fetch"],
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
    "https://claude.ai/share/0b5c2f0e-1111-4222-8333-444455556666",
    "https://claude.ai/chat/0b5c2f0e-1111-4222-8333-444455556666",
    "https://abc.claude.site/artifacts/x",
    "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed",
    "https://gistpreview.github.io/?aa5a315d61ae9438b18d",
  ])
    assert.equal(renderable(url), false, url);
  assert.equal(renderable("https://my-app.lovable.app/about"), true);
  assert.equal(renderable("https://claude.ai/public/artifacts/0b5c2f0e-1111-4222-8333-444455556666"), true);
  // The plain fetch is only for ChatGPT's public pages robots.txt allows.
  assert.equal(fetchable("https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed"), true);
  assert.equal(fetchable("https://chatgpt.com/canvas/shared/68d0334db1c08191b91094c29bee3c78"), true);
  for (const url of ["https://chatgpt.com/c/68063082-c2d8-8012-8d45-fa674aa1c1ed", "https://chatgpt.com/", "https://chatgpt.com/share/", "https://my-app.lovable.app/", "https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo"])
    assert.equal(fetchable(url), false, url);
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

test("the server refuses AI-chat links it may not open, and ChatGPT/Claude without the renderer", async () => {
  for (const url of [
    "https://claude.ai/public/artifacts/0b5c2f0e-1111-4222-8333-444455556666",
    "https://claude.ai/share/0b5c2f0e-1111-4222-8333-444455556666",
    "https://abc.claude.site/artifacts/x",
    "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed",
    "https://chatgpt.com/c/68063082-c2d8-8012-8d45-fa674aa1c1ed",
    "https://v0.app/chat/x",
    "https://www.perplexity.ai/page/x",
    "https://aistudio.google.com/apps/x",
  ])
    await assert.rejects(prepareImport(url, { renderedEnabled: false }), { code: "provider_adapter_required" }, url);
  // With the renderer on, extension-only links still never leave the server.
  for (const url of ["https://claude.ai/share/0b5c2f0e-1111-4222-8333-444455556666", "https://v0.app/chat/x"])
    await assert.rejects(prepareImport(url, { renderedEnabled: true }), { code: "provider_adapter_required" }, url);
});

test("web classification follows the table and this installation's sources", () => {
  assert.equal(classify("https://v0.app/chat/x").status, "provider");
  const share = "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed";
  assert.equal(classify(share).status, "provider");
  assert.equal(classify(share, ["standalone-html", "server-fetch"]).status, "ready");
  const artifact = "https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo";
  assert.equal(classify(artifact).status, "provider");
  assert.equal(classify(artifact, ["server-try"]).status, "ready");
  assert.match(classify(artifact, ["server-try"]).explain, /один раз/);
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

test("a Claude link the server could not open gets the card: ask Claude, keep the link, drop the file", async () => {
  (globalThis as any).crypto ??= (await import("node:crypto")).webcrypto;
  const url = "https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo";
  const html = renderToStaticMarkup(
    React.createElement(ProviderGuide, {
      result: { ...classify(url, ["server-try"]), status: "provider" },
      url,
      failure: "source_blocked",
      onFile: () => {},
      fileSave: React.createElement("div", { "data-testid": "drop" }, "DROPZONE"),
    }),
  );
  assert.match(html, /Артефакт Claude/);
  assert.match(html, /claude\.ai/);
  assert.match(html, /проверку на бота/);
  // In this order: Claude itself, the link as a work, the downloaded file right in the card.
  const ask = html.indexOf("Попросить Claude");
  const link = html.indexOf("Сохранить как ссылку");
  const drop = html.indexOf("Скачайте в Claude (Export → Download) и перетащите сюда");
  assert.ok(ask >= 0 && link > ask && drop > link, `order: ${ask} ${link} ${drop}`);
  assert.ok(html.includes(CLAUDE_PHRASE));
  assert.match(html, /Скопировать фразу/);
  assert.ok(html.indexOf("DROPZONE") > drop, "the drop zone is inside the card");
  // The extension waits behind a small link, with room for the bookmarklet.
  assert.match(html, /<details class="url-import-oneclick"><summary>Сохранять в один клик<\/summary>/);
  assert.match(html, /data-slot="bookmarklet"/);
  // Another service: the phrase names the link for the user's agent.
  const v0 = "https://v0.app/chat/demo";
  const other = renderToStaticMarkup(
    React.createElement(ProviderGuide, { result: classify(v0), url: v0, onFile: () => {} }),
  );
  assert.match(other, /Попросить агента/);
  assert.ok(other.includes(agentPhrase(v0)));
  assert.match(other, /пока сохраняет артефакты Claude и ChatGPT/);
});
