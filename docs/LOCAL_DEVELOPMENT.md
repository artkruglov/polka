# Локальная разработка

Node.js ≥22.16, npm и запущенный Docker Desktop. Из корня polka:

```bash
npm ci
npm run local:setup
npm run infra:up
npm run db:migrate
npm run account:create -- artem --generate
npm run build
npm run dev
```

Открыть http://127.0.0.1:4390/. Уже созданный аккаунт повторно не создавать. Локальные реквизиты команды account:create сохраняются в .local; не публиковать их. local:setup сохраняет существующий .env. Сервер обслуживает dist: после изменения UI нужен build и reload; после backend — restart.

Обычная web-загрузка: text/plain, text/html, PNG/JPEG/WebP, до 5 MiB. HTML по умолчанию статичен. Локальный экспериментальный viewer описан ниже. MCP принимает ограниченный multi-file bundle (до64 файлов, 5MiB исходных bytes); импорт внешней ссылки ещё не реализован. Каталог /discover — demo, не реальные авторские публикации. /api/capabilities описывает web-профиль; возможности MCP нужно читать через polka_context.

## Проверки

```bash
npm run check
npm run build
npm test
```

Тесты требуют настоящих локальных PostgreSQL и S3. Они создают synthetic tenants/fixtures; не запускать против production или ценной БД. Наличие listener на 4390 не означает доступность DB/S3. Для диагностики проверить docker compose ps и /api/health; не делать вывод об ошибке кода по ECONNREFUSED контейнера.

Остановка приложения: завершить dev process. Остановка контейнеров с сохранением volumes: npm run infra:stop. Не удалять volumes и .env/LINK_KEY. maintenance — отдельная явная команда очистки истёкших незавершённых загрузок/сессий, использованных и просроченных email challenges и локальных файлов кодов, не автоматическая очистка пользовательских материалов.

Deployment контейнеры здесь — local fixtures, не готовый production compose. DB+S3 backup/restore и upgrade — отдельная приёмка [LAUNCH](LAUNCH.md).

## Проверка входа по коду

MAIL_MODE=disabled по умолчанию. На loopback можно явно включить MAIL_MODE=local и перезапустить сервер. /signup принимает только вымышленные адреса .test; одноразовый код находится в .local/mail/<challenge-id>.json (0600), не в HTTP-ответе. Это тестовый ящик, не подтверждение email. MAIL_MODE=smtp требует SMTP_HOST/MAIL_FROM, при необходимости SMTP_USER/SMTP_PASS; порт 587 STARTTLS или 465 TLS. Настройку проверять на staging с разрешённым тестовым получателем. Никогда не коммитить письма и секреты. Миграция 004 необходима перед обновлением сервера.

## Экспериментальный live HTML

После миграции 005 обычный запуск остаётся статичным. Для локальной проверки при APP_ORIGIN=http://127.0.0.1:4390 и HOST=127.0.0.1:

```bash
HTML_LIVE_ENABLED=true npm run dev
npm run test:live
```

Viewer по умолчанию http://localhost:4391, отдельный listener. Один hostname на разных портах или hosted-конфигурация отклоняются. Inline JS допускается только по явной кнопке на странице; это не гарантированно networkless режим и не профиль для конфиденциальных данных. Сетевые переходы/CPU ещё требуют приёмки. Для выключения перезапустить обычным npm run dev, не добавляя флаг. Уже загруженный JS удаляется закрытием/остановкой iframe. Основные тесты запускаются с выключенным режимом; test:live отдельно включает его.

## MCP: текущая локальная приёмка

20.09.2026 локально проверены исполняемые файлы: `/opt/homebrew/bin/codex` (codex-cli 0.153.4) и `~/.local/bin/claude` (Claude Code 2.1.278). Второй отсутствует в текущем PATH, поэтому его нужно вызывать абсолютным путём. Реальный Codex уже выполнил context → локальный helper → MCP capture → native status; независимый export совпал с четырьмя исходными файлами. Claude остановился на лимите аккаунта до модели; это не принятый второй клиент. Подробности и ограничения — [CLI evidence](reviews/2026-09-20-cli-capture/README.md).

## Подготовка выбранных файлов для агента

