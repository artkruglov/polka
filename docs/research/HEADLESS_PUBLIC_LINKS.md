# Серверный headless-рендер публичных ссылок AI-продуктов

> **Статус:** исследование, 24.09.2026. Продуктовый код не менялся.

Вопрос: может ли сервер открыть в обычном headless Chromium публичную ссылку на результат AI-чата и достать содержимое (HTML/код/текст) без входа в аккаунт?

**Короткий ответ:** для Claude и Perplexity нет: headless упирается в Cloudflare. ChatGPT технически открывается, но это запрещают его Terms. Gemini share, публичные чаты v0 и задеплоенные сайты (Lovable, bolt.host, Replit, GitHub Pages) рендерятся. Для Claude и ChatGPT остаётся расширение «На Полку».

## Метод

- Каждую ссылку открыли три раза, по одной попытке без повторов: (1) Node `fetch`, для Gemini `curl`; (2) Playwright 1.63, `chromium-headless-shell` 153 с UA по умолчанию (`HeadlessChrome/153…`); (3) Playwright с установленным Chrome (`channel: 'chrome'`, headed, UA `Chrome/153`). Каждый раз новый контекст без cookies. Stealth, прокси, решения CAPTCHA не было.
- IP теста — Нидерланды, AS215439 PLAY2GO International (хостинг/VPN, не домашний провайдер). **IP Yandex Cloud не проверялся.**
- Сценарий: `goto` до `domcontentloaded`, затем `networkidle` (до 20 с) и ещё 3 с. Потом снимали HTML/текст всех фреймов (включая cross-origin через Playwright), скриншот и список XHR/fetch/JSON. В таблице «DOM» — время до `domcontentloaded`, «готово» — время до конца ожидания, с учётом 3 с.
- Реальные ссылки нашли через поиск по GitHub issues. Скрипт и сырые результаты лежали во временной папке и в репозиторий не попали.
- Ссылки с `Disallow` в robots.txt не открывались: `claude.site/*`, `aistudio.google.com/apps/*`, `bolt.new/~/*`.

## Результаты по провайдерам

