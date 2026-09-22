# Локальная разработка

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

Откройте http://127.0.0.1:4390/ и войдите с логином и паролем из `.local/demo-account.txt`. Не публикуйте этот файл. Повторно тот же аккаунт создавать не нужно.

Сервер отдаёт собранный `dist`. После изменений интерфейса выполните `npm run build` и перезагрузите страницу, после изменений backend перезапустите `npm run dev`.

Остановить контейнеры с сохранением данных: `npm run infra:stop`. Не удаляйте volumes, `.env` и `LINK_KEY`: без ключа старые ссылки перестанут открываться.

## Проверки

```bash
npm run check          # направления зависимостей frontend + TypeScript
npm run build
npm test               # основной набор
npm test -- --live     # наборы с включённым локальным viewer
npm test -- --live tests/trash.test.ts   # один файл из live-набора
```

`npm test` запускает `scripts/test-isolated.ts`. Раннер создаёт случайную базу PostgreSQL и отдельный versioned bucket, применяет миграции, прогоняет `tests/default-suite.json` (с `--live` — `tests/live-suite.json`) и удаляет только созданные им ресурсы. В конце он печатает `test-suite.cleanup`, и ошибка очистки считается падением прогона. Рабочие `DATABASE_URL` и `S3_BUCKET` тестам не передаются.

Отдельные команды `npm run test:live`, `test:mcp`, `test:trash` и подобные работают с базой из `.env` и пишут в неё. Запускайте их только на локальной базе, которую не жалко.

Если сервер слушает порт 4390, это ещё не значит, что база и хранилище доступны. Проверьте `docker compose ps` и `/api/health`.

## Интерактивный просмотр

По умолчанию HTML показывается статично. Чтобы проверить интерактивный режим локально:

```bash
HTML_LIVE_MODE=local npm run dev
```

Viewer поднимается отдельным listener на http://localhost:4391. Другой hostname (`localhost` против `127.0.0.1`) даёт браузеру отдельный origin. Режим `local` работает только на loopback. Для hosted-установки есть режим `production`, для которого нужен отдельный registrable domain ([HOSTED_VIEWER_DELTA](HOSTED_VIEWER_DELTA.md), [deploy/hosted/README.md](../deploy/hosted/README.md)). Старая переменная `HTML_LIVE_ENABLED=true` равносильна `HTML_LIVE_MODE=local`.

## Вход по коду из письма

По умолчанию `MAIL_MODE=disabled`. На loopback можно включить `MAIL_MODE=local`: тогда `/signup` принимает только вымышленные адреса в зоне `.test`, а одноразовый код появляется в `.local/mail/<challenge-id>.json`, а не в HTTP-ответе. Для настоящих писем нужен `MAIL_MODE=smtp` с `SMTP_HOST` и `MAIL_FROM`, при необходимости ещё `SMTP_USER` и `SMTP_PASS` (порт 587 STARTTLS или 465 TLS). Письма и секреты не коммитьте.

## Подключить локального агента

Создайте токен на странице http://127.0.0.1:4390/settings/agents. MCP-адрес — `http://127.0.0.1:4390/mcp`. Команды для Codex и Claude Code приведены в [connect-agents.md](connect-agents.md), только с локальным адресом вместо `https://polochka.app`.

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

## Каталог «Интересное» локально

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
