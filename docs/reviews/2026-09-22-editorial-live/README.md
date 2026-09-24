# Интерактивные версии редакционных материалов

22.09.2026. Hosted работает с `HTML_LIVE_MODE=production` (viewer на отдельном домене `polochka.page`). `scripts/editorial-seed-hosted.ts` при включённом viewer публикует в «Интересном» оригиналы вместо [статичных снимков](../2026-09-22-editorial-static/README.md).

## Что публикуется

Для каждого slug из `content/editorial/static-candidates.json` seed делает следующее:

1. Сохраняет `interactiveSourcePath` (`content/editorial/<slug>/index.html`, hash сверяется с `interactiveSourceSha256`) в редакционном аккаунте однофайловым пакетом (`entrypoint index.html`, `self-contained`, provenance `file`, автор и лицензия материала). Hash revision равен hash оригинала, поэтому манифест публикации ссылается на сам оригинал.
2. Собирает производную тем же builder'ом, что и владельцы (`buildInlineRevision`, bundle-inline v4). Уже готовую v3/v4 производную переиспользует.
3. Выпускает 30-дневную share. `assertLinkable` привязывает её к готовой производной.
4. Регистрирует публикацию через `editorial-operator.ts`: `runtimeProof.derivative` и binding содержат id, sha256, builder version и runtime profile производной, notices: «Оригинальный учебный материал Редакции Полки. Примеры и данные демонстрационные.» Действующая (статичная) публикация снимается в той же транзакции (`replaced`).

Если на любом шаге до регистрации что-то падает (сборка отклонена, квота, share без производной), slug остаётся статичным или получает статичный снимок, stdout показывает `"version":"static"`, а в stderr пишется `{"slug":…,"fallback":"static","reason":…}`. Продление раз в неделю и `unchanged` работают для обеих версий. Интерактивная публикация продлевается свежей копией пакета со своей производной. С `HTML_LIVE_MODE=disabled` или `--static-only` seed возвращает статичные снимки.

Все 12 оригиналов собираются v4 без отказов:

| slug | title | sha256 index.html |
|---|---|---|
| fractions | Доли без зубрёжки | `bdcf96707d4167a630f0afe7d342d7893c04b64eea6c622d4be680056d795867` |
| city-observation | Город глазами наблюдателя | `d24709d460ac05005dc0ebf386a548b2df553441b78d1de1c8601780e20439a9` |
| week-allocation | Куда уходит неделя | `2e43065b2ccc4e2f2d91b69d23f31fd7e5b82452694172f46d277240dd62531d` |
| data-literacy | Среднее не всегда рассказывает всё | `ec984aac758aa73f618bc44c26b002ec579679f4a22ad7fd1912cca0841acd17` |
| packing-checklist | Рюкзак на день | `3496aa53a946eb72e0d31d4e4aa95918f7f857c704ae246c6599a862a8f5abbf` |
| contrast-explorer | Контраст в руках | `3c833d581471a7d9321e9ac491c37392706ab03a4cca5b077eb1f96cfb63398e` |
| meal-plan | Неделя на столе | `903ea4f1e6fccc9ff502f41f1f340af60a97bdbd6d9f2392c017d8eab49d28d0` |
| sorting-explainer | Как числа находят порядок | `df89214cb06f0371e3e55fcff95c732421c6f0ff2ea5797202965993ccaf0c1e` |
| reading-session | Читательская сессия | `6d5e0857e0944847a99622202ec73f4c8b555ccb18a83c8a281d99b21034c12c` |
| tile-pattern | Мастерская узоров | `f607e3613d3440026e4425da28228ccf46b9ed3380baa1caa645b77dd614b22c` |
| probability-lab | Лаборатория вероятностей | `1f643c2461bf783c9bf68d7756e90bd546bed337e7e60d61d8a908de85c64085` |
| decision-matrix | Матрица решений | `6e3c97657b745c69fa73be67ff934526420e7476de6911e49edb97861eec13a3` |

## Локальная проверка в production-режиме

Для проверки использовались отдельная БД и отдельный bucket в локальных контейнерах. Настройки как у hosted: `HTML_LIVE_MODE=production`, `APP_ORIGIN=https://polochka.app`, `VIEWER_ORIGIN=https://polochka.page`, app и viewer слушают loopback, `COOKIE_SECURE=true`, `TRUST_PROXY=127.0.0.1`. TLS-прокси повторял Caddyfile: маршрут по SNI, у viewer фиксированный upstream Host (VIEWER_HOST:VIEWER_PORT), без Cookie/Authorization, без Set-Cookie/X-Frame-Options. Headless Chrome направлял оба домена на прокси.

- Сначала seed с `--static-only` опубликовал 12 снимков (так сейчас выглядит hosted). Затем обычный запуск дал 12 × `replaced`/`interactive` примерно за 2,5 с (включая 12 сборок). Повторный запуск дал 12 × `unchanged`.
- Продление: share всех публикаций сдвинуты на 3 дня до истечения, запуск дал 12 × `renewed`. Во время запуска `/api/editorial` опрошен 40 раз, и каждый раз в каталоге было 12 материалов.
- Откат: с `HTML_LIVE_MODE=disabled` seed вернул статичные снимки (`replaced`/`static`), затем в production снова интерактивные (`replaced`/`interactive`, пакет и производная переиспользованы).
- Браузер, 1440×900: на `/discover` 12 карточек (подпись обложки «ПОЛКА / РЕДАКЦИЯ» оставлена). Каждая из 12 ссылок получателя сама открывает интерактивную версию, без кликов в родителе: в шапке «Интерактивная версия», iframe с `https://polochka.page`, в документе viewer работает скрипт. В каждом материале выполнено одно действие внутри cross-origin frame (через CDP), и DOM изменился: выбор ответа (fractions), «Дальше» (city-observation, reading-session, sorting-explainer), часы работы 50 (week-allocation), вкладка «2. Сравнить» (data-literacy), отметка «вода» (packing-checklist), пресет «Графит / песок» (contrast-explorer), блюдо в плане (meal-plan), seed 8 и «Применить узор» (tile-pattern), 300 запусков (probability-lab), вес «время» 2 и «Пересчитать» (decision-matrix). Итог 12/12, после продления тоже 12/12. Скриншоты fractions, data-literacy и discover просмотрены.

Автоматические проверки: `tests/editorial-seed-live.test.ts` (live-набор, `npm test -- --live`) проходит путь снимок → интерактивная версия → `unchanged` → `renewed` → отказ сборки (квота производных 0) → статичный снимок. Он же проверяет, что ссылка из каталога даёт получателю пакет с готовой производной, grant viewer и документ со скриптом, а вывод не содержит URL и UUID.

Это локальная проверка. Hosted-приёмку после запуска на VM нужно записать отдельно (команды в [deploy/hosted/README.md](../../../deploy/hosted/README.md#лента--редакционный-каталог)).
