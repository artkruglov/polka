import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { classify } from "../apps/web/src/features/import-url/classify-demo.ts";
import { profileView } from "../apps/web/src/entities/artifact/format.ts";
import { STATIC_HTML_CSP, classifyHtml } from "../apps/server/html.ts";

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
    assert.ok(view.now.length > 0);
    if (profile === "limited") {
      assert.match(view.badge, /Статичный просмотр без скриптов/);
      assert.equal(view.plan, "");
      assert.match(view.text, /Если доступен интерактивный режим/);
    }
    if (profile === "static") assert.equal(view.badge, "Статичный просмотр");
  });

test("Static CSP stays scriptless and networkless", () => {
  assert.ok(STATIC_HTML_CSP.startsWith("sandbox;"));
  assert.doesNotMatch(STATIC_HTML_CSP, /allow-scripts|script-src|connect-src/);
  assert.match(STATIC_HTML_CSP, /default-src 'none'/);
});

test("importMock classifies links without issuing ids or receipts", () => {
  const cases: [string, string, string | null][] = [
    ["not a url", "not_https", null],
    ["http://claude.ai/public/artifacts/abc", "not_https", null],
    ["https://claude.ai/public/artifacts/abc-123", "ready", "claude"],
    ["https://chatgpt.com/share/abc", "ready", "chatgpt"],
    ["https://chatgpt.com/canvas/shared/abc", "ready", "chatgpt"],
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
  assert.equal(authReturnTo({pathname:"/s",search:"",hash:"#share-token"}), "/s#share-token");
});
