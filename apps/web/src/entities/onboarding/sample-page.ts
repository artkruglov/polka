/**
 * The built-in example a person can put on the shelf in one click, without an
 * agent. Self-contained: no scripts, forms or remote resources, so the server
 * classifies it as a static page (a link can be issued, and it opens in the
 * scriptless sandbox on every installation). Saved through the ordinary
 * upload flow as a normal work; nothing on the server knows it is an example.
 */
export const SAMPLE_TITLE = "Пример: итоги недели";
export const SAMPLE_FILENAME = "polka-sample.html";

export function samplePage(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SAMPLE_TITLE}</title>
<style>
  :root { color-scheme: light; --ink: #0f1420; --muted: #647087; --line: #e7ebf1; --accent: #1f4fff; --soft: #f5f7fa; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 24px 56px; font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
  main { max-width: 720px; margin: 0 auto; }
  .eyebrow { color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 8px 0 6px; font-size: 32px; line-height: 1.1; letter-spacing: -.03em; }
  .lead { margin: 0 0 28px; color: var(--muted); font-size: 16px; }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 28px; }
  .tile { padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); }
  .tile b { display: block; font-size: 26px; letter-spacing: -.03em; }
  .tile span { color: var(--muted); font-size: 13px; }
  h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: -.02em; }
  .bars { display: grid; gap: 8px; margin-bottom: 28px; }
  .bar { display: grid; grid-template-columns: 96px minmax(0, 1fr) 40px; align-items: center; gap: 10px; font-size: 13px; }
  .bar i { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #1f4fff, #7b8cff); }
  .bar em { color: var(--muted); font-style: normal; text-align: right; }
  ul { margin: 0 0 28px; padding-left: 20px; }
  li { margin: 6px 0; }
  .note { padding: 14px 16px; border: 1px solid #dbe5ff; border-radius: 10px; background: #edf2ff; color: #1a3fd1; font-size: 14px; }
  footer { margin-top: 32px; color: var(--muted); font-size: 12px; }
  @media (max-width: 560px) { body { padding: 28px 16px 40px; } .tiles { grid-template-columns: 1fr; } h1 { font-size: 26px; } }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Отчёт · 16–22 сентября</p>
  <h1>Итоги недели</h1>
  <p class="lead">Такую страницу агент собирает за минуту. Полка хранит её версиями и даёт ссылку, которую откроют без аккаунта.</p>
  <div class="tiles">
    <div class="tile"><b>1 240</b><span>посетителей, +18 % к прошлой неделе</span></div>
    <div class="tile"><b>37</b><span>сохранённых работ</span></div>
    <div class="tile"><b>92 %</b><span>ссылок открыли с телефона</span></div>
  </div>
  <h2>Откуда приходили</h2>
  <div class="bars">
    <div class="bar">Из чата <i style="width: 72%"></i><em>72 %</em></div>
    <div class="bar">Прямая ссылка <i style="width: 18%"></i><em>18 %</em></div>
    <div class="bar">Поиск <i style="width: 10%"></i><em>10 %</em></div>
  </div>
  <h2>Что дальше</h2>
  <ul>
    <li>Собрать сравнение двух вариантов лендинга.</li>
    <li>Обновить эту страницу новой версией: старая ссылка не сломается.</li>
    <li>Отправить итоги команде одной ссылкой.</li>
  </ul>
  <p class="note">Это страница-пример: она уже лежит на вашей полке как версия 1. Ссылку на неё включаете вы, а удалить её можно в корзину.</p>
  <footer>Сделано с агентом · сохранено на Полке</footer>
</main>
</body>
</html>
`;
}

export const sampleBlob = () => new Blob([samplePage()], { type: "text/html" });

/**
 * The interactive example (owner's decision of 15.10.2026): the same report
 * with a week switcher — a little inline script, no network, forms or remote
 * resources, so the server classifies it as `limited`. Offered only where
 * the live viewer runs in production (/api/capabilities liveMode), since
 * elsewhere it would open as a static page and show nothing interactive.
 */
export const INTERACTIVE_SAMPLE_TITLE = "Пример: итоги недели с переключателем";
export const INTERACTIVE_SAMPLE_FILENAME = "polka-sample-interactive.html";

export function interactiveSamplePage(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${INTERACTIVE_SAMPLE_TITLE}</title>
<style>
  :root { color-scheme: light; --ink: #0f1420; --muted: #647087; --line: #e7ebf1; --accent: #1f4fff; --soft: #f5f7fa; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 24px 56px; font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
  main { max-width: 720px; margin: 0 auto; }
  .eyebrow { color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 8px 0 6px; font-size: 32px; line-height: 1.1; letter-spacing: -.03em; }
  .lead { margin: 0 0 20px; color: var(--muted); font-size: 16px; }
  .weeks { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .weeks button { padding: 8px 14px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--ink); font: inherit; cursor: pointer; }
  .weeks button[aria-pressed="true"] { border-color: var(--accent); background: #edf2ff; color: #1a3fd1; font-weight: 600; }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 28px; }
  .tile { padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); }
  .tile b { display: block; font-size: 26px; letter-spacing: -.03em; }
  .tile span { color: var(--muted); font-size: 13px; }
  h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: -.02em; }
  .bars { display: grid; gap: 8px; margin-bottom: 28px; }
  .bar { display: grid; grid-template-columns: 112px minmax(0, 1fr) 40px; align-items: center; gap: 10px; font-size: 13px; }
  .bar i { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #1f4fff, #7b8cff); transition: width .3s ease; }
  .bar em { color: var(--muted); font-style: normal; text-align: right; }
  .note { padding: 14px 16px; border: 1px solid #dbe5ff; border-radius: 10px; background: #edf2ff; color: #1a3fd1; font-size: 14px; }
  footer { margin-top: 32px; color: var(--muted); font-size: 12px; }
  @media (max-width: 560px) { body { padding: 28px 16px 40px; } .tiles { grid-template-columns: 1fr; } h1 { font-size: 26px; } }
  @media (prefers-reduced-motion: reduce) { .bar i { transition: none; } }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Отчёт · три недели</p>
  <h1>Итоги недели</h1>
  <p class="lead">Эта страница живая: переключите неделю, и цифры обновятся. Полка показывает такие страницы в отдельной защищённой песочнице.</p>
  <div class="weeks" role="group" aria-label="Неделя">
    <button type="button" data-week="0" aria-pressed="false">2–8 сентября</button>
    <button type="button" data-week="1" aria-pressed="false">9–15 сентября</button>
    <button type="button" data-week="2" aria-pressed="true">16–22 сентября</button>
  </div>
  <div class="tiles" aria-live="polite">
    <div class="tile"><b id="visitors">1 240</b><span>посетителей за неделю</span></div>
    <div class="tile"><b id="works">37</b><span>сохранённых работ</span></div>
    <div class="tile"><b id="mobile">92 %</b><span>ссылок открыли с телефона</span></div>
  </div>
  <h2>Откуда приходили</h2>
  <div class="bars">
    <div class="bar">Из чата <i id="bar-chat" style="width: 72%"></i><em id="pct-chat">72 %</em></div>
    <div class="bar">Прямая ссылка <i id="bar-direct" style="width: 18%"></i><em id="pct-direct">18 %</em></div>
    <div class="bar">Поиск <i id="bar-search" style="width: 10%"></i><em id="pct-search">10 %</em></div>
  </div>
  <p class="note">Это страница-пример: она лежит на вашей полке как версия 1. Ссылку на неё включаете вы, а удалить её можно в корзину.</p>
  <footer>Сделано с агентом · сохранено на Полке</footer>
</main>
<script>
  var weeks = [
    { visitors: "860", works: "21", mobile: "88 %", chat: 61, direct: 27, search: 12 },
    { visitors: "1 050", works: "29", mobile: "90 %", chat: 66, direct: 22, search: 12 },
    { visitors: "1 240", works: "37", mobile: "92 %", chat: 72, direct: 18, search: 10 }
  ];
  function show(index) {
    var week = weeks[index];
    document.getElementById("visitors").textContent = week.visitors;
    document.getElementById("works").textContent = week.works;
    document.getElementById("mobile").textContent = week.mobile;
    ["chat", "direct", "search"].forEach(function (key) {
      document.getElementById("bar-" + key).style.width = week[key] + "%";
      document.getElementById("pct-" + key).textContent = week[key] + " %";
    });
    document.querySelectorAll("[data-week]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-week") === String(index)));
    });
  }
  document.querySelectorAll("[data-week]").forEach(function (button) {
    button.addEventListener("click", function () { show(Number(button.getAttribute("data-week"))); });
  });
</script>
</body>
</html>
`;
}

/**
 * The example this installation offers: the interactive one only where the
 * live viewer runs in production, the static one everywhere else.
 */
export function chooseSample(liveMode: string | null | undefined) {
  return liveMode === "production"
    ? {
        title: INTERACTIVE_SAMPLE_TITLE,
        filename: INTERACTIVE_SAMPLE_FILENAME,
        blob: () => new Blob([interactiveSamplePage()], { type: "text/html" }),
      }
    : { title: SAMPLE_TITLE, filename: SAMPLE_FILENAME, blob: sampleBlob };
}