Локальный helper сам считает размеры/SHA-256 и кодирует исходные bytes. Он не
обходит папку автоматически и ничего не загружает. Выберите все зависимости:

```bash
npx tsx scripts/prepare-capture.ts ./my-artifact index.html /tmp/polka-payload.json index.html assets/style.css assets/app.js
```

OUTPUT должен быть новым файлом: существующий файл не перезаписывается. JSON
содержит исходное содержимое; не коммитьте его и не передавайте чужим сервисам
без нужного разрешения. Скрытые/неподдержанные пути и symlinks отклоняются,
ограничения — 64 файла/5MiB. Зависимости помечены unknown: helper не доказывает
автономность приложения. Attribution/license можно уточнить перед отправкой.
Сервер capture реализован. Подготовленный payload дополните полями `key` (один UUID для логической попытки) и `title`. Сохраните окончательный request один раз: при retry отправляйте тот же файл, включая capturedAt, manifest и bytes. Тот же key с другим содержимым конфликтует.

Для точной отправки без переписывания bytes моделью:

```bash
npx tsx scripts/capture-via-mcp.ts /path/to/request.json http://127.0.0.1:4390/mcp
```

Helper получает scoped bearer только из явно переданного `POLKA_MCP_TOKEN` в окружении процесса. Не помещайте токен в URL, аргументы команды, коммит или лог. Owner API `/api/agent-connections` выдаёт токен однократно с session-bound CSRF; общий endpoint MCP — APP_ORIGIN + `/mcp`. Выдача и отзыв доступны в `/settings/agents`; `/connections` ведёт в тот же flow.

Helper проверяет receipt и повторно читает status; exit0 означает `saved` с тем же receipt. Capture сохраняет оригиналы приватно, но сам не публикует ссылку и не включает интерактив. Share/revoke и явная `polka_prepare_preview` реализованы отдельно; локальная сквозная цепочка проверена через Codex и браузер получателя. Это bearer-подключение для совместимых клиентов, не готовый OAuth-коннектор для любого чат-приложения.

## Локальная проверка восстановления

`npm run test:restore-guards` проверяет ограничения идентификаторов тестовых ресурсов и шифрование ключа без обращения к DB/S3. Эти проверки также входят в `npm test`.

Отдельный синтетический drill создаёт временные source/target базы и buckets на настроенных loopback PostgreSQL/MinIO, переносит дамп и точные версии объектов, затем закрывает прежний доступ и удаляет только свои ресурсы по sentinel. Рабочие данные не используются. Нужны запущенные local fixtures и PostgreSQL container с `pg_dump`/`pg_restore`:

```bash
node --import tsx --env-file=.env scripts/restore-drill.ts --confirm-synthetic
```

Это регрессионная проверка механизма, а не команда восстановления production. Ограничения и результаты: [протокол](reviews/2026-09-21-restore-drill/README.md), [контракт](RESTORE_DRILL_SPEC.md). Cloud restore, retention, RPO/RTO и установка из чистого checkout проверяются отдельно.

## Изоляция основного набора тестов

`npm test` запускает `scripts/test-isolated.ts`: создаёт случайную PostgreSQL-базу на локальном сервере и отдельный versioned S3-bucket, применяет миграции, запускает список из `tests/default-suite.json`, затем удаляет только созданные им ресурсы. `npm test -- --live [файлы]` так же изолированно запускает файлы из `tests/live-suite.json` с включённым локальным viewer. Рабочие DATABASE_URL/S3_BUCKET не передаются тестам как цели. Нужны local fixtures и локальные права CREATEDB/CreateBucket.

Дочерние команды получают те же изолированные настройки. Рабочий каталог временный: `.local/mail` с кодами вымышленных `.test` адресов не смешивается с почтой приложения; SMTP не используется. Остальной код доступен через symlink, временная `.env` пуста. В конце печатается `test-suite.cleanup` с подтверждением удаления базы и bucket. Ошибка cleanup делает прогон неуспешным.

Не обходить этот runner прямым `tsx --env-file=.env --test` для тестов, записывающих данные. Отдельные специализированные команды ещё требуют проверки их инструкции; эта гарантия относится к `npm test`, а не автоматически ко всем scripts.
