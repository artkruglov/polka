# Производное для живого просмотра пакета

20.09.2026. Следующий шаг [BUNDLE_SPEC](BUNDLE_SPEC.md). Оригинальные файлы и их export не меняются. Сборщик подключён к локальному HTTP/viewer через отдельное производное; один recipient-сценарий проверен в браузере (см. протокол ниже).

## Чистый сборщик

`buildInlineBundle(manifest, Map<path, Buffer>)` сверяет канонический manifest, размеры/hash/UTF-8, затем создаёт воспроизводимые bytes без сети и выполнения JS. Выход: ok, html, sha256, size, sourceManifestSha256, builderVersion (сейчас bundle-inline-v4, см. ниже), runtimeProfile=bundle-inline-experimental-v1, consumedPaths. Либо structured unsupported с причиной/path.

Для оригинального team-report поддержаны синхронный classic script, локальная CSS и инертная SVG-картинка. HTML разбирается [parse5](https://parse5.js.org/), CSS — [PostCSS](https://postcss.org/api/), корректность XML проверяет [saxes](https://github.com/lddubeau/saxes). Результат ограничен8MiB.

Неподдержанные ресурсы, modules/async/defer, CSS imports/resource functions/escape forms, выход за корень и повреждённые bytes дают отказ. Stylesheet link с дополнительными атрибутами пока отклоняется, чтобы не менять их смысл при замене на style. SVG ограничен простыми инертными элементами/атрибутами. Это ограничение первого builder, не запрет сохранять богатый оригинал.

Сборщик не доказывает эквивалентность произвольного JS: currentScript, вычисляемые URL, provider API и storage могут зависеть от исходной среды. CSP и авторизация остаются отдельной защитой. Пока5 unit cases проходят, включая determinism/original hashes и3 исправленных false-ready из ревью Astra. Автономное поведение team-report проверено через настоящий локальный viewer.

## Контракт интеграции и приёмка

1. Отдельная запись производного: revision_id, source manifest hash, builder version, runtime profile, собственные hash/size/object key/version. Уникальность revision+source hash+builder version обеспечивает retry. Не переписывать revision_files или оригинальный manifest.
2. Builder читает только pinned original resources из service layer. Учесть отдельный лимит/расход хранения производных и cleanup неудачных build; сохранить unsupported outcome без ложного ready.
3. Live issuance/read разрешает bundle только при наличии соответствующего принятого производного, повторно проверяя session/share/tenant/expiry/revoke и локальный флаг. Текущий blanket bundle gate не удалять раньше интеграционных проверок. Hosted runtime по-прежнему выключен.
4. Проверить загруженный team-report: CSS+эмблема,12/8 →9/11 →12/8, width390, оригинальный export unchanged; ошибки/builder disable/tenant/revoke. Сборка в unit test не закрывает этот сценарий.
5. После local evidence отдельно решать hosted isolation и совместимость следующего корпуса; importer/MCP используют тот же оригинальный capture service.

## Реализовано локально

Миграция008 хранит immutable derivative отдельно от оригинала. POST/GET `/api/revisions/:id/build-inline` управляют подготовкой и состоянием. Worker ограничен временем/памятью, одновременно допускаются два build; отдельная квота производных. Grants фиксируют конкретное производное и повторно проверяют исходный доступ. GC и retry учитывают S3-success/DB-rollback. HTML/SVG имеют ограничения глубины и числа узлов.

58 default и 3 runtime integration tests прошли. Отдельный HTTP smoke: четыре оригинальных файла сохранены и экспортированы побайтно, build/status ready, ссылка создана. Это ещё не подтверждение браузерного взаимодействия или hosted isolation. Подробности — [протокол](reviews/2026-09-20-bundle-runtime/README.md).

## bundle-inline-v4 (22.09.2026)

Решение владельца: сборщик должен принимать обычные артефакты из чата, иначе интерактивная версия почти всегда отказывает. Новые сборки получают `builderVersion=bundle-inline-v4`. Готовые производные v3 продолжают обслуживаться: все проверки версий (resolve, grants, live viewer, editorial, template-library viewer, assertLinkable, повторная подготовка) принимают список `SERVED_BUILDER_VERSIONS = [v4, v3]`, v3 не пересобирается. Неготовые строки v3 (`unsupported`/`failed`) игнорируются, поэтому отклонённая v3 страница собирается заново уже v4. Изоляция просмотра прежняя: отдельный registrable domain, iframe `sandbox="allow-scripts"` без allow-same-origin/popups/top-navigation, CSP `default-src 'none'`, `connect-src 'none'`, `img-src data:`, `font-src data:`, короткие grants, viewer без cookies.

Что разрешено и почему это безопасно:

- `<img src="data:…">` и CSS `url(data:…)` для image/png, jpeg, webp, gif и CSS-шрифтов font/woff2, font/woff. Принимается только канонический base64 без параметров, первые байты должны совпадать с заявленным типом, размер учитывается в том же бюджете 8 MiB, что и встраивание. SVG в data: допускается, только если проходит прежнюю проверку инертного SVG. Такие URI не выполняют код и не ходят в сеть; CSP viewer и так ограничивает изображения и шрифты `data:`.
- `<a href>` только как `#fragment` или абсолютный `http(s):`/`mailto:`. `javascript:`, `vbscript:`, `data:`, относительные и protocol-relative адреса, управляющие символы и пробелы внутри отклоняются. Переход по ссылке ограничен окружением: без allow-popups и allow-top-navigation новая вкладка и выход из iframe заблокированы, а навигация самого iframe на чужой origin блокируется `frame-src` родительской страницы. Скрипт страницы и без ссылки может менять свой `location`, так что ссылка не добавляет нового канала.
- `<svg><use href="#id">` (и `xlink:href`) только на фрагмент того же документа: внешнего ресурса нет.
- Экранирование в CSS разбирается токенизатором PostCSS. Экранирование допускается в строках, комментариях и идентификаторах селекторов/значений (`content:"\201C"`, `.md\:flex`). Отклоняются: экранированное имя функции (`u\72l(`, `image-\73et(`), любое экранирование внутри скобок (включая аргумент `url()`), экранированное at-правило (`@\69mport`). Проверка выполняется до переписывания `url()`, поэтому обфусцированный `url(` или `@import` не может обойти проверку локальных ресурсов.
- Inline classic `<script>` с `async`/`defer`: у встроенного classic-скрипта браузер эти атрибуты игнорирует, порядок выполнения не меняется. Со `src` они по-прежнему отклоняются, как и `type=module`, importmap и `text/babel` (модули и JSX — следующий этап runtime).

Одиночная HTML-загрузка, которую статичный просмотр не показывает (`htmlProfile=unsupported`), при включённом live собирается тем же сборщиком как однофайловый пакет. Ссылка на неё выпускается только с привязкой к готовому производному; получатель видит результат сборщика, а не исходный файл. Владелец по-прежнему запускает саму загрузку. Если сборщик отказал, ссылка не выпускается, причина видна владельцу.

## Runtime Полки: bundle-inline-v5 и профиль react-runtime-v1 (22.09.2026)

Артефакты из чата чаще всего написаны как React-компонент (JSX/TSX с импортами) или как HTML с `<script type="text/babel">` и CDN-библиотеками. Раньше агенту приходилось вручную собирать всё в classic script. Теперь сборщик компилирует такие страницы сам, на сервере, без сети и детерминированно.

**Контракт.** Схема manifest не меняется: точка входа по-прежнему text/html, исходники компонента — обычные файлы пакета с mime `text/javascript`, синтаксис определяется расширением (`.js/.mjs/.jsx` — JavaScript с JSX, `.ts`, `.tsx`). Общие константы — `packages/contracts/runtime.ts`: список разрешённых импортов с версиями и лицензиями, загрузчики по расширению и оболочка `componentShell`. Страница уходит в runtime, если в ней есть `<script type="module">`, `text/babel`/`text/jsx`, importmap или CDN-скрипт известной библиотеки. Иначе действуют прежние правила v4 без изменений.

- `polka_publish` принимает `component` (исходник как есть, `componentLanguage: "jsx"|"tsx"`) вместо `html`. Сохраняются два файла: `App.jsx`/`App.tsx` байт-в-байт и оболочка `index.html` с `<div id="root">`, `<script type="module" src="App.jsx">` и `<meta name="polka-tailwind" content="preflight">`. Экспорт отдаёт оригинальный исходник. Там, где живой просмотр выключен, `component` отклоняется с просьбой прислать статичный снимок.
- Экспорт по умолчанию из модуля точки входа монтируется в `#root` (элемент создаётся, если его нет). Модули выполняются после разбора документа, по порядку, как `type=module`.
- CDN-скрипты разрешённых библиотек (unpkg, jsDelivr, cdnjs), Babel standalone и Tailwind CDN не загружаются, а заменяются собственными копиями Полки. Для text/babel и CDN-библиотек выставляются глобальные `React`, `ReactDOM` (включая `render`/`unmountComponentAtNode` поверх `createRoot`), `Recharts`, `_`, `d3`, `THREE`, `Papa`, `math`, `Chart`, `LucideReact`. importmap игнорируется: bare-импорты всегда разрешаются в копии Полки.
- Любой другой импорт (включая `node:*`, `react-dom/server`, `@/components/...`, URL) отклоняет сборку. Причина называет модуль и список доступных, путь — файл, где встретился импорт. Она видна владельцу и возвращается агенту в `interactiveUnavailableReason`.

**Библиотеки** (зависимости package.json, точные версии; лицензии проверены по установленным пакетам, тест сверяет версии и лицензии): react и react-dom 19.3.0 (MIT) — основа любого React-артефакта; lucide-react 1.45.0 (ISC) — иконки, стандарт артефактов; recharts 3.10.1 (MIT) — графики в React; lodash 4.18.1 (MIT) — утилиты данных; d3 7.9.0 (ISC) — нестандартные визуализации; three 0.186.0 (MIT) — 3D, включая `three/addons/*`; papaparse 5.7.0 (MIT) — разбор CSV; mathjs 15.2.0 (Apache-2.0) — вычисления; chart.js 4.5.1 (MIT) — графики без React. Сборка: esbuild 0.28.2 (MIT) и tailwindcss 4.3.3 (MIT). Транзитивные зависимости — MIT/ISC/BSD-3-Clause/Unlicense. Лицензионные комментарии библиотек сохраняются в конце собранного скрипта. node_modules вырастает примерно на 100 МБ (three ≈ 23 МБ, es-toolkit ≈ 18 МБ, mathjs ≈ 17 МБ, recharts ≈ 10 МБ).

**Tailwind.** CSS генерируется компилятором Tailwind v4 (чистый JS, без нативного сканера) только для слов исходников, похожих на классы. Кандидаты с `url(`, `://`, `image-set` и `@import` отбрасываются, так что arbitrary value не может сослаться на ресурс. Preflight (базовый сброс) добавляется для компонента и для страниц с Tailwind CDN, у остальных страниц сохраняется собственная база.

**Среда страницы.** Перед кодом вставляется небольшой classic script: `localStorage`/`sessionStorage` в памяти (в песочнице настоящие бросают SecurityError), `document.cookie` пустой, `window.storage` (get/set/delete/list) в памяти, `fetch` и `window.claude.complete` отклоняются с понятным сообщением. Ошибка при выполнении модуля показывается в самой странице, а не оставляет пустой экран.

**Безопасность и пределы.** Изоляция просмотра прежняя (отдельный домен, `sandbox allow-scripts`, CSP `connect-src 'none'`, только data: изображения и шрифты). Скомпилированный скрипт и сгенерированный CSS вставляются только после того, как остальная страница прошла правила v4. CSS дополнительно проверяется теми же правилами (только allowlisted data:). В скрипте запрещены `</script` (esbuild экранирует) и `<!--`. Выход ограничен 8 MiB, скрипт — 7 MiB. Сборка идёт в том же worker (64 МБ heap, 5 с, не более двух одновременно). esbuild запускается дочерним процессом worker с `GOMEMLIMIT=256MiB` и `GOMAXPROCS=2` и завершается вместе с worker по таймауту. Все десять библиотек вместе собираются в worker примерно за 1 с в 1,7 МБ.

**Версии.** Новые сборки получают `builderVersion=bundle-inline-v5`. Профиль — `react-runtime-v1` для скомпилированных страниц и `bundle-inline-experimental-v1` для остальных. Обслуживаемые версии `[v5, v4, v3]` и профили `[bundle-inline-experimental-v1, react-runtime-v1]` принимают resolve, grants, live viewer, editorial, template-library viewer, assertLinkable и повторная подготовка. Готовые v4/v3 не пересобираются. Неготовые строки v4 (например, отказ из-за `type=module`) игнорируются, и страница собирается заново уже v5.

**Ограничения.** Нет сети, workers, `eval`/`new Function` (например, `d3.csvParse` с генерацией конвертера строк и `_.template` не работают под CSP). Нет shadcn/ui и других библиотек вне списка. Хранилище не переживает перезагрузку. Top-level await в модулях не поддерживается (формат IIFE). Классы Tailwind, собранные из строк во время выполнения (`"p-" + n`), не попадают в CSS. `GOMEMLIMIT` — мягкий предел памяти esbuild; жёсткий предел — время worker и ограниченный размер входа (5 МБ).
