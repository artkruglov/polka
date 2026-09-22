// Local design-review fixtures: a `designer` account with a varied shelf.
// Refuses anything but a local database; never a hosted or shared installation.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createAccount } from "../apps/server/auth.ts";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { captureFromAgent } from "../apps/server/agent-capture.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
  throw new Error("seed-design-demo runs only against a local database");

const NAME = "designer";
const CREDENTIALS = `.local/${NAME}-account.txt`;

async function credentials() {
  try {
    const text = await readFile(CREDENTIALS, "utf8");
    const password = /Пароль: (.+)/.exec(text)?.[1]?.trim();
    if (password) return { password, created: false };
  } catch {
    /* first run */
  }
  const password = randomBytes(24).toString("base64url");
  await createAccount(NAME, password);
  await mkdir(".local", { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS, `Логин: ${NAME}\nПароль: ${password}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { password, created: true };
}

/** Minimal PNG encoder: an RGB gradient with a soft wave, no dependencies. */
function gradientPng(width: number, height: number) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const t = x / width,
        u = y / height;
      const wave = Math.sin(t * 6.2 + u * 2) * 0.5 + 0.5;
      const r = Math.round(28 + 120 * t + 40 * wave * (1 - u));
      const g = Math.round(70 + 90 * u + 30 * wave);
      const b = Math.round(230 - 60 * u);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = Math.min(255, r);
      raw[i + 1] = Math.min(255, g);
      raw[i + 2] = Math.min(255, b);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const page = (title: string, body: string, extraHead = "") =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;background:#fff}
.wrap{max-width:960px;margin:0 auto;padding:48px 40px}
h1{font-size:44px;letter-spacing:-.03em;margin:0 0 8px}h2{font-size:22px;margin:32px 0 10px}
p{line-height:1.6;color:#334}.eyebrow{font-size:12px;letter-spacing:.12em;color:#1f4fff;font-weight:700;text-transform:uppercase}
table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:10px 12px;border-bottom:1px solid #e6eaf1;text-align:left}th{background:#f5f7fb;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{padding:18px;border:1px solid #e6eaf1;border-radius:10px}
.num{font-size:34px;font-weight:700;letter-spacing:-.03em}.muted{color:#667;font-size:13px}
</style>${extraHead}</head><body><div class="wrap">${body}</div></body></html>`;

const sleepReport = page(
  "Как устроен сон",
  `<span class="eyebrow">Большой разбор</span><h1>Как устроен сон</h1>
<p>От ритмов мозга к привычкам восстановления. За ночь мозг проходит четыре–пять циклов по 90 минут; глубокий сон преобладает в первой половине ночи, быстрый — ближе к утру.</p>
<svg viewBox="0 0 900 220" width="100%" role="img" aria-label="Циклы сна">
<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1f4fff" stop-opacity=".9"/><stop offset="1" stop-color="#b48cff" stop-opacity=".2"/></linearGradient></defs>
<path d="M0 160 C80 40 140 200 220 120 S360 40 450 110 S600 200 700 100 S840 60 900 130 L900 220 L0 220Z" fill="url(#g)"/>
<path d="M0 180 C120 90 160 210 260 150 S420 70 520 140 S680 210 780 130 S860 90 900 150" fill="none" stroke="#1f4fff" stroke-width="2"/>
<g font-size="12" fill="#667">${[1, 2, 3, 4, 5].map((n) => `<text x="${n * 170 - 120}" y="212">Цикл ${n}</text>`).join("")}</g>
</svg>
<div class="grid"><div class="card"><div class="num">90 мин</div><div class="muted">один цикл сна</div></div><div class="card"><div class="num">4–5</div><div class="muted">циклов за ночь</div></div><div class="card"><div class="num">25%</div><div class="muted">доля быстрого сна</div></div></div>
<h2>Ритмы сна</h2><p>Во время сна мозг проходит через несколько повторяющихся стадий. Они сменяют друг друга в определённом порядке, формируя циклы.</p>
<svg viewBox="0 0 900 160" width="100%" role="img" aria-label="Стадии сна">
${["Бодрствование", "Быстрый сон", "Лёгкий сон", "Глубокий сон"].map((s, i) => `<text x="0" y="${28 + i * 36}" font-size="12" fill="#667">${s}</text>`).join("")}
${[0, 3, 2, 3, 1, 2, 3, 2, 1, 2, 3, 1, 2, 1, 0].map((lvl, i) => `<rect x="${140 + i * 50}" y="${14 + lvl * 36}" width="46" height="20" rx="4" fill="${["#c9d2e0", "#b48cff", "#8fb3ff", "#1f4fff"][lvl]}"/>`).join("")}
</svg>
<h2>Что влияет на сон</h2><p>Образ жизни, окружение и привычки, которые помогают лучше спать: свет утром, прохлада вечером, постоянное время подъёма.</p>`,
);

const sleepReportV2 = sleepReport.replace(
  "<h2>Что влияет на сон</h2>",
  "<h2>Выводы</h2><p>Стабильное время подъёма важнее общего числа часов.</p><h2>Что влияет на сон</h2>",
);

const calculator = page(
  "Бюджет поездки",
  `<span class="eyebrow">Калькулятор</span><h1>Бюджет поездки</h1>
<p>Стамбул, 7 дней. Измените числа — итог пересчитается. В сохранённом просмотре скрипты отключены, поэтому здесь показан зафиксированный расчёт.</p>
<table><tr><th>Статья</th><th>В день, ₽</th><th>Дней</th><th>Итого</th></tr>
<tr><td>Жильё</td><td><input value="4700"></td><td>7</td><td>32 900 ₽</td></tr>
<tr><td>Еда</td><td><input value="2900"></td><td>7</td><td>20 300 ₽</td></tr>
<tr><td>Транспорт</td><td><input value="1900"></td><td>7</td><td>13 300 ₽</td></tr>
<tr><td>Развлечения</td><td><input value="1500"></td><td>7</td><td>10 500 ₽</td></tr>
<tr><th colspan="3">Всего</th><th id="total">86 400 ₽</th></tr></table>
<p class="muted">Курсы и цены на май 2026 года. Расчёт ориентировочный; итог зависит от сезона.</p>
<script>document.querySelectorAll("input").forEach(i=>i.addEventListener("input",()=>{let t=0;document.querySelectorAll("tr").forEach(r=>{const v=r.querySelector("input");if(v)t+=(+v.value||0)*7});document.getElementById("total").textContent=t.toLocaleString("ru-RU")+" ₽"}))</script>`,
  "<style>input{width:90px;padding:6px 8px;border:1px solid #cfd6e2;border-radius:6px;font:inherit}</style>",
);

const weekPlan = page(
  "План на неделю",
  `<span class="eyebrow">Больше, чем планы</span><h1>План на неделю</h1><p>Небольшие шаги к большим переменам.</p>
${[
  ["Пн", ["Спорт", "Рабочие задачи"]],
  ["Вт", ["Встреча с командой", "Английский"]],
  ["Ср", ["Прочитать главу", "Разобрать почту"]],
  ["Чт", ["Планирование"]],
  ["Пт", ["Итоги недели", "Обновить портфолио"]],
]
  .map(
    ([d, items]) =>
      `<h2 style="margin-top:22px">${d}</h2><ul style="list-style:none;padding:0;margin:0">${(items as string[]).map((i) => `<li style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #eef1f5"><span style="width:18px;height:18px;border:2px solid #1f4fff;border-radius:5px;display:inline-block"></span>${i}</li>`).join("")}</ul>`,
  )
  .join("")}`,
);

const comparison = page(
  "Сравнение подрядчиков",
  `<span class="eyebrow">Записка для решения</span><h1>Варианты решения</h1><p>Сравнение, риски и рекомендация по трём подрядчикам для редизайна сайта.</p>
<table><tr><th>Критерий</th><th style="color:#1f4fff">Вариант A</th><th>Вариант B</th><th>Вариант C</th></tr>
<tr><td>Соответствие цели</td><td>Высокое</td><td>Среднее</td><td>Среднее</td></tr>
<tr><td>Срок реализации</td><td>Средний</td><td>Быстрый</td><td>Длинный</td></tr>
<tr><td>Ресурсы</td><td>Умеренные</td><td>Небольшие</td><td>Высокие</td></tr>
<tr><td>Риски</td><td>Низкие</td><td>Средние</td><td>Высокие</td></tr>
<tr><th>Итоговая оценка</th><th style="color:#1f4fff">Рекомендуем</th><th>Возможно</th><th>Не рекомендуем</th></tr></table>
<h2>Рекомендация</h2><p>Вариант A закрывает цель с наименьшим риском. Уточнить стоимость поддержки на втором году.</p>`,
);

const teamReport = page(
  "Отчёт команды за квартал",
  `<span class="eyebrow">Отчёт команды · Q3</span><h1>Ключевые результаты и следующие шаги</h1>
<p>Собрал агент по итогам квартала: данные, графики и выводы.</p>
<svg viewBox="0 0 600 220" width="100%" role="img" aria-label="Выпуски по месяцам">
${[70, 110, 95, 150, 130, 190].map((h, i) => `<rect x="${40 + i * 90}" y="${200 - h}" width="56" height="${h}" rx="6" fill="${i === 5 ? "#1f4fff" : "#b9c9ff"}"/><text x="${68 + i * 90}" y="216" font-size="12" text-anchor="middle" fill="#667">${["Апр", "Май", "Июн", "Июл", "Авг", "Сен"][i]}</text>`).join("")}
</svg>
<h2>Главные выводы</h2><ul><li>Продолжаем в выбранном направлении.</li><li>Есть новые возможности для роста.</li><li>Фокус на ключевых инициативах.</li></ul>`,
);

const noteOne = `Меньше пересылок. Больше контекста.

Пример материала для своей полки

Хорошая работа не должна оставаться в истории чата. Её можно сохранить, отправить коллеге и обновить, когда идея станет точнее.

Что важно

Один понятный адрес. История решений. Свобода выбрать своего агента.

Полка — место, куда хочется вернуться.`;

const noteTwo = `Заметки со встречи 18 сентября

Обсуждали запуск пилота и что показать первым пользователям.

Решили: показываем личную полку и ссылку получателя. Публичная витрина — после проверки материалов.

Открытые вопросы: кто отвечает за модерацию, как считать лимиты, нужен ли экспорт в PDF в первой версии.

Следующий шаг: собрать демо-полку и прогнать сценарий «сохранил → отправил → обновил версию».`;

const { password, created } = await credentials();
const app = await createApp();
const origin = config.APP_ORIGIN;
const remoteAddress = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
let cookie = "";
async function call(method: string, url: string, body?: unknown) {
  const response = await app.inject({
    remoteAddress,
    method: method as "GET",
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body as never,
  });
  if (response.statusCode >= 400)
    throw new Error(`${method} ${url} → ${response.statusCode} ${response.body}`);
  return response;
}
type Saved = { artifactId: string; revisionId: string; number: number };
async function save(
  title: string,
  filename: string,
  mime: string,
  bytes: Buffer,
  extra: Record<string, unknown> = {},
): Promise<Saved> {
  const begin = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title,
    filename,
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
    ...extra,
  });
  const { uploadId, receipt } = begin.json();
  if (receipt) return receipt;
  await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes);
  return (await call("POST", `/api/uploads/${uploadId}/finalize`, {})).json();
}

try {
  const login = await call("POST", "/api/login", { name: NAME, password });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const existing = (await call("GET", "/api/artifacts?q=")).json() as {
    items: { id: string; title: string; revision: { id: string }; share: unknown }[];
  };
  const byTitle = (title: string) => existing.items.find((a) => a.title === title);
  const folders = (await call("GET", "/api/folders")).json() as {
    id: string;
    name: string;
  }[];
  const folder = async (name: string) =>
    folders.find((f) => f.name === name) ??
    ((await call("POST", "/api/folders", { name })).json() as { id: string });
  const research = await folder("Исследования");
  const team = await folder("Команда");
  // Idempotent: every step checks the shelf first, so a partial run can be resumed.
  const ensure = async (
    title: string,
    filename: string,
    mime: string,
    bytes: Buffer,
    extra: Record<string, unknown> = {},
  ) => {
    const found = byTitle(title);
    if (found) return { artifactId: found.id, revisionId: found.revision.id, number: 0 };
    return save(title, filename, mime, bytes, extra);
  };
  {
    const sleep = await ensure(
      "Как устроен сон",
      "sleep-report.html",
      "text/html",
      Buffer.from(sleepReport),
      { folderId: research.id },
    );
    // Link first, then a newer version: the shelf shows v2 while the link still opens v1.
    if (!byTitle("Как устроен сон")?.share)
      await call("POST", `/api/artifacts/${sleep.artifactId}/share`, {
        expectedRevisionId: sleep.revisionId,
        expiresInDays: 7,
      });
    if (sleep.number === 1)
      await save(
        "Как устроен сон",
        "sleep-report-v2.html",
        "text/html",
        Buffer.from(sleepReportV2),
        { artifactId: sleep.artifactId, baseRevisionId: sleep.revisionId },
      );
    await ensure("Бюджет поездки", "trip-budget.html", "text/html", Buffer.from(calculator));
    await ensure("План на неделю", "week-plan.html", "text/html", Buffer.from(weekPlan), {
      folderId: team.id,
    });
    await ensure(
      "Варианты решения",
      "comparison.html",
      "text/html",
      Buffer.from(comparison),
      { folderId: team.id },
    );
    await ensure(
      "Обложка для рассылки",
      "newsletter-cover.png",
      "image/png",
      gradientPng(960, 600),
    );
    await ensure(
      "Город в деталях",
      "city-observation.jpg",
      "image/jpeg",
      await readFile("apps/web/public/editorial-covers/city-observation.jpg"),
      { folderId: research.id },
    );
    await ensure(
      "Меньше пересылок. Больше контекста.",
      "note.txt",
      "text/plain",
      Buffer.from(noteOne),
    );
    await ensure(
      "Заметки со встречи 18 сентября",
      "meeting-notes.txt",
      "text/plain",
      Buffer.from(noteTwo),
      { folderId: team.id },
    );

    // Single-file capture through the agent path (MCP token, capture scope).
    if (!byTitle("Отчёт команды за квартал")) {
    const csrf = (await call("POST", "/api/agent-connections/csrf", {})).json();
    const issued = await app.inject({
      remoteAddress,
      method: "POST",
      url: "/api/agent-connections",
      headers: { origin, cookie, "x-polka-csrf": csrf.csrfToken },
      payload: {
        name: "Claude Code (демо)",
        scopes: ["context", "capture"],
        audience: MCP_AUDIENCE,
        ttlDays: 30,
      },
    });
    if (issued.statusCode >= 400) throw new Error(issued.body);
    const actor = await authenticateServiceToken(
      issued.json().token,
      MCP_AUDIENCE,
      "capture",
    );
    const html = Buffer.from(teamReport);
    await captureFromAgent(
      actor,
      {
        key: randomUUID(),
        title: "Отчёт команды за квартал",
        folderId: team.id,
        manifest: {
          version: 1,
          entrypoint: "index.html",
          runtime: "static-sandbox-v1",
          files: [
            {
              path: "index.html",
              mime: "text/html",
              size: html.length,
              sha256: sha256(html),
            },
          ],
          provenance: {
            kind: "mcp",
            sourceUrl: null,
            capturedAt: new Date().toISOString(),
            attribution: "Собрано агентом для владельца полки",
            license: "unknown",
          },
          dependencies: { status: "self-contained", unresolved: [] },
        },
        files: [{ path: "index.html", encoding: "utf8", data: teamReport }],
      },
      "capture",
    );
    }
    console.log(
      `Seeded ${NAME}: 9 materials, 2 folders, 1 active link, 1 agent capture. ${created ? "New credentials" : "Credentials"}: ${CREDENTIALS}`,
    );
  }
} finally {
  await app.close();
  await db.end();
  s3.destroy();
}
