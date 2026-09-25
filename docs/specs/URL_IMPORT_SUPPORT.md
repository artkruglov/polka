# Поддержка импорта по ссылке

> **Экспериментально, в веб-интерфейсе выключено (25.09.2026).** Решение владельца: сохранение по ссылке на артефакт Claude/ChatGPT работает ненадёжно (Claude за Cloudflare, серверная загрузка на polochka.app выключена), поэтому единственный путь для пользователя — подключённый агент (коннектор в Claude, плагин в Claude Code и Codex, любой MCP-клиент; [connect-agents](../connect-agents.md#быстрый-старт-один-раз-на-человека)) и, вторым способом, загрузка файла. Из интерфейса убраны поле ссылки на полке, карточка ссылки на странице «Сохранить» (`features/import-url`) и подсказки про расширение и закладку; `/bookmarklet` и `/bring/receive` открываются только по прямому адресу. Сервер (`apps/server/url-import`, `POST /api/imports`), рендерер и инструменты MCP `polka_import_url` и `polka_save_link` не менялись — всё ниже описывает их. Упоминания карточки и «Сохранять в один клик» ниже — история.
>
> **Статус реализации:** реализовано, выключено по умолчанию (`URL_IMPORT_ENABLED`). Рендерер и ссылки AI-сервисов — отдельный флаг `RENDERED_IMPORT_ENABLED` (выключен). На 24.09.2026: Gist через API, общие ссылки ChatGPT через `/fetch` рендерера, SPA-сайты и Gemini share — снимком, одна попытка для артефакта Claude, «Сохранить как ссылку» ([SAVED_LINKS](SAVED_LINKS.md)) для всего остального.

## Таблица источников

Маршрут каждой ссылки задаёт одна таблица: [packages/contracts/link-providers.ts](../../packages/contracts/link-providers.ts). Её читают сервер, веб и рендерер. Почему выбран такой маршрут, разобрано в [исследовании](../research/HEADLESS_PUBLIC_LINKS.md).

| Ссылка | Маршрут | Что делает Полка |
|---|---|---|
| `gist.github.com/<user>/<id>`, `gistpreview.github.io/?<id>/…` | `server-api` | Читает `api.github.com/gists/<id>` через `fetchPublic`. HTML-файл становится страницей, CSS/JS того же gist берутся из ответа API. Gist без HTML — статичная страница с файлами как кодом. Лимит GitHub (403 с `x-ratelimit-remaining: 0` или 429) → `rate_limited`, без повтора. `GITHUB_TOKEN` необязателен, заголовок `Authorization` уходит только на api.github.com |
| `chatgpt.com/share/<id>`, `chatgpt.com/canvas/shared/<id>` | `server-fetch` | Рендерер делает один GET без браузера (`POST /fetch`). robots.txt явно разрешает `/share/` и `/canvas/shared/`. Разговор лежит в данных React Router (turbo-stream в `streamController.enqueue`). Canvas становится страницей, компонентом или кодом. HTML/React/SVG из последнего ответа становится работой (те же правила, что у расширения: [packages/artifact-source.ts](../../packages/artifact-source.ts)). Иначе сохраняется сам разговор текстом. Сервер Полки к chatgpt.com не обращается |
| `claude.ai/artifact/<id>`, `claude.ai/public/artifacts/<id>` | `server-try` | Одна попытка в браузере рендерера. Если отрисовался фрейм `*.claudeusercontent.com`, сохраняется его снимок. Проверка Cloudflare → `source_blocked`, без повтора. С IP дата-центров проверка почти всегда, и карточка предлагает остальные способы |
| `*.lovable.app`, `*.bolt.host`, `*.replit.app`, `*.github.io`, `gemini.google.com/share/…`, `g.co/gemini/share/…` | `server-render` | Снимок DOM из браузера рендерера. Баннер согласия Google не нажимается: берётся DOM под ним, а если контента нет — `source_blocked`. Без рендерера SPA-хосты скачиваются как обычный HTML, Gemini → `renderer_disabled` |
| `claude.ai/share/…`, `*.claude.site`, `v0.app`, `perplexity.ai`, `aistudio.google.com` | `extension` | Сервер не открывает: robots.txt закрывает путь (claude.site, AI Studio `/apps`), страница за входом или за проверкой на бота. Карточка: агент, «Сохранить как ссылку», файл |
| Любая другая публичная HTTPS-страница | `html` | Скачивается без выполнения JS (ниже) |

Карточка для ссылки, которую сервер не взял (сразу для `extension` или после отказа для `server-fetch`/`server-try`), предлагает способы по порядку: «Попросить Claude» (фраза «Сохрани этот артефакт на Полку» для чата Claude с коннектором) или фразу для своего агента, «Сохранить как ссылку», файл прямо в карточке («Скачайте в Claude (Export → Download) и перетащите сюда»). Расширение спрятано за ссылкой «Сохранять в один клик». Там же оставлено место для букмарклета.

## Рендерер

Отдельный сервис [apps/renderer](../../apps/renderer) на официальном образе Playwright (закреплён по digest). Развёртывание описано в [deploy/renderer/README.md](../../deploy/renderer/README.md): тот же compose (`--profile renderer`), Yandex Cloud или Fly.io.

- API: `POST /render {url}` → `{finalUrl,title,html,frames}` и `POST /fetch {url}` → `{finalUrl,status,html}` или `{error}`. Коды ошибок: `source_blocked`, `robots_disallowed`, `robots_unavailable`, `timeout`, `not_allowed`, `navigation_failed`, `too_large`, `busy`.
- Каждый запрос подписан HMAC-SHA256 от `RENDERER_SECRET` по времени, методу, пути и SHA-256 тела. Допустимое расхождение часов — 60 с. `RENDERER_URL` — только https, кроме loopback и адресов Docker (172.16.0.0/12 или имя сервиса).
- robots.txt для `PolkaRenderer` (иначе `*`) рендерер читает сам, с той машины, которая делает запрос (RFC 9309, кэш на хост 1 час, недоступный robots.txt = запрет). UA: `PolkaRenderer/1.0 (+https://polochka.app/bot)`. Описание для владельцев сайтов — страница [/bot](../legal/bot.md).
- Egress: Chromium и `/fetch` ходят только через прокси в том же контейнере. Прокси пропускает только `CONNECT` на порт 443, резолвит DNS один раз и закрепляет адрес, отказывает, если хотя бы один адрес непубличный: loopback, RFC 1918, Docker, `169.254.169.254`, IPv6 ULA и link-local ([packages/public-address.ts](../../packages/public-address.ts) — то же правило, что у `fetchPublic`).
- В браузере выключены WebSocket, WebRTC, WebTransport, service workers, загрузки файлов и разрешения. Одна страница за раз, очередь из трёх, таймаут 25 с, новый контекст на каждый запрос. Sandbox Chromium включён, пользователь `pwuser`, корневая ФС только для чтения, `cap_drop: ALL`.
- Детектор проверок: title «Just a moment», `cf-mitigated: challenge`, фрейм `challenges.cloudflare.com`, captcha без контента, `consent.google.com` или баннер согласия без контента → `source_blocked`.

**Снимок → работа.** DOM без `<script>`, `<noscript>`, обработчиков `on*` и `javascript:` проходит обычную локализацию `captureHtmlDocument`: CSS, картинки и шрифты скачиваются через `fetchPublic`. Получается пакет с provenance `renderer: 'headless-snapshot-v1'` и предупреждением «Снимок страницы на момент сохранения: интерактив может не работать». Задание проходит состояние `rendering` (миграция 037). Сохранение идёт тем же путём, что и любой импорт, поэтому содержимое читает фильтр ([CONTENT_FILTER](CONTENT_FILTER.md)); это покрыто тестом.

Проверки: `tests/renderer.test.ts` (детектор, подпись, решения egress, `/fetch`), `tests/url-import-rendered.test.ts`, `tests/url-import-chatgpt.test.ts`, `tests/url-import-gist.test.ts`, `tests/link-providers.test.ts`, `npm run test:renderer-runtime` (локальная SPA-фикстура через настоящий Chromium и прокси; egress внутри Docker-образа).

## Проверка на настоящих ссылках (24.09.2026)

Рендерер в Docker на машине разработчика с выходом через VPN в Нидерландах (похоже на Fly `ams`, но не то же самое). Ссылки найдены в issues на GitHub, по одному запросу на ссылку. Исключения: повтор Lovable после исправлений и два запроса к артефакту Claude (второй — ошибка в скрипте проверки).

| Ссылка | Результат |
|---|---|
| `habit-sparkle-699.lovable.app` | снимок одной статичной страницей, 335 КБ, 5–10 с; в просмотре выглядит как оригинал |
| `ontario-electrician-2cm6.bolt.host` | снимок, 7–8 с (на странице только заглушка bolt) |
| `erickks.github.io/vite-react-router/` | снимок, 5 с |
| `gemini.google.com/share/…` (4 ссылки, в том числе через `g.co`) | отрисовка без проверки на бота и без блокировки согласием, 9–21 с. Первые три ссылки упали на локализации (CSS `url()` с escape, шрифт Google отвечает HTML); после исправлений снимок сохранённого ответа проверен на сохранённом ответе рендерера: 2 МБ, 23 тыс. символов разговора, статичный просмотр |
| `chatgpt.com/share/6aad7fa7-…` | `/fetch` 3 с, разговор без кода сохранён текстовой страницей, 44 тыс. символов |
| `chatgpt.com/canvas/shared/68d0334d…` | `/fetch` 3,7 с, React-компонент (оболочка + `App.jsx`), сборка проходит |
| `chatgpt.com/canvas/shared/6a142546…` | удалён: 302 на `/?_tm=canvas_not_found` → `source_unavailable`; второй запрос — таймаут 15 с, без повтора |
| `gistpreview.github.io/?ff8c4f3d…/slope.html` | GitHub API, 5 файлов, 3 с; интерактивная сборка не принимает CSS `data:` URI → сохранено с ограничением |
| `claude.ai/public/artifacts/8cbaf36c-…` | **проверки Cloudflare не было** (с этого IP), страница отрисовалась за 6–8 с, но сохранился вспомогательный фрейм «Claude User Content», а не артефакт. Исправлено: ждём отрисовки фрейма `<uuid>.frame.claudeusercontent.com`, пустой фрейм → `source_blocked` и карточка. После исправления на настоящем артефакте не проверялось, чтобы не открывать ссылку третий раз |

С IP дата-центра (Yandex Cloud, Fly.io) Claude, по проверке 24.09.2026, показывает «Just a moment…»; на рабочем рендерере ожидается карточка.

## Скачивание HTML без браузера

Состояние исходного кода на 21 сентября 2026. Включение в конкретной установке подтверждается её capabilities. Рабочая установка 4390 обновлена до schema21, URL_IMPORT и local viewer включены; health и форма проверены. Полная итоговая приёмка ещё не закрыта.

Импорт сохраняет копию, а не закладку и не прокси исходного сайта. UI и MCP используют одну очередь и один сервис копирования. Копия приватна до отдельного включения доступа по ссылке.

| Источник / возможность | Результат | Доказательство |
|---|---|---|
| Автономный UTF-8 HTML с inline JS и DOM-действиями | Поддерживается в изолированном viewer | Реальный MDN random-color-addeventlistener.html: браузерный импорт, Change color; браузерная проверка 21.09.2026 |
| Обычные CSS, изображения, classic JS; относительные пути | Ресурсы скачиваются и становятся локальными | tests/url-import-html.test.ts; runtime test с БД/S3 и остановленным источником |
| CSS background, безопасный SVG, WOFF2 | Поддерживаемые локальные ресурсы встраиваются viewer-builder | tests/bundle-inline.test.ts; проверка MIME/сигнатур и лимитов, не обещание любого шрифта |
| fetch, XHR, WebSocket, EventSource, sendBeacon, динамическая загрузка JS | Копия с предупреждением; внешние запросы запрещены CSP | compatibility corpus в tests/url-import-html.test.ts; простая статическая диагностика, возможны ложные срабатывания и пропуски |
| JS modules/importmap/async/defer, CSS @import | Копия с ограничениями; интерактивная сборка не гарантируется | importer corpus и правила bundle-inline.ts |
| srcset; iframe/object/embed | Копия с предупреждением; зависимости не локализованы полностью | importer corpus; не считается полным переносом |
| Ссылки AI-сервисов (Claude, ChatGPT, Gemini, v0, Perplexity, AI Studio), включая redirect на них | Сервер Полки их не скачивает. Маршрут — по таблице выше: `/fetch` или браузер рендерера, либо карточка со способами со стороны пользователя | `tests/link-providers.test.ts`, `tests/url-import-html.test.ts` (redirect на провайдера → `provider_adapter_required`) |
| Не-HTML, повреждённый UTF-8, недоступный ресурс | Ошибка с причиной | importer corpus |
| Локальные/зарезервированные IP, metadata, непубличный DNS, HTTP | Отклоняется | tests/url-import-fetch.test.ts; проверка каждого redirect и закреплённого DNS-адреса |

Ограничения: суммарно 5 МиБ скачанных байтов, до 64 файлов с entrypoint, бюджет подготовки 45 секунд; один fetch имеет собственный timeout и ограничение redirect. Нет cookies пользователя и выполнения JS во время извлечения. Query и fragment исключаются из provenance; URL нужен worker во время выполнения и не должен попадать в журналы.

`ready` означает, что сохранение и сборка viewer завершились, а известные ограничения не обнаружены. Это не автоматическая функциональная приёмка произвольного JavaScript. Сетевые зависимости могут быть обфусцированы; статическая диагностика не заменяет CSP. Автору следует проверить интерактив до распространения ссылки.

Браузерная проверка восстановления: уход со страницы, reload и выход/вход возвращают тот же receipt. Браузером проверены управляемые HTTP503 с автоматическим восстановлением, HTTP403/404 с возвратом формы; реальный обрыв сети не имитировался, транспортный отказ проверяется unit-тестом polling. Облако, российская доступность без VPN и универсальный импорт провайдерских артефактов этим документом не заявляются.

## Повторная проверка актуального MCP-кода

Команда `node --env-file=.env --import tsx scripts/test-url-import-runtime.ts --restricted --public-source` прошла5/5 на отдельной schema21-базе с ограниченной runtime-ролью. MCP импортировал реальный MDN random-color-addeventlistener.html через HTTPS без подставного snapshot. Оригинал700байт и готовая производная viewer700байт прочитаны из S3; в обоих есть содержимое, в производной проверены addEventListener/backgroundColor. Повтор вернул тот же job/receipt. Чужое подключение не прочитало job. Временные DB/role и объекты очищены; рабочая база не изменена.

Это проверка HTTP downloader → MCP/worker → storage/производная. Наличие JS-кода не заменяет браузерный клик; браузерные доказательства перечислены выше, текущий полный проход UI→share→guest→revoke остаётся отдельным пунктом. Claude/ChatGPT поддержка этим результатом не расширяется.

Назначение импорта проверяется до постановки в очередь: чужой или отсутствующий folderId →404 без создания задания и без подстановки корня. Регрессия покрыта HTTP runtime-тестом под ограниченной DB-ролью. Пользователь может явно выбрать другую доступную папку или корень.
