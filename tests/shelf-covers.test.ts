// Shelf covers (docs/specs/SHELF_COVERS.md): the text-or-picture heuristic,
// the cover the owner's card asks for once per version, the picture drawn by
// the renderer (a fake one here) and served with long caching, the backfill
// with --dry-run, and the card model (series, labels, the repeated title).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";
import {
  COVER_VERSION,
  accentOf,
  clip,
  coverFactsFromHtml,
  coverFactsFromText,
  decideKind,
} from "../apps/server/cover-facts.ts";
import { coverFactsBounded, drawCover } from "../apps/server/covers.ts";
import { backfillCovers } from "../apps/server/covers-backfill.ts";
import { parseSnapshotAnswer } from "../apps/server/cover-snapshot-client.ts";
import {
  cardKind,
  coverAccent,
  sameText,
  seriesBadge,
  seriesCounts,
  seriesOf,
} from "../apps/web/src/widgets/shelf-card/cover-model.ts";

const report = `<!doctype html><html><head><title>Y360 Radar · W36</title>
<style>h2{border-bottom:2px solid #e8472b}.kicker{color:#e8472b}body{color:#1d1d1f;background:#fff}td{border-color:#e5e5ea}</style></head>
<body><div class="kicker">Еженедельный обзор</div><h1>Y360 Radar — неделя 36</h1>
<p>Рынок корпоративных коммуникаций: цены, запуски и сделки конкурентов за 1–7 сентября.</p>
<h2>Главное</h2><p>Конкуренты продолжили снижать цены на корпоративные тарифы: средняя скидка выросла до 18%. Спрос смещается к пакетам.</p>
<p>Сегмент малого бизнеса остаётся самым чувствительным к цене: три из пяти компаний готовы сменить поставщика.</p>
<h2>Сигналы</h2><table><tr><td>Конкурент А</td><td>Скидка 20%</td></tr></table>
<h2>Дальше</h2><ul><li>Подготовить сравнение тарифов для отдела продаж к четвергу.</li></ul></body></html>`;

const dashboard = `<!doctype html><html><head><style>body{background:#0f172a;color:#e2e8f0}.up{color:#34d399}.tile{background:#1e293b}.a{color:#38bdf8}.b{fill:#38bdf8}</style></head>
<body><h1>Продажи Q3</h1><div class="tile">Выручка <b>48 млн</b></div><div class="tile">Клиенты <b>1284</b></div>
<canvas id="c" width="760" height="260"></canvas><svg viewBox="0 0 200 200" width="100%" height="240"><circle r="70" cx="100" cy="100"/></svg>
<script>document.getElementById('c').getContext('2d').fillRect(0,0,10,10)</script></body></html>`;

const app = `<!doctype html><html><head><title>Планировщик</title><style>button{background:#7c3aed}</style></head>
<body><div id="root"></div><script>document.getElementById('root').innerHTML='<input><button>Добавить</button>'</script></body></html>`;

test("the heuristic: a report is text with its own heading, lead and accent", () => {
  const facts = coverFactsFromHtml(report);
  assert.equal(facts.kind, "text");
  assert.equal(facts.genre, "report");
  assert.equal(facts.heading, "Y360 Radar — неделя 36");
  assert.match(facts.lead!, /^Рынок корпоративных коммуникаций/);
  assert.equal(facts.accent, "#e8472b");
  assert.equal(facts.signals.tables, 1);
});

test("the heuristic: a dashboard and a script-drawn app are pictures", () => {
  const board = coverFactsFromHtml(dashboard);
  assert.equal(board.kind, "visual");
  assert.equal(board.genre, "dashboard");
  assert.equal(board.heading, "Продажи Q3");
  assert.ok(board.signals.canvas === 1 && board.signals.svg === 1 && board.signals.charts);
  const planner = coverFactsFromHtml(app);
  assert.equal(planner.kind, "visual");
  assert.equal(planner.genre, "app");
  assert.equal(planner.signals.shell, true);
  // No heading in the markup: the <title> names it.
  assert.equal(planner.heading, "Планировщик");
  assert.equal(planner.accent, "#7c3aed");
});

