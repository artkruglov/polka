// Web fixes before launch: the 404 page, the claim choice of a weak
// session, search snippets beside the title, shelf kinds.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotFoundContent as NotFound } from "../apps/web/src/pages/not-found/content.tsx";
import { ClaimChoice } from "../apps/web/src/pages/claim/index.tsx";
import { snippetBesideTitle } from "../apps/web/src/widgets/shelf-card/cover-model.ts";
import { DeleteShelf } from "../apps/web/src/pages/agents/delete-shelf.tsx";
import { AgentHeroView } from "../apps/web/src/features/agent-hero/index.tsx";
import {
  clientHints,
  isLoopbackOrigin,
} from "../apps/web/src/entities/onboarding/connect-phrase.ts";
import { categoryOf } from "../apps/web/src/entities/artifact/format.ts";
import { APP_PAGES, isAppPage, isMachinePath } from "../packages/contracts/app-routes.ts";
import { SEARCH_MATCH_END as E, SEARCH_MATCH_START as S } from "../packages/contracts/constants.ts";

const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const noop = () => {};

test("the 404 page names the problem and leads to the shelf and the landing", () => {
  const html = render(React.createElement(NotFound));
  assert.match(html, /<h1>Страница не найдена<\/h1>/);
  assert.match(html, /href="\/"[^>]*>Моя полка</);
  assert.match(html, /href="\/landing"[^>]*>О Полке</);
});

test("one list of pages for the server and the router", () => {
  for (const path of APP_PAGES) assert.ok(isAppPage(path), path);
  assert.ok(isAppPage("/works/00000000-0000-4000-8000-000000000000"));
  assert.ok(isAppPage("/discover/collections"));
  for (const path of ["/nope", "/works/abc", "/pricing/", "/settingz", "/discover/A"])
    assert.ok(!isAppPage(path), path);
  for (const path of ["/api", "/api/x", "/mcp", "/oauth/token", "/.well-known/x"])
    assert.ok(isMachinePath(path), path);
  for (const path of ["/apis", "/mcpx", "/oauthorize"]) assert.ok(!isMachinePath(path), path);
});

test("a session from an agent's link may go over to the other shelf, not merge", () => {
  const strong = render(
    React.createElement(ClaimChoice, { weak: false, via: "через Яндекс ID", busy: null, onAct: noop }),
  );
  assert.match(strong, />Объединить</);
  assert.match(strong, />Открыть ту полку без объединения</);
  const weak = render(
    React.createElement(ClaimChoice, { weak: true, via: "через Яндекс ID или по почте", busy: null, onAct: noop }),
  );
  assert.doesNotMatch(weak, /Объединить</);
  assert.match(weak, />Перейти в ту полку</);
  assert.match(weak, /Чтобы объединить полки, войдите через Яндекс ID или по почте/);
});

test("a search snippet does not repeat the title the card already shows", () => {
  const title = "Отчёт по продажам";
  assert.equal(
    snippetBesideTitle(`Отчёт по ${S}продажам${E}. Выручка выросла на 12% за квартал`, title),
    "Выручка выросла на 12% за квартал",
  );
  // A mark that opens in the title and closes after it stays a pair.
  assert.equal(
    snippetBesideTitle(`${S}Отчёт по продажам. Выручка${E} выросла за квартал`, title),
    `${S}Выручка${E} выросла за квартал`,
  );
  // Only the title: nothing to add.
  assert.equal(snippetBesideTitle(`${S}Отчёт${E} по продажам`, title), null);
  // Not the title: as is, including a longer first word.
  const other = `Выручка ${S}продажам${E} на пользу`;
  assert.equal(snippetBesideTitle(other, title), other);
  const longer = `Отчёт по продажами ${S}рынка${E} и не только`;
  assert.equal(snippetBesideTitle(longer, title), longer);
});

test("the settings say how to delete the shelf, with the configured address", () => {
  const hosted = render(React.createElement(DeleteShelf, { contact: "privacy@polochka.app" }));
  assert.match(hosted, /id="delete-shelf"/);
  assert.match(hosted, /<h2 id="delete-shelf-title">Удалить полку<\/h2>/);
  assert.match(hosted, /href="mailto:privacy@polochka\.app\?subject=[^"]+">privacy@polochka\.app<\/a>/);
  assert.match(hosted, /удалим полку и все данные/);
  const bare = render(React.createElement(DeleteShelf, { contact: null }));
  assert.match(bare, /Напишите оператору этой установки/);
  assert.doesNotMatch(bare, /mailto:/);
  assert.ok(isAppPage("/settings"));
});

test("an installation on 127.0.0.1 offers only the paths that reach it", () => {
  assert.ok(isLoopbackOrigin("http://127.0.0.1:4713"));
  assert.ok(isLoopbackOrigin("http://localhost:4390"));
  assert.ok(!isLoopbackOrigin("https://polochka.app"));
  assert.deepEqual(
    clientHints("http://127.0.0.1:4713").map((hint) => hint.id),
    ["codex", "claude-code"],
  );
  assert.equal(clientHints("https://polochka.app").length, 4);
  const props = {
    connections: { status: "ready" as const, active: [] },
    hidden: false,
    client: "claude-ai" as const,
    onClient: noop,
    onHide: noop,
    onShow: noop,
    onUpload: noop,
  };
  const local = render(React.createElement(AgentHeroView, { ...props, origin: "http://127.0.0.1:4713" }));
  assert.doesNotMatch(local, /Add custom connector|>Claude<\/button>/);
  assert.match(local, /claude plugin install polka@polka/);
  const hosted = render(React.createElement(AgentHeroView, { ...props, origin: "https://polochka.app" }));
  assert.match(hosted, /Add custom connector/);
});

test("one upload has one kind: every HTML page is a page", () => {
  assert.equal(categoryOf({ mime: "text/html" }), "pages");
  assert.equal(categoryOf({ mime: "text/markdown" }), "documents");
  assert.equal(categoryOf({ mime: "text/plain" }), "documents");
  assert.equal(categoryOf({ mime: "image/webp" }), "images");
  assert.equal(categoryOf({ mime: "application/vnd.polka.link+json" }), "other");
});
