import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { classify } from "../apps/web/src/features/import-url/classify-link.ts";
import { profileView } from "../apps/web/src/entities/artifact/format.ts";
import { STATIC_HTML_CSP, VIEWER_GUARD, classifyHtml, classifyHtmlBounded, withNewTabLinks, withViewerGuard } from "../apps/server/html.ts";

const prose =
  "Отчёт за квартал: выручка выросла, расходы снизились, команда закрыла все ключевые задачи и подготовила план на следующий период.";

// Expected profiles of the current static build. Interactive fixtures stay "limited" (seen, not working)
// until a networkless runtime exists; anything with forms, passwords, remote code or redirects is owner-only.
const fixtures: Record<
  string,
  { html: string; profile: "static" | "limited" | "unsupported" }
> = {
  "static-report": {
    html: `<!doctype html><h1>Итоги</h1><p>${prose}</p><style>p{color:#333}</style>`,
    profile: "static",
  },
  "inline-calculator": {
    html: `<h1>Калькулятор</h1><p>${prose}</p><input id=a type=number><button onclick="calc()">Считать</button><script>function calc(){}</script>`,
    profile: "limited",
  },
  "inline-chart": {
    html: `<h1>График</h1><p>${prose}</p><canvas id=c></canvas><script>const c=document.getElementById('c')</script>`,
    profile: "limited",
  },
  "checkbox-planner": {
    html: `<h1>План</h1><p>${prose}</p><input type=checkbox onchange="save()"><script>function save(){}</script>`,
    profile: "limited",
  },
  "fetch-weather": {
    html: `<h1>Погода</h1><p>${prose}</p><script>fetch("https://api.example/weather")</script>`,
    profile: "limited",
  },
  "cdn-dashboard": {
    html: `<h1>Дашборд</h1><p>${prose}</p><script src="https://cdn.example/chart.js"></script>`,
    profile: "unsupported",
  },
  "form-feedback": {
    html: `<h1>Отзыв</h1><p>${prose}</p><form><textarea></textarea></form>`,
    profile: "unsupported",
  },
  "password-login": {
    html: `<h1>Вход</h1><p>${prose}</p><input type="password">`,
    profile: "unsupported",
  },
  "meta-refresh": {
    html: `<meta http-equiv="refresh" content="0;url=https://example.com"><p>${prose}</p>`,
    profile: "unsupported",
  },
  "script-only": {
    html: `<div id=root></div><script>render()</script>`,
    profile: "unsupported",
  },
};

for (const [name, fixture] of Object.entries(fixtures))
  test(`HTML profile fixture ${name} is ${fixture.profile}`, () => {
    const profile = classifyHtml(fixture.html);
    assert.equal(profile, fixture.profile);
    const view = profileView({ mime: "text/html", htmlProfile: profile });
    assert.equal(view.linkable, profile !== "unsupported");
    assert.ok(view.text.length > 0);
    if (profile === "limited") {
      assert.match(view.badge, /Статичный просмотр без скриптов/);
      assert.match(view.text, /Если доступен интерактивный режим/);
    }
    if (profile === "static") assert.equal(view.badge, "Статичный просмотр");
  });

test("Static CSP stays scriptless and networkless", () => {
  // Links open only in a new tab on a reader's click; no scripts,
  // same-origin, forms or top navigation (a target=_top link could
  // replace the Полка tab with a look-alike page).
  const sandbox = STATIC_HTML_CSP.split(";")[0]!.split(" ");
  assert.equal(sandbox[0], "sandbox");
  assert.deepEqual(sandbox.slice(1).sort(), [
    "allow-popups",
    "allow-popups-to-escape-sandbox",
  ]);
  assert.doesNotMatch(STATIC_HTML_CSP, /allow-scripts|allow-top-navigation|script-src|connect-src/);
  assert.match(STATIC_HTML_CSP, /default-src 'none'/);
});