| Ссылка (проверено) | Без логина | fetch | headless | headed Chrome | Где контент | Как извлечь | Время DOM / готово |
|---|---|---|---|---|---|---|---|
| Claude `claude.ai/public/artifacts/<uuid>` (2 шт.) | да (в браузере) | 200, оболочка SPA без данных | **blocked**: `edge-api/bootstrap` и `/api/published_artifacts/<uuid>` → 403, затем страница Turnstile «Just a moment…» | 1 из 2 **blocked** (Turnstile), 1 из 2 отрисовался | iframe `www.claudeusercontent.com/artifact/<uuid>` → вложенный `srcdoc`-iframe с HTML артефакта; JSON `claude.ai/api/published_artifacts/<uuid>` и `/meta` | снимок `srcdoc`-фрейма (63 КБ HTML) или JSON API. Сервером неприменимо | 2,4 / 25 с (challenge); headed 3,0 / 9,7 с |
| Claude `claude.ai/share/<uuid>` | да | 200, оболочка | **blocked**: `/api/chat_snapshots/<uuid>` → 403, пустая страница, `goto` timeout 30 с | отрисовался | JSON `claude.ai/api/chat_snapshots/<uuid>` → DOM | JSON/DOM, только в браузере пользователя | headed 2,9 / 7,8 с |
| Claude `claude.site/artifacts/…` | — | не открывали | не открывали | не открывали | — | robots: `User-Agent: * Disallow: /` | — |
| ChatGPT `chatgpt.com/share/<uuid>` | да | **200, текст диалога уже в HTML** (SSR-данные React Router) | отрисовался; `backend-anon/*` → 403 (не мешает) | отрисовался | DOM главной страницы; данные встроены в HTML | DOM или разбор встроенных данных | 1,5 / 8,6 с; fetch 1,1 с |
| ChatGPT `chatgpt.com/canvas/shared/<id>` (текстовый canvas) | да | 200, текст canvas в HTML | отрисовался | отрисовался | DOM главной страницы (SSR) | DOM | 1,1 / 7,2 с; fetch 0,8 с |
| Gemini `g.co/gemini/share/<id>` → `gemini.google.com/share/<id>` (2 шт.) | да | 200 (`curl`), 830 КБ, **текста ответа нет**; Node `fetch` падает с `UND_ERR_HEADERS_OVERFLOW` | отрисовался (20–24 тыс. символов текста); поверх баннер согласия с cookies Google | отрисовался | XHR `gemini.google.com/_/BardChatUi/data/batchexecute` → DOM главной страницы | снимок DOM (batchexecute — внутренний RPC) | 0,6–1,5 / 6,8–8,9 с |
| Gemini Canvas-приложение в share | — | — | — | — | — | живого примера с Canvas-приложением не нашли, **не проверено** | — |
| v0 `v0.app/chat/<slug>` публичный | да | 200, «Loading chat…» | отрисовался | — | cross-origin iframe `preview-<slug>.vusercontent.net` (собранное приложение); исходники — JSON `v0.app/chat/api/blocks/source` | исходники из JSON или снимок iframe | готово за 11,2 с |
| v0 `v0.app/chat/<slug>` приватный | **нет** | 200 | редирект на `vercel.com/login/v0` | то же | — | — | — |
| Lovable `*.lovable.app` | да | 200, оболочка SPA 5 КБ | отрисовался (11 тыс. символов) | отрисовался | DOM главной страницы + сторонние iframe | снимок DOM (это runtime, не исходники) | 1,7 / 13,7 с |
| Replit `*.replit.app` | да | 200 | отрисовался, но приложение само ушло на `/auth` | то же | DOM | снимок DOM; за логином приложения ничего нет | 1,4 / 5,9 с |
| bolt `*.bolt.host` | да | 200, оболочка 802 байта | отрисовался | отрисовался | DOM (SPA на Vite) | снимок DOM | 2,3 / 6,2 с |
| bolt `bolt.new/~/…` | — | не открывали | — | — | — | robots: `Disallow: /~` | — |
| Perplexity `perplexity.ai/page/<slug>` | да (в обычном браузере) | **blocked**: 403, `cf-mitigated: challenge` | **blocked** (Turnstile) | **blocked** (Turnstile, редирект на `/`) | — | — | — |
| Google AI Studio `aistudio.google.com/apps/<uuid>` | — | не открывали | — | — | — | robots: `Disallow: /apps` | — |
| Gist `gist.github.com/<user>/<id>` | да | 200, код в HTML | отрисовался | отрисовался | DOM; официальный API `api.github.com/gists/<id>` | API (JSON с исходниками файлов) | 1,5 / 5,7 с; fetch 0,8 с |
| gistpreview `gistpreview.github.io/?<id>/<file>` (GitHub Pages) | да | 200, оболочка «Loading…» | отрисовался | отрисовался | JS страницы берёт `api.github.com/gists/<id>` и вставляет HTML в DOM | тот же API, браузер не нужен | 1,6 / 7,3 с |

Headed Chrome почти ничего не меняет: у одной ссылки Claude и у Claude share прошла проверка Cloudflare, у второй ссылки Claude и у Perplexity — нет. Для сервера это не решение: обычный Chrome на VM с дисплеем уже близок к обходу защиты, и Terms это не разрешают.

## robots.txt и Terms