test("the heuristic: a long report with one chart stays text; icons are not drawings", () => {
  const long = report.replace(
    "</body>",
    `${"<p>Подробный разбор рынка с цифрами и выводами для отдела продаж и маркетинга на следующий квартал.</p>".repeat(12)}
     <canvas width="600" height="200"></canvas>
     <svg width="16" height="16" viewBox="0 0 24 24"><path d="M0 0"/></svg></body>`,
  );
  const facts = coverFactsFromHtml(long);
  assert.equal(facts.kind, "text");
  assert.equal(facts.signals.svg, 0);
  assert.equal(facts.signals.canvas, 1);
  // Chart libraries are recognised by address and by call.
  assert.equal(coverFactsFromHtml('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>').signals.charts, true);
  assert.equal(coverFactsFromHtml("<script>echarts.init(el)</script>").signals.charts, true);
});

test("the decision is a pure function of the signals", () => {
  const none = {
    text: 0, headings: 0, paragraphs: 0, tables: 0, canvas: 0, svg: 0,
    images: 0, video: 0, controls: 0, charts: false, scripted: false, shell: false,
  };
  assert.deepEqual(decideKind({ ...none, text: 5000, headings: 4, paragraphs: 10 }), { kind: "text", genre: "report" });
  assert.deepEqual(decideKind({ ...none, text: 1500, paragraphs: 3 }), { kind: "text", genre: "document" });
  assert.deepEqual(decideKind({ ...none, text: 100, images: 3 }), { kind: "visual", genre: "page" });
  assert.deepEqual(decideKind({ ...none, text: 50, scripted: true, shell: true, controls: 5 }), { kind: "visual", genre: "app" });
});

test("text files: a Markdown heading or the first short line leads", () => {
  const md = coverFactsFromText("# Ретро спринта 38\n\nСпринт закрыли на **86%**.\n\n## Что получилось\n- Комментарии", "retro.md");
  assert.deepEqual([md.kind, md.genre, md.heading, md.lead], ["text", "markdown", "Ретро спринта 38", "Спринт закрыли на 86%."]);
  const note = coverFactsFromText("Созвон 23 сентября\n\nДоговорились обновить прайс.\n— Олег соберёт возражения.", "n.txt");
  assert.deepEqual([note.genre, note.heading, note.lead], ["note", "Созвон 23 сентября", "Договорились обновить прайс. — Олег соберёт возражения."]);
  // A text without a short first line has no heading; the card uses the title.
  assert.equal(coverFactsFromText("x".repeat(300)).heading, null);
});

test("accent and clipping", () => {
  assert.equal(accentOf("color:#333;background:#fafafa;border:#eee"), null);
  assert.equal(accentOf("a{color:#1f4fff}b{color:#1f4fff}c{color:rgb(232,71,43)}"), "#1f4fff");
  assert.equal(clip("  один   два три  ", 50), "один два три");
  assert.ok(clip("слово ".repeat(80), 60).length <= 60);
  assert.ok(clip("слово ".repeat(80), 60).endsWith("…"));
});

test("a page too deep to read in time gets a picture, not a stalled request", async () => {
  const deep = "<div>".repeat(60_000) + "текст";
  const facts = await coverFactsBounded(deep, 50);
  assert.equal(facts.kind, "visual");
});

test("the renderer's answer: only a small JPEG or a known outcome", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
  assert.deepEqual(parseSnapshotAnswer(200, JSON.stringify({ image: jpeg, blank: false })), { image: jpeg, blank: false });
  assert.deepEqual(parseSnapshotAnswer(200, JSON.stringify({ blank: true })), { blank: true });
  assert.deepEqual(parseSnapshotAnswer(503, JSON.stringify({ error: "busy" })), { error: "busy" });
  assert.throws(() => parseSnapshotAnswer(200, JSON.stringify({ image: Buffer.from("<svg/>").toString("base64"), blank: false })));
  assert.throws(() => parseSnapshotAnswer(200, JSON.stringify({ error: "weird" })));
  assert.throws(() => parseSnapshotAnswer(200, "not json"));
});