test("importMock classifies links without issuing ids or receipts", () => {
  const cases: [string, string, string | null][] = [
    ["not a url", "not_https", null],
    ["http://claude.ai/public/artifacts/abc", "not_https", null],
    ["https://claude.ai/public/artifacts/abc-123", "provider", "claude"],
    ["https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo", "provider", "claude"],
    ["https://abc.claude.site/artifacts/x", "provider", "claude"],
    ["https://chatgpt.com/share/abc", "provider", "chatgpt"],
    ["https://chatgpt.com/canvas/shared/abc", "provider", "chatgpt"],
    ["https://claude.ai/chat/abc", "closed", "claude"],
    ["https://chatgpt.com/c/abc", "closed", "chatgpt"],
    ["https://example.com/login?next=/report", "closed", null],
    ["https://example.com/report.html", "ready", "html"],
    ["https://example.com/bundle.zip", "unsupported_host", "zip"],
    ["https://example.com/report", "unsupported_host", null],
  ];
  for (const [url, status, source] of cases) {
    const result = classify(url);
    assert.equal(result.status, status, url);
    assert.equal(result.source, source, url);
    assert.ok(result.explain.length > 0, url);
    assert.ok(!("artifactId" in result) && !("receipt" in result), url);
  }
  for (const [url] of cases)
    if (classify(url).source !== "zip")
      assert.match(classify(url).explain, /файл/i, url);
  // Provider artifacts explain why Полка cannot fetch them and how to bring the file.
  const provider = classify("https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo");
  assert.match(provider.explain, /не отдаёт такую ссылку серверу Полки/);
  assert.match(provider.explain, /как ссылку/);
});

test("User-facing profile strings do not promise universal VPN-free availability", () => {
  for (const htmlProfile of [
    "static",
    "limited",
    "unsupported",
    null,
  ] as const) {
    const view = profileView({
      mime: htmlProfile ? "text/html" : "image/png",
      htmlProfile,
    });
    const text = Object.values(view).join(" ");
    assert.doesNotMatch(text, /без\s+VPN/i);
  }
});

test("User-facing TSX does not claim universal VPN-free availability", () => {
  const dir = new URL("../apps/web/src/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    // Identifiers like ArtifactPreview are Latin; only Cyrillic prose and VPN promises are user-facing.
    const code = readFileSync(new URL(file, dir), "utf8").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    assert.doesNotMatch(code, /без\s+VPN/i, file);
  }
});

test("Auth return destination rejects cross-origin and browser-normalized redirects", async () => {
  const { safeNext } = await import("../apps/web/src/shared/lib/safe-next.ts");
  for (const url of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
  ])
    assert.equal(safeNext(url), null);
  assert.equal(
    safeNext("/bring?url=https%3A%2F%2Fexample.com#file"),
    "/bring?url=https%3A%2F%2Fexample.com#file",
  );
});

test("HTML acceptance corpus has intact standalone fixtures and honest static profiles", async () => {
  const { createHash } = await import("node:crypto");
  const root = new URL("./fixtures/html-corpus/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.items.length, 20);
  assert.equal(new Set(manifest.items.map((item: { kind: string }) => item.kind)).size, 5);
  for (const item of manifest.items) {
    assert.match(item.file, /^[a-z]+-[1-4]\.html$/);
    const bytes = readFileSync(new URL(item.file, root));
    assert.equal(bytes.length, item.bytes, item.id);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.id);
    assert.equal(classifyHtml(bytes.toString()), item.currentStaticProfile, item.id);
    assert.deepEqual(item.dependencies, []);
    assert.ok(item.action.length > 20);
    assert.equal(item.liveAcceptance, "not-tested");
  }
});


test("authentication return target preserves protected pages without nesting login URLs", async () => {
  const {authReturnTo} = await import("../apps/web/src/shared/lib/safe-next.ts");
  assert.equal(authReturnTo({pathname:"/works/example",search:"",hash:""}), "/works/example");
  assert.equal(authReturnTo({pathname:"/",search:"?login=1&next=%2Fbring%3Furl%3D",hash:""}), "/bring?url=");
  assert.equal(authReturnTo({pathname:"/signup",search:"?next=https%3A%2F%2Fevil.example",hash:""}), "/start");
  assert.equal(authReturnTo({pathname:"/",search:"?login=1",hash:""}), "/start");
  // The share token lives in the fragment and must not move into ?next=.
  assert.equal(authReturnTo({pathname:"/s",search:"",hash:"#share-token"}), "/start");
  for (const escape of ["/.//evil.example", "/a/..//evil.example", "/%2e//evil.example"])
    assert.equal(authReturnTo({pathname:"/",search:`?login=1&next=${encodeURIComponent(escape)}`,hash:""}), "/start", escape);
});

test("Static view opens links in a new tab without touching the stored bytes' content", () => {
  const view = (html: string) => withNewTabLinks(Buffer.from(html)).toString();
  assert.equal(
    view('<!doctype html><html><HEAD lang="ru"><title>x</title></HEAD><a href="https://e.x">a</a>'),
    '<!doctype html><html><HEAD lang="ru"><base target="_blank"><title>x</title></HEAD><a href="https://e.x">a</a>',
  );
  assert.equal(view("<p>no head</p>"), '<base target="_blank"><p>no head</p>');
  assert.equal(view("<header>not head</header>"), '<base target="_blank"><header>not head</header>');
  // A commented-out head would swallow the element and leave links navigating
  // this frame; the real head follows it.
  assert.equal(
    view('<!-- <head> --><html><head><a href="https://e.x">a</a></head></html>'),
    '<!-- <head> --><html><head><base target="_blank"><a href="https://e.x">a</a></head></html>',
  );
});