| Сайт | robots.txt для проверенных путей | Terms об автоматическом доступе |
|---|---|---|
| claude.ai | `/public/artifacts`, `/share` разрешены для `*`; `Disallow: /api/*` (данные артефакта лежат именно там). GPTBot, Google-Extended и др. — `Disallow: /` | [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), §3: нельзя «access the Services through automated or non-human means, whether through a bot, script, or otherwise» без API-ключа; нельзя «crawl, scrape, or otherwise harvest data» |
| claude.site | `User-Agent: * Disallow: /` | те же |
| chatgpt.com | `Allow: /share/`, `Allow: /canvas/shared/` для `*` | [Terms of Use](https://openai.com/policies/row-terms-of-use/): нельзя «automatically or programmatically extract data or Output» |
| gemini.google.com | `Disallow: /app/`, `/chat/`; `/share/` не запрещён | [Google ToS](https://policies.google.com/terms): запрещён «automated means to access content… in violation of the machine-readable instructions (robots.txt…)», то есть для `/share/` формально не запрещено |
| aistudio.google.com | `Disallow: /apps` | Google ToS: по robots — нельзя |
| v0.app | правил нет | [Vercel AUP](https://vercel.com/legal/acceptable-use-policy): запрещено использовать автоматизацию, чтобы извлекать данные с сайта Vercel |
| perplexity.ai | `/page/` не запрещён | [ToS](https://www.perplexity.ai/hub/legal/terms-of-service): запрещены «robot, spider, crawlers, scraper… to extract, copy or collect» |
| bolt.new | `Disallow: /~` | — |
| *.lovable.app, *.bolt.host, *.replit.app | зависит от автора сайта; в примерах корень не запрещён (у Replit и bolt.host robots.txt нет) | контент принадлежит автору сайта, а не платформе |
| gist.github.com | `/raw/` запрещён, страница gist разрешена | [GitHub AUP](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies): scraping ограничен, есть официальный API (60 запросов/ч без токена) |

## fetch против headless

- Хватает простого `fetch`: ChatGPT share и canvas (текст уже в HTML), Gist.
- Нужен JS: Gemini (данные приходят через batchexecute), v0, все SPA-хостинги (Lovable, bolt.host, Replit). Их HTML — пустая оболочка.
- Headless не помогает: Claude, Perplexity. `fetch` получает оболочку или 403 challenge, headless — Turnstile или 403 на API.
- Headless в 5–10 раз медленнее: 6–14 с против ~1 с, плюс сотни МБ RAM на страницу.

## Сервер на Yandex Cloud VM

- **Не проверено с IP Yandex Cloud.** Тест шёл с хостингового IP в Нидерландах: это не домашний IP, но и не российский ЦОД.
- Для российского IP вероятна геоблокировка отдельно от защиты от ботов. Россия не входит в списки поддерживаемых стран у OpenAI, Anthropic и Gemini. Проверять нужно одним запросом к каждому провайдеру с самой VM.
- IP ЦОД чаще получает challenge от Cloudflare. Вердикт «blocked» для Claude и Perplexity на VM почти наверняка не улучшится.
- Для не-провайдерских хостингов (Lovable, bolt.host, Replit, GitHub) IP ЦОД обычно не проблема. Скорее помешает сетевая доступность этих сайтов из РФ, это тоже нужно проверить.

## Рекомендация

| Провайдер / ссылка | Вердикт |
|---|---|
| Claude `public/artifacts`, `share`, `claude.site` | **нужно расширение** (сервер: blocked + Terms + robots) |
| ChatGPT `share`, `canvas/shared` | **нужно расширение**: технически сервер может даже без браузера, но Terms прямо запрещают |
| Gemini `share` | **сервер может**: headless обязателен, robots не запрещает. Под вопросом доступ из РФ и устойчивость к изменениям вёрстки |
| Gemini Canvas-приложения, AI Studio apps | **не проверено / нельзя сервером** (robots `/apps`) → расширение |
| v0 публичный чат | **нужно расширение**: технически сервер может, но это запрещает Vercel AUP. Приватный — невозможно |
| Perplexity pages | **нужно расширение** (blocked) |
| *.lovable.app, *.bolt.host, *.replit.app, GitHub Pages | **сервер может** (headless, снимок DOM). Получаем runtime-снимок, а не исходники |
| Gist | **сервер может без браузера**: официальный API |

### Риски

- **SSRF и песочница.** Chromium сам ходит по редиректам, подресурсам, WebSocket и WebRTC, поэтому проверки `fetchPublic` недостаточно. Рендерер нужен в отдельном контейнере без доступа во внутреннюю сеть. Весь egress идёт через прокси, который на каждое соединение повторяет `publicAddress` с закреплённым DNS: запрет RFC1918, `169.254.169.254` (metadata Yandex Cloud), IPv6 ULA/link-local. Кроме того, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, без `--no-sandbox`, non-root, read-only FS. Ограничения cgroup: ~1,5 ГБ RAM, pids, CPU. 1–2 страницы одновременно, timeout 30 с. Загрузки и permission-запросы отключены, после каждой задачи контекст и профиль уничтожаются.
- **Юридические.** Anthropic, OpenAI, Vercel и Perplexity прямо запрещают автоматический доступ и извлечение, Google — в части путей, закрытых в robots.txt. Серверный рендер для них — нарушение Terms от имени «Полки», а не пользователя. Расширение работает в браузере пользователя по его явному действию. С хостингами пользовательских сайтов риск ниже, но права на контент принадлежат его автору (сейчас в provenance `license: 'unknown'`).
- **Хрупкость.** Внутренние пути (`batchexecute`, `blocks/source`, SSR-формат ChatGPT) не документированы и меняются без предупреждения. Cloudflare меняет правила. Баннеры согласия (Gemini в ЕС/NL) закрывают контент на скриншоте, в DOM он есть. Снимок DOM SPA — это состояние после рендера, не рабочее приложение: интерактив часто теряется.

## Дизайн: «серверный рендерер публичных ссылок» поверх URL-импорта

**Что уже есть:**

- `apps/server/url-import/public-fetch.ts` — HTTPS-only fetch с проверкой публичного адреса и закреплением DNS на каждом редиректе.
- `html-capture.ts` — разбор HTML без выполнения JS, локализация CSS/картинок/скриптов, лимиты 5 МиБ / 64 файла / 45 с, `provider_adapter_required` для `claude.ai` и `chatgpt.com`.
- `jobs.ts` + `worker.ts` — очередь с lease, идемпотентным receipt и восстановлением.
- `routes.ts` — `/api/imports`, capabilities `sources:['standalone-html'], providerArtifacts:false`.
- В вебе `apps/web/src/features/import-url/classify-link.ts` распознаёт ссылки Claude/ChatGPT и передаёт их расширению (`extension-save.tsx`).
- Проверки: `scripts/test-url-import-runtime.ts` (DB/S3/MCP), `docs/specs/URL_IMPORT_SUPPORT.md`.

**Что добавить:**

1. **Allowlist адаптеров** (сервер) вместо «любой URL в браузер». Первая версия: `*.lovable.app`, `*.bolt.host`, `*.replit.app`, `*.github.io`; Gemini `share` — отдельным решением после проверки из РФ; Gist — через API без браузера. Claude, ChatGPT, v0, Perplexity, AI Studio остаются `provider_adapter_required` → расширение.
2. **Проверка robots.txt** перед рендером (кэш на хост), с честным UA `…PolkaRenderer/1.0 (+https://polochka.app/bot)`. `Disallow` → ошибка `robots_disallowed`.
3. **Сервис `renderer`** — отдельный контейнер в `deploy/compose.base.yml` с Playwright и Chromium. У него нет сети до Postgres и S3, есть только egress-прокси (см. «Риски»). Внутренний API — одна операция `render(url) → {finalUrl, frames:[{url, html}], resources}` с жёстким timeout. Worker вызывает его вместо `fetchPublic` для главного документа.
4. **Детектор challenge.** Title «Just a moment», `cf-mitigated`, фрейм `challenges.cloudflare.com` → код `source_blocked`, без повторов. В UI — совет использовать расширение.
5. **Снимок → bundle.** Сериализованный DOM после рендера (скрипты убрать или оставить с предупреждением) передаётся в существующий `captureHtmlUrl`-путь локализации ресурсов через `fetchPublic`. Provenance `kind:'url', renderer:'headless-snapshot-v1'`. Предупреждение «снимок состояния, интерактив может не работать».
6. **Job и capabilities.** Новое состояние `rendering`, флаг `RENDERED_IMPORT_ENABLED`, `sources:['standalone-html','rendered-spa']`. В `classify-link.ts` добавить распознавание этих хостов.
7. **Тесты.** Unit-тесты детектора challenge и allowlist. Runtime-тест с локальным SPA-фикстурой в изолированном renderer. Проверка egress: renderer не достаёт `169.254.169.254` и адреса docker-сети.

Ориентир по ресурсам: ~300–500 МБ RAM на активную страницу, 6–14 с на ссылку.