test("the card model: series, labels and the repeated title", () => {
  assert.equal(seriesOf("Y360 Radar · неделя W36"), "Y360 Radar");
  assert.equal(seriesOf("Итоги: сентябрь"), "Итоги");
  assert.equal(seriesOf("Просто заметка"), null);
  assert.equal(seriesOf("· без префикса"), null);
  const items = ["Y360 Radar · W36", "Y360 Radar · W37", "y360 radar — W38", "Бюджет · 2027"].map((title) => ({ title }));
  const counts = seriesCounts(items);
  assert.deepEqual([...counts], [["y360 radar", 3]]);
  assert.deepEqual(seriesBadge("Y360 Radar · W36", counts), { name: "Y360 Radar", count: 3 });
  assert.equal(seriesBadge("Бюджет · 2027", counts), null);
  assert.equal(sameText("Ретроспектива спринта 38.", "ретроспектива  спринта 38"), true);
  assert.equal(sameText("Y360 Radar — неделя 36", "Y360 Radar · неделя W36"), false);
  const revision = { mime: "text/html", cover: { genre: "dashboard" } } as any;
  assert.equal(cardKind({ revision }), "Дашборд");
  assert.equal(cardKind({ revision: { mime: "text/html" } as any }), "Страница");
  // A series shares its colour; a page's own accent wins.
  assert.equal(coverAccent({ id: "a", title: "Y360 Radar · W36" }, null).color, coverAccent({ id: "b", title: "Y360 Radar · W37" }, null).color);
  assert.equal(coverAccent({ id: "a", title: "x" }, { accent: "#e8472b" }).color, "#e8472b");
});

// The pipeline over the app.
const server = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
after(async () => {
  await server.close();
  await db.end();
  s3.destroy();
});
const call = (method: any, url: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method, url, headers: { origin, cookie, ...headers }, payload: body as any });

