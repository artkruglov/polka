# Статичные версии редакционных материалов

22.09.2026. Hosted Полка работает с `HTML_LIVE_MODE=disabled`: HTML показывается только в sandbox без скриптов. Двенадцать оригиналов из [candidates.json](../../../content/editorial/candidates.json) собираются одним inline-скриптом, поэтому без него часть из них пуста (fractions, city-observation) или показывает только первый шаг.

## Как получены снимки

`npx tsx scripts/editorial-static-snapshots.ts` открывает каждый `content/editorial/<slug>/index.html` в headless Chrome, ждёт первого рендера, для пошаговых материалов собирает все шаги на одну страницу (fractions: пять задач с верным ответом и объяснением; city-observation: шесть слайдов; reading-session: четыре страницы; data-literacy: три вкладки; sorting-explainer: исходный ряд и список всех десяти сравнений; probability-lab: выполненный запуск с seed 17), фиксирует состояние полей в атрибутах, удаляет `<script>`, `<noscript>`, `on*` и `javascript:`, отключает кнопки, оставляет inline CSS и добавляет внизу пометку «Статичная версия. Интерактивная версия появится, когда на Полке включится интерактивный просмотр.»

Результат — `content/editorial/<slug>/static/index.html` (сервис публикации принимает только source, оканчивающийся на `/index.html`) и [static-candidates.json](../../../content/editorial/static-candidates.json). Интерактивные записи candidates.json не изменены. `--check` пересобирает снимки и сравнивает с закоммиченными: 12/12 совпали (детерминированно, без случайных чисел и дат). Каждый снимок классифицируется `classifyHtml` как `static`; это проверяет и тест `tests/editorial-static.test.ts`.

| slug | title | sha256 static/index.html |
|---|---|---|
| fractions | Доли без зубрёжки | `920baafb445b32e2c6ce140969a1dcee1bc6a49169d2f847de7a175106e63a6f` |
| city-observation | Город глазами наблюдателя | `aabeb7f510905c5ee0e892e3eb5300565ec1536c1439ceb7412c61cb698db0b7` |
| week-allocation | Куда уходит неделя | `a80eb25de2e244d808d287d5323b81b574800af1ad9a25caa2d8a361e400d1c6` |
| data-literacy | Среднее не всегда рассказывает всё | `1ab9d3f46ab8c48e5d13dbe7c569f59c1dadfb0857512445fa16a6fefa602648` |
| packing-checklist | Рюкзак на день | `a9ba9f47916e9462d032e30b0ad1d6e07331a54e7deaedcdf9871715ddae667d` |
| contrast-explorer | Контраст в руках | `32c481361ca1140d520d1196dfd4a7b81c4273e4eb64b3ae46902258d8d170f1` |
| meal-plan | Неделя на столе | `717583cd5b80994bb9b869cb9b30711e488e046104d7c681b6f2d8e8a8867c02` |
| sorting-explainer | Как числа находят порядок | `f47d29a9e012e94e55809e71989380c2148a01cb1587a4585810f7ffc23250fb` |
| reading-session | Читательская сессия | `4b311298e48552c1103948d5929dfa23752d6af3185708548ba19c467bfd9cde` |
| tile-pattern | Мастерская узоров | `033f7dca7e752835f848cb40be1fa7fe050179458a4c7ed2a8fb6f73a47fd0ba` |
| probability-lab | Лаборатория вероятностей | `27024996a9086aeaaa70e9de614294563d538039971e01a6dab9ba90cfa6eef0` |
| decision-matrix | Матрица решений | `efbfc664f2271ab9e8e51f3eb9ef907f639f1dfb1ae20a77028c7a90c7d79bd2` |

Скриншоты 1100px и 390px со скриптами выключенными просмотрены: весь ключевой текст виден в начальном состоянии. Отключённые кнопки probability-lab и tile-pattern визуально не меняются (собственные стили материала), но не действуют.

## Публикация

`scripts/editorial-seed-hosted.ts --confirm-publication --login <редакционный аккаунт>` через существующие services сохраняет каждый снимок single HTML revision, выпускает 30-дневную share (максимум политики) и регистрирует публикацию тем же путём, что `editorial-publish.ts` (`scripts/editorial-operator.ts`). Binding без derivative; `source.commit` null, hash точный. Повторный запуск: `unchanged`; истёкшая или устаревшая публикация — `replaced`; share, истекающая в пределах `--renew-within-days` (по умолчанию 7), — `renewed` через свежую копию без окна недоступности. slug активной публикации другого tenant — `blocked`, без изменений. Вывод — только slug/status.

## Локальная проверка

Отдельная БД `polka_editorial_static` и bucket `polka-editorial-static` в локальном docker, сервер на 127.0.0.1:4396 с `HTML_LIVE_MODE=disabled`, `URL_IMPORT_ENABLED=false`. Рабочая локальная БД не использовалась: в ней 12 активных интерактивных публикаций другого tenant, seed корректно отметил бы их `blocked`. Аккаунт `redakciya` создан через `scripts/account.ts` с паролем из stdin. Запуск без `--confirm-publication` — отказ, exit 1. Первый seed: 12 `published`; повтор: 12 `unchanged`; share meal-plan искусственно истекла → `replaced`; share fractions за 3 дня до истечения → `renewed`, старая share отозвана. `GET /api/editorial` — 12 записей; `POST /api/resolve` для каждой ссылки — 200, `htmlProfile: static`, `single`, hash совпадает. Браузер: /discover 1440 и 390 — 12 карточек; fractions (1440), city-observation (390), week-allocation (1440) открываются как «Статичный просмотр».

Hosted-приёмка не выполнена.
