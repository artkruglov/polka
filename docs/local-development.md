# Локальная разработка

*English: [docs/en/local-development.md](en/local-development.md).*

Нужны Node.js ≥ 22.16, npm и запущенный Docker. Все команды выполняются из корня репозитория.

## Первый запуск

```bash
npm ci
npm run local:setup              # создаёт .env с уникальными секретами; существующий .env не трогает
npm run infra:up                 # PostgreSQL 16 (127.0.0.1:54388) и MinIO (127.0.0.1:9038)
npm run db:migrate
npm run storage:bootstrap-local  # создаёт versioned bucket и проверяет его возможности
npm run account:create -- demo --generate
npm run build
npm run dev
```

Первый `infra:up` собирает MinIO из исходников (`deploy/minio/Dockerfile`, около 10 минут): готовых образов MinIO больше не публикует. Дальше образ берётся из локального Docker.

`local:setup` в конце печатает эту же последовательность. Откройте http://127.0.0.1:4390/ и войдите с логином и паролем из `.local/demo-account.txt`. Не публикуйте этот файл. Повторно тот же аккаунт создавать не нужно.

Сервер отдаёт собранный `dist`. После изменений интерфейса выполните `npm run build` и перезагрузите страницу, после изменений backend перезапустите `npm run dev`.

Остановить контейнеры с сохранением данных: `npm run infra:stop`. Не удаляйте volumes, `.env` и `LINK_KEY`: без ключа старые ссылки перестанут открываться.

### Порты и второй клон

По умолчанию PostgreSQL слушает 127.0.0.1:54388, MinIO — 127.0.0.1:9038, приложение — 4390, интерактивный viewer — 4391, compose-проект называется `polka-local`. Всё это записано в `.env`, и `deploy/compose.local.yml` берёт проект и порты оттуда. Другие значения задаются один раз, при создании `.env`:

```bash
POLKA_LOCAL_PROJECT=polka-two POLKA_LOCAL_PG_PORT=55432 POLKA_LOCAL_S3_PORT=9138 \
PORT=4490 VIEWER_PORT=4491 npm run local:setup
```

Так второй клон репозитория получает свои контейнеры и volumes и не мешает первому. В `.env`, созданном раньше, строк `POLKA_LOCAL_*` и `HTML_LIVE_MODE` нет: действуют прежние порты и статичный показ, строки можно дописать вручную. Шаг `grants` в `npm run verify` и тесты удаления аккаунта требуют MinIO на 9038: полный прогон делайте на портах по умолчанию.

### Устаревшие volumes

Если вы пересоздали `.env`, а volumes остались от прошлой установки, пароль не совпадёт, и `db:migrate` упадёт с ошибкой аутентификации. Сброс локального окружения — удалить его вместе с данными и поднять заново, затем повторить первый запуск начиная с `db:migrate`:

```bash
docker compose --env-file=.env -f deploy/compose.local.yml down -v   # удалит локальные БД и bucket
npm run infra:up
```

## Проверки

```bash
npm run check          # направления зависимостей frontend + TypeScript
npm run build
npm test               # основной набор (нужны запущенные infra:up и .env)
npm test -- --live     # наборы с включённым локальным viewer
npm test -- --live tests/trash.test.ts   # один файл из live-набора
npm run verify         # все проверки перед push и деплоем, несколько минут
npm run verify -- --print-steps   # шаги; --only=<шаг,…> запускает выбранные
```

`npm test` запускает `scripts/test-isolated.ts`. Раннер создаёт случайную базу PostgreSQL и отдельный versioned bucket, применяет миграции, прогоняет `tests/default-suite.json` (с `--live` — `tests/live-suite.json`) и удаляет только созданные им ресурсы. В конце он печатает `test-suite.cleanup`, и ошибка очистки считается падением прогона. Рабочие `DATABASE_URL` и `S3_BUCKET` тестам не передаются.

`npm run test:live` — короткая запись для `npm test -- --live`. Остальные отдельные команды из `package.json` перед запуском проверьте по их описанию: не все из них изолированы так же, как `npm test`, и некоторые пишут в базу из `.env`. Запускайте их только на локальной базе, которую не жалко.

Если сервер слушает порт 4390, это ещё не значит, что база и хранилище доступны. Проверьте `docker compose ps` и `/api/health`.

