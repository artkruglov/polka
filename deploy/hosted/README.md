# Хостинг на одной VM

Пример поставки Полки на одну VM: PostgreSQL на той же машине, внешнее S3-совместимое хранилище с версионированием, TLS через Caddy. Это не HA и не production-сертификация. Ниже `polka.example.com` и `polka-viewer.example.net` — заглушки, подставьте свои домены.

## Состав

| Сервис | Назначение |
|---|---|
| `postgres` | PostgreSQL 16 на VM (volume `pgdata`), внутренняя Docker-сеть и `127.0.0.1:5432` на хосте (никогда не `0.0.0.0`). Роли: `polka_admin` (суперпользователь, только для init), `polka_schema` (владелец схемы, миграции, бэкап), `polka_runtime` (приложение, без DDL) |
| `migrate` → `grants` → `storage-check` | одноразовые шаги при каждом `up`: все миграции (точный набор — в `packages/migrations.ts`, сейчас по 028), `deploy/runtime-grants.sql`, проверка versioned S3 |
| `app` | приложение: app listener `127.0.0.1:4390`, viewer listener `127.0.0.1:4391` (только при `HTML_LIVE_MODE=production`); `network_mode: host` |
| `maintenance` | очистка истёкших загрузок, сессий, грантов; `network_mode: host` |
| `caddy` | TLS (Let's Encrypt, автоматически) для `APP_HOST` и `VIEWER_HOST_NAME`, без access log и admin API; `network_mode: host`, единственный публичный listener (80/443) |
| `backup` | `pg_dump` раз в `BACKUP_INTERVAL_SECONDS` (по умолчанию сутки) в `$BACKUP_BUCKET/postgres/`; образ собирается локально из закреплённого `postgres:16-alpine` + AWS CLI |

Объекты хранятся в приватном versioned-бакете `S3_BUCKET`, дампы БД — в отдельном приватном versioned-бакете `BACKUP_BUCKET`. Интерактивный HTML включается `HTML_LIVE_MODE=production` и работает только на отдельном registrable domain (`VIEWER_HOST_NAME`, отличный от домена `APP_HOST`); по умолчанию `disabled`. Контракт: [HOSTED_VIEWER_DELTA](../../docs/HOSTED_VIEWER_DELTA.md).

Адреса приложение получает из `hosted.env` так: `APP_ORIGIN=https://$APP_HOST`, `VIEWER_ORIGIN=https://$VIEWER_HOST_NAME`; listeners фиксированы в `compose.yml` (`HOST=127.0.0.1`, `PORT=4390`, `VIEWER_HOST=127.0.0.1`, `VIEWER_PORT=4391`), а `TRUST_PROXY=127.0.0.1` доверяет `X-Forwarded-For` только соединениям с loopback (на практике — Caddy).

`app`, `maintenance`, `storage-check` и `caddy` работают в сети хоста: `viewer-config.ts` требует loopback listeners, а Caddy проксирует на `127.0.0.1`. Поэтому на VM порты 4390/4391/5432 должны быть свободны и закрыты извне (они и так слушают только loopback), а в firewall/security group открыты только SSH (лучше — только с адресов оператора), 80/443 TCP и, по желанию, 443/UDP для HTTP/3.

## Первый запуск

1. DNS: A-записи `APP_HOST` и `VIEWER_HOST_NAME` на IP VM, **без** прокси CDN (у Cloudflare — «DNS only»): CDN видел бы токены агентов и мог бы менять HTML. Обе записи нужны до первого `up`: Caddy сразу запрашивает сертификаты для обоих доменов, а `VIEWER_HOST_NAME` обязателен даже при `HTML_LIVE_MODE=disabled`. Firewall — 22, 80, 443 (см. выше). Если у VM динамический внешний IP, после stop/start обновите обе записи.
2. Два приватных бакета с **включённым версионированием**: `S3_BUCKET` (объекты) и `BACKUP_BUCKET` (дампы). `storage-check` не включает версионирование сам и без него останавливает запуск (`Bucket versioning must already be enabled`). По желанию — отдельный ключ только на запись в `BACKUP_BUCKET` (см. «Бэкапы и секреты»).
3. Собрать образ приложения. Опубликованного образа нет, `up --build` собирает только `backup`:

   ```sh
   git clone https://github.com/artkruglov/polka.git /opt/polka && cd /opt/polka
   git checkout <tag-or-commit>
   docker build -t polka:<short-commit> .
   ```

4. Заполнить `hosted.env`: пароли `openssl rand -hex 24`, `LINK_KEY` `openssl rand -hex 32`, S3-ключи и **`POLKA_IMAGE=polka:<short-commit>`** (тег из шага 3).

   ```sh
   cp deploy/hosted/hosted.env.example deploy/hosted/hosted.env && chmod 600 deploy/hosted/hosted.env
   ```

5. Запустить:

   ```sh
   cd deploy/hosted && docker compose --env-file hosted.env up -d --build
   ```

Роли БД создаёт `init-roles.sh` при первом старте пустого volume `pgdata`. Позже он не запускается: смена паролей ролей — вручную через `ALTER ROLE` и затем в `hosted.env`.

Аккаунт (регистрация по почте выключена, пока нет SMTP). Пароль читается из stdin, не из аргументов:

```sh
printf '%s' "$PASSWORD" | docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/account.ts <login>
```

## Редакционный каталог («Интересное»)

Каталог наполняет `scripts/editorial-seed-hosted.ts` из `content/editorial/static-candidates.json` (в образе). Версию он выбирает по `HTML_LIVE_MODE` контейнера, то есть так же, как app: интерактивную при любом режиме, кроме `disabled`.

- `production`: оригинал `content/editorial/<slug>/index.html` сохраняется однофайловым пакетом, собирается текущим live-builder'ом (сейчас bundle-inline-v6; готовые v3–v5 переиспользуются), share и публикация привязываются к готовой производной. Получатель и карточки `/discover` открывают интерактивную версию сразу. [Evidence](../../docs/reviews/2026-09-22-editorial-live/README.md).
- `disabled` (или флаг `--static-only`): статичный снимок `content/editorial/<slug>/static/index.html` ([evidence](../../docs/reviews/2026-09-22-editorial-static/README.md)).

Замена одной версии на другую идёт одной транзакцией (`replaced`), каталог не пустеет. Если производную собрать нельзя, у slug остаётся (или публикуется) статичный снимок: строка `"version":"static"` в stdout, причина в stderr (`"fallback":"static"`).

Один раз создать редакционный аккаунт. Пароль генерируется на VM, файл читает только оператор, копия — в вашем менеджере секретов:

```sh
cd /opt/polka/deploy/hosted
umask 077 && openssl rand -base64 24 > <editorial-password-file>
docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/account.ts <editorial-login> < <editorial-password-file>
```

Перевести каталог на интерактивные версии: сначала развернуть нужный образ (раздел «Обновление»), убедиться, что включён viewer (`curl -s https://polka.example.com/api/capabilities` → `"liveMode":"production"`), затем:

```sh
cd /opt/polka/deploy/hosted
docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/editorial-seed-hosted.ts --confirm-publication --login <editorial-login>
curl -s https://polka.example.com/api/editorial | grep -o '"slug"' | wc -l   # 12
docker compose --env-file hosted.env exec -T postgres psql -U polka_admin -d polka -Atc \
  "SELECT slug, derivative_id IS NOT NULL, builder_version FROM editorial_publications WHERE withdrawn_at IS NULL ORDER BY slug"
# 12 строк вида fractions|t|bundle-inline-v6 (или прежняя версия, если производная уже была готова)
```

Первый запуск печатает 12 строк `{"slug":…,"status":"published","version":"interactive"}` (или `replaced`, если до этого были опубликованы статичные снимки). Затем откройте любую карточку `https://polka.example.com/discover`: над работой «Интерактивная версия», iframe с `https://polka-viewer.example.net`, материал реагирует (например, выбор ответа в «Доли без зубрёжки»).

Раз в неделю запускайте ту же команду (share живёт 30 дней, публикация с share, истекающей в ближайшие 7 дней, заменяется свежей копией без перерыва). Вывод — по строке `{"slug":…,"status":…,"version":"interactive"|"static"}`: `published`, `unchanged`, `replaced`, `renewed`; `blocked` (slug занят другим tenant) и `failed` дают exit 1. Откат viewer'а (`HTML_LIVE_MODE=disabled`) сразу скрывает интерактивные публикации; после него запустите ту же команду, и она вернёт статичные снимки (`replaced`, `"version":"static"`). Снять материал: `scripts/editorial-publish.ts withdraw --confirm-publication --tenant … --owner … --publication …`.

## Интерактивный viewer

Viewer vhost в `Caddyfile`: только `127.0.0.1:4391` с фиксированным `Host: 127.0.0.1:4391` (иначе `live-viewer.ts` отвечает 404), удаляет `Cookie`/`Authorization` из запроса и `Set-Cookie`/`X-Frame-Options` из ответа, `Cache-Control: no-store`, HSTS, без access log. HTTP viewer запрос обрывается без редиректа (capability не попадает в `Location`); HTTP app редиректится на HTTPS. Host, не совпадающий с SNI, получает 421; неизвестный SNI не получает сертификата; неизвестный Host на :80 обрывается.

Включение:

1. A-запись `VIEWER_HOST_NAME` → IP VM (DNS only, без CDN). Проверить: `dig +short polka-viewer.example.net`.
2. В `hosted.env`: `VIEWER_HOST_NAME` (обязателен даже при `disabled`), новый `POLKA_IMAGE`, пока `HTML_LIVE_MODE=disabled`.
3. `docker compose --env-file hosted.env up -d` — пересоздаёт app/maintenance/caddy в сети хоста, публикует postgres на loopback. Caddy выпускает сертификат для обоих доменов: `docker compose --env-file hosted.env logs caddy | grep -E 'certificate obtained|error'`.
4. Проверить TLS viewer до включения: `curl -sI https://polka-viewer.example.net/` → 502 (viewer listener ещё не поднят) с HSTS и `no-store`, без `Set-Cookie`; `curl -sI http://polka-viewer.example.net/document/x` → обрыв соединения, без `Location`.
5. `HTML_LIVE_MODE=production` в `hosted.env`, затем `docker compose --env-file hosted.env up -d`. В логах app: `Experimental production HTML viewer is enabled.`; `curl -s https://polka.example.com/api/capabilities` → `"liveMode":"production"`, `"htmlRuntime":false`.
6. Пройти acceptance из [HOSTED_VIEWER_DELTA](../../docs/HOSTED_VIEWER_DELTA.md#acceptance-что-именно-записать) и записать результат.

**Откат:** `HTML_LIVE_MODE=disabled` в `hosted.env` и `docker compose --env-file hosted.env up -d`. Viewer listener не поднимается, выданные ранее capability URL перестают читаться сразу (флаг проверяется при каждом чтении), статический HTML, скачивание и экспорт не меняются. Производные (`revision_derivatives`) остаются в БД и снова используются после включения.

## Обновление

```sh
cd /opt/polka && git fetch && git checkout <new-tag-or-commit>
docker build -t polka:<new-short> .
sed -i 's/^POLKA_IMAGE=.*/POLKA_IMAGE=polka:<new-short>/' deploy/hosted/hosted.env
cd deploy/hosted && docker compose --env-file hosted.env up -d --build
```

`up -d` заново выполняет миграции и grants, затем перезапускает app. `deploy/runtime-grants.sql` проверяет точный номер последней миграции (точный набор — в `packages/migrations.ts`, сейчас 028): релиз с новой миграцией приносит и обновлённый recipe. Миграции идут одной транзакцией; таймаут на одну команду — `MIGRATION_STATEMENT_TIMEOUT_MS` (по умолчанию 120000). При ошибке job печатает имя файла миграции и SQLSTATE, всё откатывается.

## Откат

- **Без новых миграций:** вернуть прежний `POLKA_IMAGE` и `docker compose --env-file hosted.env up -d`.
- **С миграцией:** откатывать только бинарник нельзя. Восстановите дамп, сделанный перед обновлением (раздел «Восстановление из дампа»), с прежним `POLKA_IMAGE` в `hosted.env`. Объекты S3 версионированы и не удаляются при откате.

## Восстановление из дампа

Для этой формы установки восстановление — это дамп БД из `BACKUP_BUCKET` плюс versioned-бакет объектов `S3_BUCKET` как есть. [deploy/RESTORE.md](../RESTORE.md) описывает отдельный guarded-режим с erasure ledger; к hosted-форме он пока не применим.

Ключ бэкапа только пишет, поэтому для скачивания нужен ключ с правом чтения `BACKUP_BUCKET`. AWS CLI есть в локальном образе `polka-backup:local`. Ниже `<S3_ENDPOINT>` и `<BACKUP_BUCKET>` — значения из `hosted.env`.

```sh
cd /opt/polka/deploy/hosted
docker compose --env-file hosted.env stop app maintenance backup

# 1. Выбрать и скачать дамп
export AWS_ACCESS_KEY_ID=<ключ с чтением> AWS_SECRET_ACCESS_KEY=<секрет> AWS_DEFAULT_REGION=us-east-1
aws_backup() { docker run --rm -i -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  --entrypoint aws polka-backup:local --endpoint-url <S3_ENDPOINT> "$@"; }
aws_backup s3 ls s3://<BACKUP_BUCKET>/postgres/
aws_backup s3 cp s3://<BACKUP_BUCKET>/postgres/polka-<UTC>.dump - > polka.dump
docker compose --env-file hosted.env exec -T postgres pg_restore --list < polka.dump > /dev/null

# 2. Пустая БД с теми же правами, что создаёт init-roles.sh
docker compose --env-file hosted.env exec -T postgres psql -U polka_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DROP DATABASE polka WITH (FORCE);
CREATE DATABASE polka;
REVOKE ALL ON DATABASE polka FROM PUBLIC;
GRANT CONNECT ON DATABASE polka TO polka_schema, polka_runtime;
\connect polka
ALTER SCHEMA public OWNER TO polka_schema;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE polka_schema REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL

# 3. Восстановить от владельца схемы
docker compose --env-file hosted.env exec -T postgres \
  pg_restore --no-owner --exit-on-error -U polka_schema -d polka < polka.dump

# 4. Миграции, grants и запуск
docker compose --env-file hosted.env up -d
rm polka.dump
```

Не используйте `pg_restore --clean`: в существующей БД он оставляет таблицы более новой миграции, а в пустой падает на каждом DROP отсутствующего объекта, и настоящие ошибки теряются среди сотен ложных. Поэтому БД пересоздаётся с правами из `init-roles.sh`, а `pg_restore` идёт без `--clean`. Шаг `grants` при `up` заново выдаёт права `polka_runtime`. Так восстановлен настоящий hosted-дамп схемы 028 (все таблицы и 28 миграций); на отдельной VM эта процедура ещё не отрепетирована. Всё, что изменилось после момента дампа (новые работы, ссылки, сессии, токены агентов), теряется; объекты этих работ остаются в `S3_BUCKET` без ссылок на них.

## Бэкапы и секреты

- Дамп БД: каждые `BACKUP_INTERVAL_SECONDS` (по умолчанию сутки), `s3://$BACKUP_BUCKET/postgres/polka-<UTC>.dump`. Перед загрузкой дамп проверяется `pg_restore --list`. Первый дамп делается сразу при старте: если он не удался (нет доступа к БД или бакету), контейнер `backup` завершается с ошибкой и перезапускается (в `docker compose ps` — `Restarting`); позже неудачи пишутся как `backup FAILED`, а healthcheck становится `unhealthy`, если за интервал плюс час не было успешного дампа. Следите за `docker compose ps`. `backup` ждёт только готовности postgres, не `migrate`, поэтому первый дамп на новой установке может быть сделан до миграций.
- Внеочередной дамп перед обновлением: `docker compose --env-file hosted.env restart backup` (первый дамп после старта делается сразу).
- Ключ бэкапа: задайте отдельные `BACKUP_S3_ACCESS_KEY`/`BACKUP_S3_SECRET_KEY` с правом только на запись (`PutObject`) в `BACKUP_BUCKET`, без чтения, удаления и доступа к бакету объектов. Если они пусты, используется ключ приложения — это допустимо только временно. Версионирование и, по возможности, object lock/retention на бакете бэкапов защищают дампы от перезаписи.
- `hosted.env` (в том числе `LINK_KEY` и пароли БД) храните в менеджере секретов или офлайн, **не** в бакете бэкапов и не в другом бакете, куда пишет эта установка: иначе утечка одного ключа раскрывает и данные, и все секреты. Потеря `LINK_KEY` ломает все выданные ссылки.
- RPO — до одного интервала бэкапа для метаданных; RTO не измерен. Проверьте восстановление на отдельной VM до того, как полагаться на бэкапы.

## Мониторинг

Внешняя проверка — workflow [`.github/workflows/uptime.yml`](../../.github/workflows/uptime.yml) в вашем форке или копии репозитория. Раз в 15 минут он проверяет, что приложение отвечает, viewer-домен отвечает по TLS, сертификатам обоих доменов больше 14 дней и статус оператора зелёный. Упавший запуск и есть алерт: GitHub присылает письмо тому, кто последним менял расписание в workflow. Каждую проверку он повторяет трижды с паузой, поэтому один потерянный запрос не будит.

Настройка:

1. В `hosted.env` задайте `OPS_STATUS_TOKEN` (`openssl rand -hex 32`) и примените `docker compose --env-file hosted.env up -d`.
2. В репозитории на GitHub: Settings → Secrets and variables → Actions. Variables: `UPTIME_APP_ORIGIN=https://<APP_HOST>`, `UPTIME_VIEWER_ORIGIN=https://<VIEWER_HOST_NAME>`. Secret: `OPS_STATUS_TOKEN` с тем же значением.
3. Actions → Uptime → Run workflow, чтобы проверить сразу.

Статус оператора — `GET /api/ops/status` с `Authorization: Bearer <OPS_STATUS_TOKEN>`; без токена маршрута нет (404). Ответ 200 или 503 и проверки:

| Проверка | Красная, если |
|---|---|
| `database` | БД не отвечает |
| `maintenance` | просроченные сессии или гранты лежат дольше 30 минут: цикл обслуживания остановился или падает раньше очистки |
| `backup` | самому новому дампу в `BACKUP_BUCKET/postgres/` 26 часов и больше, или дампов нет. Ключу приложения нужно право на листинг этого бакета |
| `disk` | свободно меньше 10% диска VM |

Лог workflow в публичном репозитории публичен, поэтому скрипт пишет только имена проверок и ok/FAIL, без значений. Ограничения: GitHub запускает расписание с задержкой (обычно до 15–30 минут) и отключает его в репозитории без активности 60 дней; внутри VM никто не будит, если упала сама проверка GitHub.

## Известные ограничения

- Одна VM, без HA. Мониторинг — внешняя проверка раз в 15 минут (см. «Мониторинг»), без собственной системы метрик и дежурств.
- Почта выключена; импорт по ссылке выключен; интерактивный HTML по умолчанию выключен (`HTML_LIVE_MODE=disabled`).
- Caddy без admin API: изменения `Caddyfile` применяются `docker compose --env-file hosted.env restart caddy`.
- Доступ оператора (SSH-ключи, VPN, bastion) и расположение секретов — вне этого репозитория; ведите их в собственном runbook.