test("Page classification reads attributes the way a browser does, not as raw text", () => {
  const article = `<p>Пример: &lt;script&gt;alert(1)&lt;/script&gt; ${"текст ".repeat(30)}</p>`;
  // Browsers resolve character references before acting on an attribute, so a
  // refresh spelled with them still redirects the reader off Полка.
  for (const page of [
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<meta http-equiv="&#x72;efresh" content="0;url=https://evil.example">',
    "<meta http-equiv=refres&#x68; content=\"0;url=https://evil.example\">",
    '<a href="&#x6a;avascript:alert(1)">x</a>',
  ])
    assert.equal(classifyHtml(page), "unsupported", page);
  // Escaped code shown as text is still an ordinary page.
  assert.equal(classifyHtml(article), "static");
});

test("Classifying and viewing a hostile page stays linear in its size", () => {
  // Both run on the request thread; a regex that restarts at every "<" took
  // minutes on a page far below the 5 MB limit and froze the whole server.
  for (const unit of ["< ", "<meta ", "<input ", "<head ", "<a "]) {
    const page = unit.repeat(Math.floor((1024 * 1024) / unit.length));
    const started = performance.now();
    classifyHtml(page);
    withNewTabLinks(Buffer.from(page));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_500, `${JSON.stringify(unit)}: ${Math.round(elapsed)} ms`);
  }
});

test("zod-free contract constants match the contract module", async () => {
  const contracts = await import("../packages/contracts/index.ts");
  const constants = await import("../packages/contracts/constants.ts");
  assert.equal(constants.MAX_BYTES, contracts.MAX_BYTES);
  assert.equal(constants.MAX_TITLE, contracts.MAX_TITLE);
  assert.deepEqual(constants.MIME, contracts.MIME);
  assert.deepEqual(constants.REPORT_REASONS, contracts.REPORT_REASONS);
  assert.deepEqual(constants.AGENT_SCOPES, contracts.AGENT_SCOPES);
  for (const sample of ["<p>x</p>", "<!doctype html>", "просто текст", "<main>", "a < b"])
    assert.equal(constants.looksLikeHtml(sample), contracts.looksLikeHtml(sample), sample);
});

test("The viewer's WebRTC guard runs before anything the page runs", () => {
  const view = (html: string) => withViewerGuard(Buffer.from(html)).toString();
  // After a doctype, so the page keeps standards mode.
  assert.equal(view("<!DOCTYPE html><p>x</p>"), `<!DOCTYPE html>${VIEWER_GUARD}<p>x</p>`);
  assert.equal(view("\n<!-- c --> <!doctype html><p>x</p>"), `\n<!-- c --> <!doctype html>${VIEWER_GUARD}<p>x</p>`);
  // Without a doctype, at the very start: a script before <head> runs after it.
  assert.equal(view("<script>x()</script><head></head>"), `${VIEWER_GUARD}<script>x()</script><head></head>`);
  assert.equal(view("<!-- c --><script>x()</script>"), `${VIEWER_GUARD}<!-- c --><script>x()</script>`);
  // Bytes after the guard are untouched.
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("<!doctype html>é")]);
  assert.deepEqual(withViewerGuard(bytes).subarray(-2), Buffer.from("é"));
});

test("Deeply nested pages are classified off the request thread within a deadline", async () => {
  // parse5 is quadratic on deep nesting: this page alone would take minutes.
  const nested = "<div>".repeat(200_000);
  const started = performance.now();
  assert.equal(await classifyHtmlBounded(nested, 1_000), "unsupported");
  assert.ok(performance.now() - started < 3_000, `${Math.round(performance.now() - started)} ms`);
  // Deep but small: no call-stack overflow in the walk.
  assert.equal(classifyHtml("<div>".repeat(3_000) + "<p>hi</p>"), "static");
  // An honest large page still gets its real profile through the worker.
  const article = `<!doctype html><h1>Отчёт</h1>${"<p>Текст отчёта, достаточно длинный абзац.</p>".repeat(3_000)}`;
  assert.ok(article.length > 16 * 1024);
  assert.equal(await classifyHtmlBounded(article), "static");
  const scripted = `${article}<button onclick="go()">Далее</button><script>function go(){}</script>`;
  assert.equal(await classifyHtmlBounded(scripted), "limited");
});