Те же проверки на каждый pull request и push в `main` выполняет GitHub Actions ([.github/workflows/verify.yml](../.github/workflows/verify.yml)): каждый шаг там вызывает `node scripts/verify.mjs --only=<шаг>`. Локально всё запускает `npm run verify`. Отдельные шаги — `node scripts/verify.mjs --print-steps` и `--only=<шаг>`; список разрешённых лицензий и digest образа gitleaks определены только в `scripts/verify.mjs`. Проверка renderer — отдельная команда `npm run test:renderer-runtime`.

## Интерактивный просмотр

`npm run local:setup` записывает в `.env` `HTML_LIVE_MODE=local`: интерактивные страницы работают сразу. Чтобы посмотреть статичный показ, запустите `HTML_LIVE_MODE=disabled npm run dev` или поменяйте значение в `.env`.

Viewer поднимается отдельным listener на http://localhost:4391 (`VIEWER_PORT`). Другой hostname (`localhost` против `127.0.0.1`) даёт браузеру отдельный origin. Режим `local` работает только на loopback. Для hosted-установки есть режим `production`, для которого нужен отдельный registrable domain ([HOSTED_VIEWER_DELTA](HOSTED_VIEWER_DELTA.md), [deploy/hosted/README.md](../deploy/hosted/README.md)). Старая переменная `HTML_LIVE_ENABLED=true` равносильна `HTML_LIVE_MODE=local`.

## Вход по коду из письма

По умолчанию `MAIL_MODE=disabled`. На loopback можно включить `MAIL_MODE=local`: тогда `/signup` принимает только вымышленные адреса в зоне `.test`, а одноразовый код появляется в `.local/mail/<challenge-id>.json`, а не в HTTP-ответе. Для настоящих писем нужен `MAIL_MODE=smtp` с `SMTP_HOST` и `MAIL_FROM`, при необходимости ещё `SMTP_USER` и `SMTP_PASS` (порт 587 STARTTLS или 465 TLS). Письма и секреты не коммитьте.

## Подключить локального агента

Создайте токен на странице http://127.0.0.1:4390/settings/agents (раздел «Для разработчиков»). MCP-адрес — `http://127.0.0.1:4390/mcp`. Команды для Codex и Claude Code приведены в [connect-agents.md](connect-agents.md), только с локальным адресом вместо `https://polochka.app`.

Чтобы передать агенту пакет файлов побайтно, без переписывания моделью, есть два помощника:

```bash
# Собирает payload из выбранных файлов: размеры, SHA-256, base64. OUTPUT должен быть новым файлом.
npx tsx scripts/prepare-capture.ts ./my-artifact index.html ./payload.json index.html assets/style.css assets/app.js
# Отправляет готовый запрос (с полями key и title) через MCP; токен берётся из POLKA_MCP_TOKEN
npx tsx scripts/capture-via-mcp.ts ./request.json http://127.0.0.1:4390/mcp
```

Payload содержит исходники, поэтому его не коммитят. Ограничения пакета: 64 файла и 5 МиБ. Скрытые пути и symlinks отклоняются.

HTTP API и CLI публикации локально работают так:

```bash
POLKA_ENDPOINT=http://127.0.0.1:4390 node scripts/polka-publish.mjs report.html --title "Проба"
```

## Лента локально

Исходники материалов лежат в `content/editorial/<slug>/`. Засевом hosted-каталога занимается `scripts/editorial-seed-hosted.ts`, порядок описан в [deploy/hosted/README.md](../deploy/hosted/README.md).

## Проверка восстановления

`npm run test:restore-guards` проверяет ограничения идентификаторов и шифрование ключа без обращения к БД и S3. Эта проверка входит и в `npm test`.

Синтетический drill создаёт временные исходные и целевые базу и bucket на локальных PostgreSQL и MinIO, переносит дамп и точные версии объектов, закрывает прежний доступ и удаляет только свои ресурсы:

```bash
node --import tsx --env-file=.env scripts/restore-drill.ts --confirm-synthetic
```

Это регрессионная проверка механизма, а не восстановление production. Контракт: [specs/RESTORE_DRILL_SPEC.md](specs/RESTORE_DRILL_SPEC.md). Штатное восстановление описано в [deploy/RESTORE.md](../deploy/RESTORE.md).

## Maintenance

`npm run maintenance` запускает разовую очистку, `npm run maintenance:watch` — очистку по расписанию. Удаляются истёкшие незавершённые загрузки, сессии, использованные и просроченные коды входа. Пользовательские материалы maintenance не удаляет.