async function save(cookie: string, title: string, filename: string, mime: string, text: string) {
  const bytes = Buffer.from(text);
  const begun = await call("POST", "/api/uploads", cookie, {
    key: randomUUID(),
    title,
    filename,
    mime,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId } = begun.json();
  const put = await call("PUT", `/api/uploads/${uploadId}/bytes`, cookie, bytes, { "content-type": "application/octet-stream" });
  assert.equal(put.statusCode, 200, put.body);
  const done = await call("POST", `/api/uploads/${uploadId}/finalize`, cookie);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

test("a card asks once per version; the list carries the cover from then on; pictures are drawn once and cached", async () => {
  const name = "covers-" + randomBytes(5).toString("hex");
  await createAccount(name, password);
  const login = await call("POST", "/api/login", "", { name, password });
  const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const text = await save(cookie, "Y360 Radar · неделя W36", "radar.html", "text/html", report);
  const visual = await save(cookie, "Продажи Q3", "sales.html", "text/html", dashboard);

  // Before anyone asked: the list says «not decided yet», and loads no page.
  let list = (await call("GET", "/api/artifacts", cookie)).json();
  const card = (id: string) => list.items.find((item: any) => item.id === id);
  assert.equal(card(text.artifactId).revision.cover, null);

  const asked = await call("GET", `/api/revisions/${text.revisionId}/cover`, cookie);
  assert.equal(asked.statusCode, 200, asked.body);
  assert.deepEqual(asked.json().cover, {
    kind: "text",
    genre: "report",
    heading: "Y360 Radar — неделя 36",
    lead: "Рынок корпоративных коммуникаций: цены, запуски и сделки конкурентов за 1–7 сентября.",
    accent: "#e8472b",
    image: "none",
    imageKey: null,
  });
  // Snapshots are off in this installation: a visual work says so (no picture pending).
  const pictured = (await call("GET", `/api/revisions/${visual.revisionId}/cover`, cookie)).json().cover;
  assert.equal(pictured.kind, "visual");
  assert.equal(pictured.image, "none");
  list = (await call("GET", "/api/artifacts", cookie)).json();
  assert.equal(card(text.artifactId).revision.cover.heading, "Y360 Radar — неделя 36");
  assert.equal((await call("GET", `/api/revisions/${text.revisionId}/cover.jpg`, cookie)).statusCode, 404);

  // The renderer (a fake here) draws the picture once; a second attempt finds nothing to do.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
  let sent: { html: string; script: boolean } | null = null;
  const fake = async (page: { html: string; script: boolean }) => {
    sent = page;
    return { image: jpeg.toString("base64"), blank: false as const };
  };
  assert.equal(await drawCover(visual.revisionId, fake), "ready");
  assert.match(sent!.html, /Продажи Q3/);
  assert.equal(await drawCover(visual.revisionId, fake), "skipped");
  const ready = (await call("GET", `/api/revisions/${visual.revisionId}/cover`, cookie)).json().cover;
  assert.equal(ready.image, "ready");
  assert.equal(ready.imageKey, createHash("sha256").update(jpeg).digest("hex").slice(0, 16));
  const image = await call("GET", `/api/revisions/${visual.revisionId}/cover.jpg?k=${ready.imageKey}`, cookie);
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/jpeg");
  assert.equal(image.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.deepEqual(image.rawPayload, jpeg);
  // Someone else's cover: not found, like the work.
  const otherName = "covers-other-" + randomBytes(5).toString("hex");
  await createAccount(otherName, password);
  const other = await call("POST", "/api/login", "", { name: otherName, password });
  const otherCookie = `${other.cookies[0].name}=${other.cookies[0].value}`;
  assert.equal((await call("GET", `/api/revisions/${visual.revisionId}/cover`, otherCookie)).statusCode, 404);
  assert.equal((await call("GET", `/api/revisions/${visual.revisionId}/cover.jpg`, otherCookie)).statusCode, 404);

  // A page that draws nothing: no picture, the card keeps its own cover.
  const blank = await save(cookie, "Пустое приложение", "blank.html", "text/html", app);
  await call("GET", `/api/revisions/${blank.revisionId}/cover`, cookie);
  assert.equal(await drawCover(blank.revisionId, async () => ({ blank: true as const })), "blank");
  assert.equal((await call("GET", `/api/revisions/${blank.revisionId}/cover`, cookie)).json().cover.image, "none");

  // A busy renderer: tried again, at most three times.
  const busy = await save(cookie, "Ещё дашборд", "busy.html", "text/html", dashboard.replace("Q3", "Q4"));
  await call("GET", `/api/revisions/${busy.revisionId}/cover`, cookie);
  const refuse = async () => ({ error: "busy" as const });
  assert.deepEqual(
    [await drawCover(busy.revisionId, refuse), await drawCover(busy.revisionId, refuse), await drawCover(busy.revisionId, refuse), await drawCover(busy.revisionId, refuse)],
    ["retry", "retry", "failed", "skipped"],
  );

  // The cover (and its picture) goes with its revision: every deletion path cascades.
  const fk = await db.query(
    `SELECT confdeltype FROM pg_constraint WHERE conrelid='revision_covers'::regclass AND contype='f'`,
  );
  assert.deepEqual(fk.rows, [{ confdeltype: "c" }]);
});

test("the backfill: --dry-run writes nothing, a run covers every latest version once", async () => {
  const name = "covers-bf-" + randomBytes(5).toString("hex");
  await createAccount(name, password);
  const login = await call("POST", "/api/login", "", { name, password });
  const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const saved = await save(cookie, "Заметка", "n.txt", "text/plain", "Созвон\n\nДоговорились обновить прайс.");
  const has = async () => (await db.query("SELECT version FROM revision_covers WHERE revision_id=$1", [saved.revisionId])).rows[0];
  const dry = await backfillCovers({ dryRun: true });
  assert.ok(dry.scanned >= 1 && dry.covered === 0);
  assert.equal(await has(), undefined);
  const run = await backfillCovers();
  assert.ok(run.covered >= 1 && run.failed === 0);
  assert.equal(Number((await has()).version), COVER_VERSION);
  // Idempotent: nothing of this shelf is left to do.
  const again = await backfillCovers({ dryRun: true });
  const left = await db.query(
    `SELECT 1 FROM revisions r JOIN artifacts a ON a.latest_revision_id=r.id
     LEFT JOIN revision_covers c ON c.revision_id=r.id WHERE r.id=$1 AND c.revision_id IS NULL`,
    [saved.revisionId],
  );
  assert.equal(left.rowCount, 0);
  assert.ok(again.scanned <= dry.scanned);
});
