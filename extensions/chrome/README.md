# Расширение «На Полку» для Chrome

[English below](#english)

Сохраняет артефакт Claude (или код из ChatGPT) из **вашего** браузера на **вашу** Полку и сразу выдаёт ссылку. Сервер Полки не может сам открыть ссылку `claude.ai/artifact/…`: она открывается только после входа, отвечает серверам защитной страницей Cloudflare, а сам артефакт живёт в изолированном фрейме на другом домене ([почему](../../docs/faq.md#почему-нельзя-вставить-ссылку-на-артефакт-claude-или-chatgpt), [эксперимент](../../docs/specs/CLAUDE_IMPORT_EXPERIMENT.md)). Ваш браузер, в котором вы уже вошли в Claude, — может. Расширение делает ровно это и ничего больше.

Статус: **0.1.0, не опубликовано в Chrome Web Store.** Устанавливается вручную (ниже). Chrome 116+, Edge и другие браузеры на Chromium.

## Как пользоваться

- **Кнопка на панели браузера.** Откройте артефакт в Claude (он виден справа от чата) → значок «На Полку» → «Сохранить на Полку». Появится ссылка с кнопками «Копировать» и «Открыть на полке».
- **Кнопка «На Полку» на странице.** На странице артефакта `claude.ai/artifact/…` — рядом с кнопкой Share в шапке, в чате — рядом с Copy панели артефакта, иначе в углу артефакта. То же действие в один клик. Выключается в настройках.
- **Ссылка в Полке.** Вставьте `https://claude.ai/artifact/…` в поле «Сохранить» на Полке и нажмите «Сохранить». Если расширение установлено, Полка передаст ему ссылку: оно откроет артефакт в фоновой вкладке, заберёт код, закроет вкладку и вернёт ссылку на странице Полки. Без расширения Полка покажет, как его установить, и прежний путь с файлом.

Первое сохранение попросит **подключить Полку**: откроется окно Полки со входом и экраном согласия «Расширение браузера «На Полку»». Разрешения: сведения и статус, сохранять новые работы, управлять ссылками (`context capture share`). Подключение видно и отзывается на странице «Агенты».

## Установка для проверки (без магазина)

```sh
npm run ext:build          # → extensions/chrome/dist и extensions/chrome/na-polku-0.1.1.zip
```

1. Откройте `chrome://extensions`, включите «Режим разработчика».
2. «Загрузить распакованное» → выберите папку `extensions/chrome/dist`.
3. Закрепите значок «На Полку» на панели.
4. Для локальной Полки: «Настройки» расширения → адрес `http://127.0.0.1:6390` → «Сохранить адрес» (Chrome спросит доступ к этому адресу).

ID распакованного расширения зависит от пути к папке, поэтому экран согласия покажет его как «расширение браузера с ID …» с пометкой «имя не подтверждено». Официальный ID из магазина оператор Полки вписывает в `BROWSER_EXTENSION_IDS` — тогда экран согласия называет его «Расширение браузера «На Полку»».

## Как устроено

| Часть | Файл | Что делает |
|---|---|---|
| Service worker | `src/background.ts` | Принимает запросы только от своих страниц, кнопки на claude.ai/chatgpt.com и моста на вашей Полке; каждому — только его действия |
| Вход | `src/auth.ts` | OAuth 2.1 с сервером авторизации Полки: discovery, динамическая регистрация публичного клиента, PKCE S256 через `chrome.identity.launchWebAuthFlow` на `https://<id>.chromiumapp.org/polka`, ротация refresh-токена, отзыв при отключении |
| Сохранение | `src/save.ts`, `src/api.ts` | Извлечь → `POST /api/v1/publish` (`html` или `component`) с ключом идемпотентности; повтор при сети/429/5xx тем же ключом |
| Чтение артефакта | `src/extract/*.ts` | Внедряется **только по нажатию** (`chrome.scripting.executeScript`) |
| Кнопка на странице | `src/content/page-button.ts` | Показывается, пока включена в настройках; ничего не читает до нажатия |
| Мост со страницей Полки | `src/content/bridge.ts` + [`packages/contracts/extension-bridge.ts`](../../packages/contracts/extension-bridge.ts) | Только на адресе вашей Полки, только верхний фрейм |

### Откуда берётся код артефакта

Пробуются по порядку, побеждает первый непустой источник:

1. **Меню артефакта → Export → Download** — на отдельной странице `claude.ai/artifact/<id>`, где нет ни Copy, ни вкладки Code (так она устроена по осмотру 24.09.2026: кнопка-название без aria-label открывает меню с Export → Download и «Copy as Markdown»). Скрипт в изолированном мире помечает кнопку-название; функция в мире страницы на время одного сохранения оборачивает `URL.createObjectURL`, `HTMLAnchorElement.prototype.click`, `EventTarget.prototype.dispatchEvent` и `window.open` и ставит перехват кликов по `a[download]`, открывает меню Base UI так, как оно реально открывается от синтетических событий (проверено на claude.ai 24.09.2026): фокус на `button[data-title-menu]` + ArrowDown, затем фокус на `[data-download-submenu]` + ArrowRight (запасные пути — нажатие мышью, Enter, наведение), и выбирает `[data-download-item]` (текст Export/Download, Экспорт/Скачать — запасной поиск) и читает Blob, который страница собиралась сохранить. Файл в «Загрузки» не попадает никогда: если скачивание оказалось переходом на адрес сервера, оно тоже останавливается, и расширение берёт фрейм. Затем всё восстанавливается, и меню закрываются: Escape на пункте меню в фокусе, затем Escape на кнопке-названии, затем нажатие вне меню, затем повторное нажатие кнопки (Escape на документе это меню не закрывает). Путь через меню пробуется один раз за сохранение и только на страницах артефакта, не в чате. «Copy as Markdown» не нажимается: он копирует отрисованный текст, а не исходник.
2. **Кнопка Copy самого артефакта** (в чате). Скрипт в изолированном мире находит её в шапке панели и помечает; функция в мире страницы на мгновение подменяет `navigator.clipboard.writeText/write`, нажимает кнопку и забирает текст, который Claude отдал бы в буфер обмена. Ваш буфер не трогается, разрешение `clipboardRead` не нужно. Так получается исходник как есть, включая React-компоненты.
3. **Документ во фрейме артефакта** (`iframe[title="User-generated artifact content"]`, `<uuid>.frame.claudeusercontent.com`; скрытый фрейм 1×1 рядом пропускается). Скрипт во фрейме повторно запрашивает свой же адрес (байты страницы до выполнения её скриптов); если фрейм изолирован и запрос не проходит — сериализует живой DOM. Скрипты и стили с доменов Claude, CSP-meta и помеченные элементы просмотрщика удаляются.
4. **Вкладка «Code»**, если открыта она: строки CodeMirror или `pre code`.
5. **ChatGPT (экспериментально):** открытая панель canvas, иначе последний блок кода последнего ответа.

JSX/TSX уходит как `component` (на установке с интерактивным просмотром), HTML — как есть, SVG/Markdown/текст — одной HTML-страницей.

### Мост со страницей Полки

`window.postMessage` в пределах одной вкладки: страница Полки шлёт `hello` со случайным nonce (128 бит), расширение отвечает `ready`; дальше `import` с одной ссылкой → `progress` → `result`. Обе стороны принимают сообщение, только если `event.source === window`, `event.origin` — адрес Полки, nonce совпадает, форма точная, а ссылка — из короткого списка (`claude.ai/artifact|public/artifacts|code/artifact|chat/…`, `chatgpt.com/canvas/shared|share|c/…`). Service worker дополнительно сверяет `sender.origin` с настроенным адресом Полки. Тесты: `tests/extension-bridge.test.ts`.

## Разрешения

| Разрешение | Зачем |
|---|---|
| `scripting` | Внедрить чтение артефакта в вкладку по нажатию; зарегистрировать кнопку и мост |
| `storage` | Адрес Полки, настройки, регистрация клиента и токены |
| `identity` | Окно входа Полки (`launchWebAuthFlow`) |
| `https://claude.ai/*` | Кнопка «На Полку» и чтение открытого артефакта |
| `https://*.claudeusercontent.com/*` | Чтение документа во фрейме артефакта |
| `https://chatgpt.com/*` | То же для ChatGPT |
| `https://polochka.app/*` | Запросы к API Полки и мост на её странице |
| необязательные `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | Только если вы сами укажете адрес своей Полки; Chrome спросит доступ к этому одному адресу |

Нет `tabs`, `clipboardRead`, `cookies`, `webRequest`, `<all_urls>` и постоянных скриптов на чужих сайтах.

## Приватность

- Код артефакта и его название уходят **только** на Полку, адрес которой указан в настройках (по умолчанию `https://polochka.app`). Больше расширение никуда ничего не отправляет: ни аналитики, ни телеметрии, ни сторонних серверов, ни удалённого кода.
- Страница Claude/ChatGPT читается только после вашего действия: кнопка, значок на панели или «Сохранить» на Полке с вашей ссылкой.
- Refresh-токен хранится в `chrome.storage.local`, access-токен на час — в `chrome.storage.session` (недоступен скриптам на страницах). «Отключить» в настройках отзывает токен на Полке и стирает его из браузера.
- Cookies Claude и Полки расширение не читает. Запросы к Полке идут с токеном, без cookies.

Текст для карточки в магазине — [PRIVACY.md](PRIVACY.md).

## Что хрупко

Claude и ChatGPT не документируют разметку и меняют её без предупреждения. Селекторы (`iframe#frame-content`, `iframe[title="User-generated artifact content"]`, `*.claudeusercontent.com`, кнопка с подписью Copy/Копировать, `.cm-line`, `[data-message-author-role="assistant"]`) собраны по публичным описаниям страниц; тестовые фикстуры в `tests/fixtures/extension/` написаны вручную по этим описаниям, реальные страницы с аккаунтом владельца не снимались. Что может сломаться:

- **Кнопка Copy** не найдена (переименована, спрятана в меню) → расширение перейдёт к фрейму. Для React-артефакта во фрейме — только собранный рантайм, и сохранится отрисованная копия, а не исходник.
- **Фрейм артефакта** изолирован (`sandbox` без `allow-same-origin`) → повторный запрос своего адреса не проходит, берётся живой DOM: у скриптовых страниц это состояние после выполнения скриптов. Если в будущем код будет передаваться во фрейм через `postMessage`, а не адресом, фрейм может оказаться пустой оболочкой — тогда остаются Copy и вкладка Code.
- **Удаление рантайма просмотрщика** опирается на домены скриптов и маркеры; новый способ внедрения может оставить лишний скрипт — Полка сохранит страницу, но может выдать её без ссылки или статичной (причину покажет).
- **ChatGPT**: canvas, по публичным сообщениям, заменён в 2026 году; поддержка — лучшее усилие по последнему блоку кода.
- **Импорт по ссылке** открывает фоновую вкладку и ждёт до 20 секунд, пока Claude отрисует артефакт; медленная сеть или окно «войдите» дадут понятную ошибку.
- **Меню Export → Download**: пункты ищутся по атрибутам Base UI (`data-title-menu`, `data-download-submenu`, `data-download-item`), затем по `role="menuitem"` и тексту; кнопка-название без атрибута — как кнопка без aria-label рядом с Share. Сам клик по Download на настоящей странице ещё не проверялся: blob или адрес сервера — неизвестно, обе ветки обработаны. Переименование пунктов, другая локаль, меню, которое не открывается синтетическими событиями, или скачивание через сервер — и расширение перейдёт к фрейму (отрисованная копия). Меню на мгновение открывается у вас на глазах.
- **Подмена кнопки Copy и функций скачивания** на время одного нажатия видна странице Claude (это её мир JavaScript), хоть и на доли секунды.

При поломке пользователь видит сообщение и может сохранить артефакт прежним путём: Download в Claude → файл в Полку.

## Сборка и тесты

- `npm run ext:build` — проверка типов (`extensions/chrome/tsconfig.json`), бандлы esbuild, иконки, zip. Архив и `dist/` не коммитятся.
- `npm test -- tests/extension-bridge.test.ts tests/extension-extract.test.ts tests/extension-oauth.test.ts` — мост, чтение DOM в настоящем Chrome на фикстурах (без Chrome пропускается), OAuth-клиент расширения и публикация с его `Origin`.

## Что нужно владельцу для публикации

1. Аккаунт разработчика Chrome Web Store (разовый взнос $5), двухфакторная защита Google-аккаунта.
2. Карточка: название «На Полку», описание, скриншоты 1280×800, иконка 128×128 (есть в сборке), категория «Productivity», язык русский.
3. Вкладка Privacy: единственная цель, обоснование каждого разрешения (таблица выше), отметки об отсутствии продажи и передачи данных, ссылка на политику — [PRIVACY.md](PRIVACY.md) или страница на polochka.app.
4. После публикации — вписать ID из магазина в `BROWSER_EXTENSION_IDS` на polochka.app и заменить ссылку «Как установить» в `apps/web/src/features/import-url/extension-save.tsx` на карточку магазина.
5. Ожидайте ручную проверку: широкие `optional_host_permissions` и `scripting` на claude.ai её удлиняют. Если ревью возражает, `https://*/*` можно убрать (тогда только polochka.app и localhost).

---

## English

**«На Полку» ("To the Shelf")** saves a Claude.ai artifact (or ChatGPT code) from the user's own signed-in browser to their Полка and returns a share link. Полка's server cannot open `claude.ai/artifact/<id>` links itself (sign-in only, Cloudflare challenge, content in a cross-origin sandboxed frame); the user's browser can.

- **Use:** toolbar popup → «Сохранить на Полку»; or the in-page «На Полку» button next to the artifact's Copy button; or paste the artifact link into Полка's «Сохранить» field — Полка hands it to the extension (postMessage handshake with a nonce, same window and origin only), which opens the link in a background tab, extracts, saves and reports back.
- **Auth:** OAuth 2.1 against Полка's authorization server — dynamic client registration (public client), PKCE S256 via `chrome.identity.launchWebAuthFlow` to `https://<extension-id>.chromiumapp.org/polka`, rotating refresh tokens, revocation on disconnect. Scopes `context capture share`. The consent page names such clients «Расширение браузера» with their ID; IDs listed in the server's `BROWSER_EXTENSION_IDS` are shown as the official «Расширение браузера «На Полку»», and only they may use that name unmarked.
- **Publishing:** `POST /api/v1/publish` with the bearer token; the API accepts `Origin: chrome-extension://<32 a–p>` in addition to Полка's own origin.
- **Extraction** (only on user action, via `chrome.scripting`): (0) on a standalone `claude.ai/artifact/<id>` page, which has no Copy button or Code tab, open the title menu → Export → Download with `URL.createObjectURL`, anchor clicks/dispatches and `window.open` briefly wrapped in the page's world, read the Blob and suppress the download (a server-URL download is stopped too and the frame is used instead; «Copy as Markdown» is never pressed); (1) in a chat, press the artifact's own Copy button with `navigator.clipboard` briefly intercepted in the page's world — exact source, no clipboard permission; (2) the document inside the `*.claudeusercontent.com` frame, refetched or serialised, with the viewer runtime stripped; (3) the Code tab; (4) ChatGPT: open canvas or the last code block (experimental).
- **Permissions:** `scripting`, `storage`, `identity`; hosts `claude.ai`, `*.claudeusercontent.com`, `chatgpt.com`, `polochka.app`; optional hosts only for a self-hosted Полка the user enters. No `tabs`, `cookies`, `clipboardRead`, `webRequest`, `<all_urls>`.
- **Privacy:** data goes only to the configured Полка; no analytics, telemetry, third parties or remote code. See [PRIVACY.md](PRIVACY.md).
- **Fragile:** all provider selectors are undocumented and modelled on public descriptions; fixtures are synthetic. See «Что хрупко» above.
- **Try it:** `npm run ext:build`, then `chrome://extensions` → Developer mode → Load unpacked → `extensions/chrome/dist`.
