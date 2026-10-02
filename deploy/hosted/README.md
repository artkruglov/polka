# Хостинг на одной VM

Пример поставки Полки на одну VM: PostgreSQL на той же машине, внешнее S3-совместимое хранилище с версионированием, TLS через Caddy. Это не HA и не production-сертификация. Ниже `polka.example.com` и `polka-viewer.example.net` — заглушки, подставьте свои домены.

## Состав

| Сервис | Назначение |
|---|---|
| `postgres` | PostgreSQL 16 на VM (volume `pgdata`), внутренняя Docker-сеть и `127.0.0.1:5432` на хосте (никогда не `0.0.0.0`). Роли: `polka_admin` (суперпользователь, только для init), `polka_schema` (владелец схемы, миграции, бэкап), `polka_runtime` (приложение, без DDL) |
| `migrate` → `grants` → `storage-check` | одноразовые шаги при каждом `up`: все миграции до текущей (точный набор и `CURRENT_SCHEMA_VERSION` — в `packages/migrations.ts`), `deploy/runtime-grants.sql`, проверка versioned S3 |
| `app` | приложение: app listener `127.0.0.1:4390`, viewer listener `127.0.0.1:4391` (только при `HTML_LIVE_MODE=production`); `network_mode: host` |
| `maintenance` | очистка истёкших загрузок, сессий, грантов раз в `MAINTENANCE_INTERVAL_SECONDS` (300 по умолчанию, 30–900); `network_mode: host` |
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

## Лента — редакционный каталог

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
curl -s https://polka.example.com/api/editorial | grep -o '"slug"' | wc -l   # 14
docker compose --env-file hosted.env exec -T postgres psql -U polka_admin -d polka -Atc \
  "SELECT slug, derivative_id IS NOT NULL, builder_version FROM editorial_publications WHERE withdrawn_at IS NULL ORDER BY slug"
# 14 строк вида fractions|t|bundle-inline-v6 (или прежняя версия, если производная уже была готова)
```

Первый запуск печатает 14 строк `{"slug":…,"status":"published","version":"interactive"}` (или `replaced`, если до этого были опубликованы статичные снимки). Затем откройте любую карточку `https://polka.example.com/discover`: над работой «Интерактивная версия», iframe с `https://polka-viewer.example.net`, материал реагирует (например, выбор ответа в «Доли без зубрёжки»).

Раз в неделю запускайте ту же команду (share живёт 30 дней, публикация с share, истекающей в ближайшие 7 дней, заменяется свежей копией без перерыва). Вывод — по строке `{"slug":…,"status":…,"version":"interactive"|"static"}`: `published`, `unchanged`, `replaced`, `renewed`; `blocked` (slug занят другим tenant) и `failed` дают exit 1. Откат viewer'а (`HTML_LIVE_MODE=disabled`) сразу скрывает интерактивные публикации; после него запустите ту же команду, и она вернёт статичные снимки (`replaced`, `"version":"static"`). Новые материалы добавляются в `content/editorial/candidates.json`, снимки — `npx tsx scripts/editorial-static-snapshots.ts`; опубликовать только их, не трогая остальные: та же команда с `--only <slug>,<slug>`. Снять материал: сначала убрать его из `content/editorial/candidates.json` и перегенерировать снимки (иначе еженедельный запуск опубликует его снова), развернуть образ, затем:

```sh
cd /opt/polka/deploy/hosted
docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/editorial-seed-hosted.ts --confirm-publication --login <editorial-login> --withdraw <slug>,<slug>
```

По строке на slug: `withdrawn` (публикация снята, её share отозван — одной транзакцией), `absent` (активной публикации нет — повторный запуск безопасен), `blocked` (slug опубликован другим tenant, exit 1). Ничего не публикуется. Низкоуровневый путь по ID публикации: `scripts/editorial-publish.ts withdraw --confirm-publication --tenant … --owner … --publication …`.

## Интерактивный viewer

**Зачем второй домен.** Интерактивная страница выполняет чужой код: скрипты, которые написал агент или автор. На домене приложения такой скрипт работал бы рядом с сессией владельца и мог бы от его имени читать полку. Поэтому страницы открываются только на отдельном домене просмотра, где нет ни входа, ни cookie, ни API: браузер изолирует его от приложения как чужой сайт. Домен должен быть отдельным registrable domain, а не поддоменом той же зоны: `polka.example.com` и `viewer.example.com` для браузера один сайт. На polochka.app это `polochka.app` и `polochka.page`. Не берите поддомен общего хостинга, если его зона не входит в [Public Suffix List](https://publicsuffix.org/) — иначе соседи по хостингу окажутся «тем же сайтом». Без второго домена Полка работает, но HTML показывается статично.

Viewer vhost в `Caddyfile`: только `127.0.0.1:4391` с фиксированным `Host: 127.0.0.1:4391` (иначе `live-viewer.ts` отвечает 404), удаляет `Cookie`/`Authorization` из запроса и `Set-Cookie`/`X-Frame-Options` из ответа, `Cache-Control: no-store`, HSTS, без access log. HTTP viewer запрос обрывается без редиректа (capability не попадает в `Location`); HTTP app редиректится на HTTPS. Host, не совпадающий с SNI, получает 421; неизвестный SNI не получает сертификата; неизвестный Host на :80 обрывается.

Включение:

1. A-запись `VIEWER_HOST_NAME` → IP VM (DNS only, без CDN). Проверить: `dig +short polka-viewer.example.net`.
2. В `hosted.env`: `VIEWER_HOST_NAME` (обязателен даже при `disabled`), новый `POLKA_IMAGE`, пока `HTML_LIVE_MODE=disabled`.
3. `docker compose --env-file hosted.env up -d` — пересоздаёт app/maintenance/caddy в сети хоста, публикует postgres на loopback. Caddy выпускает сертификат для обоих доменов: `docker compose --env-file hosted.env logs caddy | grep -E 'certificate obtained|error'`.
4. Проверить TLS viewer до включения: `curl -sI https://polka-viewer.example.net/` → 502 (viewer listener ещё не поднят) с HSTS и `no-store`, без `Set-Cookie`; `curl -sI http://polka-viewer.example.net/document/x` → обрыв соединения, без `Location`.
5. `HTML_LIVE_MODE=production` в `hosted.env`, затем `docker compose --env-file hosted.env up -d`. В логах app: `Experimental production HTML viewer is enabled.`; `curl -s https://polka.example.com/api/capabilities` → `"liveMode":"production"`, `"htmlRuntime":false`.
6. Пройти acceptance из [HOSTED_VIEWER_DELTA](../../docs/HOSTED_VIEWER_DELTA.md#acceptance-что-именно-записать) и записать результат.

**Откат:** `HTML_LIVE_MODE=disabled` в `hosted.env` и `docker compose --env-file hosted.env up -d`. Viewer listener не поднимается, выданные ранее capability URL перестают читаться сразу (флаг проверяется при каждом чтении), статический HTML, скачивание и экспорт не меняются. Производные (`revision_derivatives`) остаются в БД и снова используются после включения.

## Рендерер ссылок

Рендерер нужен для снимков SPA-сайтов (Lovable, bolt.host, Replit, GitHub Pages, Gemini share), общих ссылок ChatGPT и одной попытки открыть артефакт Claude ([URL_IMPORT_SUPPORT](../../docs/specs/URL_IMPORT_SUPPORT.md#рендерер)). Без него импорт по ссылке работает для обычного HTML и Gist, а для остального остаются карточка и «Сохранить как ссылку».

**Отдельная VM (рекомендуется).** Инструкции для Yandex Cloud и Fly.io — в [deploy/renderer/README.md](../renderer/README.md). В `hosted.env` основной VM:

```
URL_IMPORT_ENABLED=true
RENDERED_IMPORT_ENABLED=true
RENDERER_URL=https://polka-renderer.fly.dev      # или https://renderer.<ваш домен>
RENDERER_SECRET=<openssl rand -hex 32, тот же на рендерере>
# RENDERER_CA=<PEM>   # только для Caddy «tls internal»
# GITHUB_TOKEN=<fine-grained без прав>   # Gist: больше 60 запросов в час
```

**На этой же VM.** `RENDERER_SECRET` в `hosted.env`, затем `docker compose --env-file hosted.env --profile renderer up -d --build`, и `RENDERER_URL=http://127.0.0.1:4395`. Контейнер стоит в своей сети `render` (172.29.0.0/24), к postgres и backup доступа нет, наружу он ходит только через egress-прокси внутри себя. Вторым слоем закройте контейнерам путь к metadata и приватным сетям:

```bash
sudo iptables -I DOCKER-USER -s 172.29.0.0/24 -d 169.254.0.0/16 -j DROP
sudo iptables -I DOCKER-USER -s 172.29.0.0/24 -d 10.0.0.0/8 -j DROP
sudo iptables -I DOCKER-USER -s 172.29.0.0/24 -d 192.168.0.0/16 -j DROP
sudo netfilter-persistent save
```

**Память.** Лимит контейнера — 1,5 ГБ RAM, 1 CPU, 256 процессов. Chromium с одной страницей занимает 300–700 МБ, пиково до 1 ГБ; страницы рендерятся по одной. На одной VM с приложением (1,5 ГБ), maintenance (768 МБ) и postgres нужно от 4 ГБ RAM, спокойнее 6 ГБ. С российского IP chatgpt.com отвечает 403, а claude.ai — «недоступно в регионе», поэтому для ChatGPT и Gemini рендерер нужен за рубежом (см. «Регион» в [deploy/renderer/README.md](../renderer/README.md#регион)).

**Проверка:** `curl -s https://<APP_HOST>/api/imports/capabilities` → в `sources` есть `rendered-spa`, `server-fetch`, `server-try`. **Откат:** `RENDERED_IMPORT_ENABLED=false` и `up -d`.

## Обновление

Перед обновлением прочитайте [CHANGELOG](../../CHANGELOG.md) от своей версии до новой: там названы новые миграции и настройки. Есть ли в релизе миграция, видно и по коду: `git diff --stat <текущий-тег>..<новый-тег> -- deploy/migrations`. Если есть, сначала сделайте дамп (`docker compose --env-file hosted.env restart backup`, раздел «Бэкапы и секреты»): без него откат невозможен.

```sh
cd /opt/polka && git fetch && git checkout <new-tag-or-commit>
docker build -t polka:<new-short> .
sed -i 's/^POLKA_IMAGE=.*/POLKA_IMAGE=polka:<new-short>/' deploy/hosted/hosted.env
cd deploy/hosted && docker compose --env-file hosted.env up -d --build
```

`up -d` заново выполняет миграции и grants, затем перезапускает app. `deploy/runtime-grants.sql` проверяет точный номер последней миграции (точный набор — в `packages/migrations.ts`): релиз с новой миграцией приносит и обновлённый recipe. Миграции идут одной транзакцией; таймаут на одну команду — `MIGRATION_STATEMENT_TIMEOUT_MS` (по умолчанию 120000). При ошибке job печатает имя файла миграции и SQLSTATE, всё откатывается.

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
# ключ аккаунта чтения (не ключ приложения и не ключ записи: у них нет права читать дампы)
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
-- Служебные роли стирания и восстановления (init-roles.sh создаёт их только
-- при первом запуске) теряют CONNECT вместе со старой базой: вернуть тем, что есть.
SELECT format('GRANT CONNECT ON DATABASE polka TO %I', rolname)
  FROM pg_roles WHERE rolname IN ('polka_purge', 'polka_restore') \gexec
\connect polka
ALTER SCHEMA public OWNER TO polka_schema;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE polka_schema REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL

# 3. Восстановить от владельца схемы
docker compose --env-file hosted.env exec -T postgres \
  pg_restore --no-owner --exit-on-error -U polka_schema -d polka < polka.dump

# 4. Миграции и grants, приложение пока не запускать
docker compose --env-file hosted.env run --rm migrate
docker compose --env-file hosted.env run --rm grants

# 5. Журнал стираний: аккаунты, удалённые после момента дампа, стираются снова
sudo install -d -o 1000 -g 1000 /opt/polka/restore/input /opt/polka/restore/receipts
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file hosted.env run --rm restore-authorities \
  --descriptor /restore-input/backup-$STAMP.json --source polka-<UTC>.dump
#   печатает RESTORE_RUN_ID, RESTORE_BACKUP_SHA256, RESTORE_LEDGER_MANIFEST_SHA256
RESTORE_DESCRIPTOR=backup-$STAMP.json RESTORE_RUN_ID=… RESTORE_BACKUP_SHA256=… RESTORE_LEDGER_MANIFEST_SHA256=… \
  docker compose --env-file hosted.env run --rm restore-reconcile --confirm-closed-target

# 5б. Закрыть все доступы, выданные до момента дампа (см. ниже), пока приложение остановлено
docker compose --env-file hosted.env exec -T postgres psql -U polka_admin -d polka -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE shares SET revoked=true WHERE NOT revoked;
UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE revoked_at IS NULL;
DELETE FROM viewer_grants;
DELETE FROM project_view_grants;
DELETE FROM grants;
DELETE FROM agent_connection_csrf;
DELETE FROM sessions;
DELETE FROM login_challenges;
COMMIT;
SQL

# 6. Запуск
docker compose --env-file hosted.env up -d
rm polka.dump
```

Шаг 5б обязателен. Дамп хранит доступы такими, какими они были в момент снимка: ссылка, сессия или токен агента, отозванные уже после него, в восстановленной базе снова действуют до своего срока, а журнал стираний (шаг 5) возвращает только удалённые аккаунты, не отзывы. Поэтому восстановленная база закрывается целиком, так же как в `scripts/restore-drill.ts`: все ссылки отозваны, все подключения агентов отозваны, сессии и временные разрешения удалены. Последствия для людей: все входят заново, агенты подключаются заново, владельцам нужно снова выдать ссылки (сами работы и версии не тронуты). Это осознанный выбор: после аварии лучше закрыть лишнее, чем открыть отозванное. Если дамп снят минуту назад и вы уверены, что после него ничего не отзывали, шаг можно пропустить, но запишите это в журнал операций.

Шаг 5 обязателен, если после момента дампа кого-то удаляли (`account-erase`): иначе удалённые аккаунты вернутся. `restore-reconcile` читает журнал стираний ключом только на чтение, для каждой заявки в нём находит аккаунт в восстановленной базе и снова стирает его строки и объекты полки. Затем пишет квитанцию в `/opt/polka/restore/receipts`. Он откажет, если журнал изменился после `restore-authorities`, если база не закрыта (работают `app`, `maintenance` или `backup`) или миграции не совпадают с релизом. Для него нужны роль `polka_restore` и ключ журнала только на чтение (раздел «Удаление аккаунта»). Проверено 28.09.2026 на отдельной VM: дамп polochka.app, снятый до удаления синтетического аккаунта, восстановлен; после шага 5 аккаунт снова стёрт (строки, статус `purged`), остальные аккаунты не тронуты, сверка — 2 секунды.

Не используйте `pg_restore --clean`: в существующей БД он оставляет таблицы более новой миграции, а в пустой падает на каждом DROP отсутствующего объекта, и настоящие ошибки теряются среди сотен ложных. Поэтому БД пересоздаётся с правами из `init-roles.sh`, а `pg_restore` идёт без `--clean`. Шаг `grants` при `up` заново выдаёт права `polka_runtime`. Так восстановлен настоящий hosted-дамп схемы 028 (все таблицы и 28 миграций). 28.09.2026 процедура отрепетирована на отдельной VM с дампом polochka.app (схема 48, 69 работ): дамп восстановился без ошибок, миграции дошли до 049, все 172 объекта версий нашлись в бакете с совпадающими SHA-256, приложение поднялось на восстановленной базе и отдало файлы работы по API. От пустой VM до работающего приложения — 13 минут, из них сборка образа и скачивание — около 5. Всё, что изменилось после момента дампа (новые работы, ссылки, сессии, токены агентов), теряется; объекты этих работ остаются в `S3_BUCKET` без ссылок на них.

## Бэкапы и секреты

- Дамп БД: каждые `BACKUP_INTERVAL_SECONDS` (по умолчанию сутки), `s3://$BACKUP_BUCKET/postgres/polka-<UTC>.dump`. Перед загрузкой дамп проверяется `pg_restore --list`. Первый дамп делается сразу при старте: если он не удался (нет доступа к БД или бакету), контейнер `backup` завершается с ошибкой и перезапускается (в `docker compose ps` — `Restarting`); позже неудачи пишутся как `backup FAILED`, а healthcheck становится `unhealthy`, если за интервал плюс час не было успешного дампа. Следите за `docker compose ps`. `backup` ждёт только готовности postgres, не `migrate`, поэтому первый дамп на новой установке может быть сделан до миграций.
- Срок хранения дампов задаёт правило жизненного цикла на `BACKUP_BUCKET`, код их не удаляет. На polochka.app: префикс `postgres/`, удаление через 30 дней, прежние версии — через день (`PutBucketLifecycleConfiguration`, S3 API). Политика обработки данных обещает именно этот срок: меняете правило — меняйте и текст `docs/legal/privacy.md`.
- Внеочередной дамп перед обновлением: `docker compose --env-file hosted.env restart backup` (первый дамп после старта делается сразу).
- **Ключи бэкапа: три роли, три сервисных аккаунта.** Приложение бэкапы не пишет, не читает и не удаляет, иначе взломанное приложение уничтожило бы и данные, и копии.
  - Запись: `BACKUP_S3_ACCESS_KEY`/`BACKUP_S3_SECRET_KEY` (обязательны в `compose.yml`) с правом только `PutObject` в `postgres/`.
  - Чтение для восстановления: отдельный аккаунт только с `GetObject` и `ListBucket`, ключ хранится вне VM (шаг 1 восстановления).
  - Приложение: только `s3:ListBucket`, чтобы `/api/ops/status` считал возраст последнего дампа.
  На Yandex Object Storage (проверено 29.09.2026 на временном бакете) это делается так: политика бакета работает как **белый список**: как только она есть, всё, чего в ней нет, запрещено всем, включая роль папки `storage.editor` у приложения и владельца облака. Одной политики «Allow» для нового аккаунта недостаточно, нужен ещё ACL: `yc storage bucket update --name <BACKUP_BUCKET> --grants grant-type=grant-type-account,permission=permission-read,grantee-id=<запись> --grants grant-type=grant-type-account,permission=permission-write,grantee-id=<запись> --grants grant-type=grant-type-account,permission=permission-read,grantee-id=<чтение>` (одиночный `permission-write` `yc` отклоняет; ACL сужает политика). Политика: [`backups-bucket-policy.example.json`](backups-bucket-policy.example.json), `--policy-from-file`. Порядок при внедрении на работающей установке: сначала ACL и политика, где приложению пока разрешено всё, затем переключить `backup` на новый ключ и убедиться, что появился `backup ok`, и только потом сузить приложение до `s3:ListBucket`. Снять политику целиком `yc` не умеет; если бэкапы перестали писаться, замените её на ту, что возвращает права. Правило жизненного цикла и версионирование политика не трогает. Тем же способом закрыт бакет журнала стираний: приложения в его политике нет.
  Версионирование и, по возможности, object lock/retention на бакете бэкапов защищают дампы от перезаписи.
- `hosted.env` (в том числе `LINK_KEY` и пароли БД) храните в менеджере секретов или офлайн, **не** в бакете бэкапов и не в другом бакете, куда пишет эта установка: иначе утечка одного ключа раскрывает и данные, и все секреты. Потеря `LINK_KEY` ломает все выданные ссылки.
- RPO — до одного интервала бэкапа для метаданных (на polochka.app — сутки). RTO на polochka.app — около 15 минут до работающего приложения на новой VM, без DNS и TLS (проверка 28.09.2026). Проверьте восстановление на отдельной VM до того, как полагаться на бэкапы, и повторяйте после изменений схемы.
- Для восстановления нужен `hosted.env`: на polochka.app его копия — секрет Lockbox `polka-hosted-env`. 28.09.2026 копия совпала с файлом на VM во всех 55 настройках, кроме `POLKA_IMAGE` (меняется при каждом обновлении). Обновляйте её при каждом изменении настроек.

## Вход по почте

По умолчанию выключен (`MAIL_MODE=disabled`): аккаунты с паролем выдаёт оператор. С `MAIL_MODE=smtp` вход — по восьмизначному коду из письма. В режиме `EMAIL_SIGNUP=invite` (по умолчанию в `compose.yml` и `hosted.env.example` этой формы установки; в коде по умолчанию `open`) код получают только:

- аккаунты, к которым оператор привязал адрес: `docker compose --env-file hosted.env run --rm app node --import tsx scripts/account-email.ts <логин> <почта>` — вход по коду откроет полку этого аккаунта;
- адреса и домены из `EMAIL_SIGNUP_ALLOW` (`anna@example.com,@team.example.com`) — при первом входе у них появится новая полка.

Остальным форма отвечает так же, но письмо не уходит, поэтому по ней нельзя узнать, кто приглашён. `EMAIL_SIGNUP=open` открывает регистрацию любому адресу (так на polochka.app, с потолками `EMAIL_SIGNUP_DAILY_*`).

Отправка через Yandex Cloud Postbox:

1. В консоли Postbox создайте адрес (домен приложения, DKIM «Простой») и добавьте у DNS-провайдера показанные две CNAME-записи DKIM, а также SPF в корне домена (`TXT "v=spf1 include:spf.postbox.yandexcloud.net ~all"`; если SPF уже есть, добавьте `include:spf.postbox.yandexcloud.net` перед `all`) и DMARC (`TXT _dmarc "v=DMARC1;p=none"`). Записи — по [документации Postbox](https://yandex.cloud/ru/docs/postbox/concepts/dns-records). Дождитесь статуса «Success».
2. Сервисный аккаунт с ролью `postbox.sender` и его API-ключ со scope `yc.postbox.send`.
3. В `hosted.env`: `MAIL_MODE=smtp`, `SMTP_HOST=postbox.cloud.yandex.net`, `SMTP_PORT=587`, `SMTP_USER=<ID API-ключа>`, `SMTP_PASS=<секрет API-ключа>`, `MAIL_FROM=no-reply@<APP_HOST>`, затем `docker compose --env-file hosted.env up -d`.

**Домены почты для новых полок.** Шаблон этой формы установки (`compose.yml` и `hosted.env.example`) ставит `EMAIL_SIGNUP_DOMAINS=ru-only`: новую полку по коду можно открыть только на адресах Яндекса, Mail.ru, Рамблера, VK и на домене самой установки. Причина — ч. 10 ст. 8 149-ФЗ. Это умолчание шаблона, а не кода (в коде — `any`). На polochka.app с 26.09.2026 стоит `EMAIL_SIGNUP_DOMAINS=any`: новую полку можно открыть на любом адресе. Существующие аккаунты на других доменах входят по коду, пока `EMAIL_LOGIN_DOMAINS=any`. Подробности — [SIGN_IN_PROVIDERS.md](../../docs/specs/SIGN_IN_PROVIDERS.md).

## Вход через Яндекс ID и VK ID

Кнопки появляются, когда задан клиент поставщика. Токены поставщика Полка не хранит.

**Яндекс ID** — [oauth.yandex.ru](https://oauth.yandex.ru/client/new), платформа «Веб-сервисы»:
- Redirect URI: `https://<APP_HOST>/api/auth/idp/yandex/callback`;
- доступы: «Доступ к адресу электронной почты» (`login:email`) и «Доступ к логину, имени и фамилии, полу» (`login:info`);
- в `hosted.env`: `YANDEX_CLIENT_ID=<ClientID>`, `YANDEX_CLIENT_SECRET=<Client secret>`.

**VK ID** — [id.vk.ru/about/business/go](https://id.vk.ru/about/business/go), приложение типа «Веб»:
- базовый домен `<APP_HOST>`;
- доверенный Redirect URL `https://<APP_HOST>/api/auth/idp/vk/callback`;
- доступ к почте (scope `email`);
- в `hosted.env`: `VK_CLIENT_ID=<ID приложения>`. Защищённый ключ не нужен: код защищён PKCE.

**Google** — пошагово в [google-oauth-setup.md](../../docs/ops/google-oauth-setup.md):
- Google Auth Platform, клиент «Web application»;
- Authorized redirect URI `https://<APP_HOST>/api/auth/idp/google/callback`;
- scopes только `openid`, `email`, `profile`;
- в `hosted.env` и Lockbox `polka-hosted-env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
- `GOOGLE_SIGNUP=link-only` (по умолчанию здесь). Google — не российская система, поэтому он только входит в полку, к которой владелец привязал его в «Способах входа». Новую полку он не открывает и временную не закрепляет.

**Доступ компании:** `ORG_DOMAINS=company.ru=<id библиотеки шаблонов>:reader`. Сотрудник с подтверждённой почтой `@company.ru`, вошедший через Яндекс ID (у Яндекс 360 это аккаунт организации), становится читателем библиотеки. Исключённого администратором домен обратно не добавит.

После изменения — `docker compose --env-file hosted.env up -d`.

## Одна полка на человека

Как Полка не даёт человеку случайно завести вторую полку и как собрать две в одну — [SIGN_IN_PROVIDERS.md](../../docs/specs/SIGN_IN_PROVIDERS.md), § 1, 8–10. Коротко:
- браузер, где уже входили, спрашивает «Войти в существующую или создать новую?», прежде чем Яндекс ID, VK ID или код на новый адрес откроет новую полку;
- страница подключения агента показывает, в какую полку пойдут работы;
- агента можно подключить без регистрации: откроется временная полка этого браузера. Ссылки она не выдаёт, пока её не закрепят Яндекс ID, VK ID или почтой на российском домене. Неиспользуемую 30 дней удаляет обслуживание. В этой форме установки конвейер удаления выключен (`ACCOUNT_DELETION_ENABLED=false`), поэтому обслуживание само закрывает такую полку, удаляет её объекты из хранилища, затем её строки. Полку, у которой вдруг есть ссылки, обсуждения, публикации, привязки или заблокированное содержимое, оно только закрывает и оставляет оператору;
- по просьбе «Открой мою Полку» агент даёт ссылку на страницу входа в эту полку, без секрета. Одноразовую ссылку со входом (5 минут, после клика, слабая сессия) он даёт только для незакреплённой временной полки и только если на согласии отмечено «Давать ссылку для входа».

**Объединить две полки одного человека.** Только по обращению, в котором владелец подтвердил, что обе полки его: например, вошёл в обе и написал из обеих или с их адресов. Номер обращения обязателен (`--proof`) и попадает в журнал. Сначала пробный прогон — он ничего не меняет и печатает, что переедет:

```sh
docker compose --env-file hosted.env exec -T app node --import tsx scripts/account-merge.ts \
  --from <логин|почта|id лишней полки> --into <логин|почта|id основной> --dry-run
# то же всерьёз; причина попадёт в журнал модерации
docker compose --env-file hosted.env exec -T app node --import tsx scripts/account-merge.ts \
  --from <…> --into <…> --proof "обращение №1042" --reason "письмо владельца от 24.09"
```

Что делает:
- переносит работы с версиями и файлами, папки (одноимённые сливаются), ссылки — старые адреса продолжают открываться, — обсуждения, подключения агентов и их ключи продления (агенты продолжают работать и сохраняют в основную полку), привязки Яндекс ID и VK ID (если у основной нет такого же поставщика), участие в библиотеках шаблонов, заметки источника на чужих полках, статистику;
- объекты хранилища копируются под префикс основной полки, старые удаляются после фиксации;
- источник удаляется: при включённом конвейере удаления — через него, иначе закрывается как удалённый, почта, имя и оставшиеся привязки стираются. В журнал пишется `account.merged` с номером обращения (`moderation.ts events <id источника>`).

Откажет, если одна из полок отключена или удаляется, если у источника есть заблокированное содержимое или публикации в «Ленте», и пока у источника идёт загрузка, импорт или сборка.

Адрес почты источника переезжает, только если у основной полки почты нет; иначе он стирается вместе с источником, и вход по коду на него откроет новую полку. Скрипт об этом пишет. Локально: `npm run account:merge -- --from … --into … --proof … --dry-run`.

## Удаление аккаунта

Удаление — по обращению владельца ([Политика](../../docs/legal/privacy.md), § 7), командой оператора `account-erase`, а когда оператор включил кнопку, ещё и самим владельцем: «Настройки» → «Удалить полку» → «Удалить аккаунт…» (план с числом работ и сроками, подтверждение словом «УДАЛИТЬ», затем страница `/account-deleted` со статусом). Оба пути пользуются одним конвейером:

1. **Заявка** закрывает аккаунт сразу: вход, сессии, агенты и их ключи продления, ссылки и гранты просмотра, незавершённые загрузки. Публикации в «Ленте» снимаются. В журнал модерации пишется `account.erasure_requested` с номером обращения.
2. **Очистка** (`scripts/account-purge.ts`, отдельная роль БД `polka_purge`): запись об отзыве во внешний журнал стираний, удаление всех версий объектов полки из `S3_BUCKET` (оригиналы, файлы пакетов, собранные страницы, недогруженное), проверка, что под префиксом полки ничего не осталось, стирание метаданных одной защищённой функцией (`terminal_erase_account_metadata`: работы, версии, ссылки, обсуждения, агенты, почта, имя, пароль, привязки входа, участие в библиотеках и полках отделов), итоговая запись в журнал. Остаётся обезличенная запись о заявке.

Откажет, если на полке есть заблокированное содержимое (его хранит модерация как доказательство) или аккаунт — единственный администратор полки отдела, где есть другие участники.

```sh
cd /opt/polka/deploy/hosted
docker compose --env-file hosted.env run --rm account-erase --account <логин|почта|id> --dry-run
docker compose --env-file hosted.env run --rm account-erase --account <логин|почта|id> --proof "обращение №1042" --reason "просьба владельца"
# если прервалось (сеть, таймаут): доступ уже закрыт, очистка продолжится
docker compose --env-file hosted.env run --rm account-erase --account <id> --resume
```

Пробный прогон ничего не меняет и печатает, сколько работ, версий, ссылок и агентов уйдёт. Обычно всё занимает меньше минуты; за проход обработчик удаляет до 100 версий объектов и повторяет, пока не закончит (`--minutes`, по умолчанию 15).

**Кнопка «Удалить аккаунт» (выключена по умолчанию).** Заявка с кнопки только закрывает доступ; данные стирает служба очистки, поэтому кнопку включают вместе с ней и только после приёмки на синтетическом аккаунте:

```sh
# hosted.env: ACCOUNT_DELETION_ENABLED=true, ACCOUNT_DELETION_PURGE_WORKER=true,
# ACCOUNT_DELETION_POLICY_VERSION, ACCOUNT_PURGE_MAX_HOURS, BACKUP_RETENTION_MAX_DAYS
docker compose --env-file hosted.env --profile purge up -d account-purge   # проход раз в минуту
docker compose --env-file hosted.env up -d app                              # подхватывает флаги
docker compose --env-file hosted.env logs -f account-purge                  # account_purge.completed
```

При каждом обновлении добавляйте `--profile purge` к `up -d`: без него служба останется на старом образе, а у образа и схемы разные версии. Следите за журналом службы: при пустом `POLKA_PURGE_PASSWORD` или без `ERASURE_LEDGER_*` проход падает с `account_purge.failed reason:"setup"`, заявки не стираются и остаются `access_revoked_pending_purge`.

`ACCOUNT_DELETION_PURGE_WORKER=true` разрешает включать кнопку не только на loopback; без службы очистки данные после заявки остаются, а страница статуса обещает удаление, которого нет. Включено на polochka.app 02.10.2026. Приёмка (проведена так же и перед включением): запустить второй экземпляр приложения на другом порту с флагами и синтетическим аккаунтом, не трогая основной; создать синтетический аккаунт, нажать кнопку, дождаться `purged` на `/account-deleted`, проверить, что в бакете под префиксом полки пусто, а запись в журнале стираний появилась. Отказывает так же, как `account-erase`: заблокированное содержимое у модерации, единственный администратор полки отдела с участниками.

**Настройка один раз.**

- **Журнал стираний** — отдельный бакет с версионированием, не тот, куда пишет приложение или бэкап: из него восстановление узнаёт, какие аккаунты удалить снова после возврата к старому дампу. Ключ журнала пишет, читает и перечисляет версии, но не удаляет. В Yandex Object Storage: сервисный аккаунт без ролей в папке, ACL бакета на чтение и запись этому аккаунту и политика бакета, которая разрешает ему только `s3:PutObject`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:ListBucket`, `s3:ListBucketVersions` — удаление тогда запрещено. Хранилище должно поддерживать условную запись (`If-None-Match: *`, 412 на повтор); Yandex Object Storage поддерживает (проверено 28.09.2026).
- **Роли `polka_purge` и `polka_restore`**. На новой установке их создаёт `init-roles.sh`, если заданы `POLKA_PURGE_PASSWORD` и `POLKA_RESTORE_PASSWORD`. Только при первом запуске PostgreSQL: включённые позже, они не появятся, а шаг `grants` пропускает отсутствующую роль молча. На существующей установке (и повторно, скрипт идемпотентен: создаёт недостающие роли, ставит пароль из окружения, возвращает `CONNECT`):

  ```sh
  docker compose --env-file hosted.env exec -T postgres sh -s < worker-roles.sh
  docker compose --env-file hosted.env run --rm grants   # выдаст им точные функции
  ```
- **Для восстановления** — роль `polka_restore` (как `polka_purge`, с паролем `POLKA_RESTORE_PASSWORD`; шаг grants выдаёт ей функции восстановления) и второй ключ журнала только на чтение: `ERASURE_LEDGER_READER_ACCESS_KEY`, `ERASURE_LEDGER_READER_SECRET_KEY` (сервисный аккаунт с ACL чтения и политикой, разрешающей ему только `s3:GetObject`, `s3:GetObjectVersion`, `s3:ListBucket`, `s3:ListBucketVersions`).
- **`hosted.env`**: `POLKA_PURGE_PASSWORD`, `ERASURE_LEDGER_ID` (любой UUID, один на установку), `ERASURE_LEDGER_ENDPOINT`, `ERASURE_LEDGER_BUCKET`, `ERASURE_LEDGER_ACCESS_KEY`, `ERASURE_LEDGER_SECRET_KEY`, `ACCOUNT_DELETION_POLICY_VERSION` (редакция Политики), `ACCOUNT_PURGE_MAX_HOURS` (720) и `BACKUP_RETENTION_MAX_DAYS` (30) — сроки, которые обещает Политика.

**После восстановления из дампа** аккаунты, удалённые позже момента дампа, стираются снова по журналу стираний: шаг 5 раздела «Восстановление из дампа».

## Комментарии

`COMMENTS_MODE=owner-notes` (по умолчанию здесь):
- к работе пишет только её владелец и его агент — это заметки к фрагментам;
- получатели ссылки их читают, но не отвечают;
- реакций и писем нет;
- комментарии получателей, оставленные раньше, скрыты, но не удалены.

Другие значения:
- `on` — комментарии получателей ([COMMENTS.md](../../docs/specs/COMMENTS.md));
- `off` — обсуждений нет вовсе.

## Прочие настройки

- `TEAM_SHELVES` (`off` по умолчанию и на polochka.app) — полки отделов ([TEAM_SHELVES.md](../../docs/specs/TEAM_SHELVES.md)).
- `BROWSER_EXTENSION_IDS` — ID официальной сборки расширения «На Полку»; её страница согласия подписана «Расширение браузера «На Полку»». Пусто — любое расширение показывается со своим ID.
- `POLKA_EXTENSIONS` — модули расширений открытого ядра, установленные в образ ([EXTENSIONS.md](../../docs/specs/EXTENSIONS.md)). Пусто — только ядро.
- `S3_SECRET_KEY` — не короче 16 символов, иначе приложение не запустится.
- `TRUST_PROXY=127.0.0.1` и `COOKIE_SECURE=true` зафиксированы в `compose.yml`: Caddy на той же VM. Если ставите перед Полкой другой прокси, `TRUST_PROXY` должен быть его адресом. Пустой `TRUST_PROXY` за прокси превращает лимиты по IP (вход, регистрации с одного IP, API без токена) в один общий лимит на всех.
- `ACCOUNT_DELETION_ENABLED` и `ACCOUNT_DELETION_PURGE_WORKER` по умолчанию `false`: кнопка «Удалить аккаунт» включается только вместе со службой `account-purge` (раздел «Удаление аккаунта»); пока выключена, удаляет оператор. `RESTORE_*` задаёт только оверлей восстановления ([RESTORE.md](../RESTORE.md)).

## Модерация

Правила — [docs/specs/ABUSE_PROTECTION.md](../../docs/specs/ABUSE_PROTECTION.md) (доверие, жалобы, письма) и [docs/specs/CONTENT_FILTER.md](../../docs/specs/CONTENT_FILTER.md) (фильтр запрещённого содержимого, модели, блокировка, изоляция и удаление). Отдельной админки нет: оператор получает письма с кнопками только о том, что отметила автоматика, и о жалобах, а без почты пользуется скриптами ниже.

### Настройки

В `hosted.env` (все передаются через `compose.yml`). У `SHARE_MODERATION`, `CONTENT_FILTER_MODE`, `CONTENT_FILTER_AUTOBLOCK`, лимитов новых аккаунтов, регистрации и бюджета моделей значение из средней колонки (для автоблокировки — `false`) — оно же умолчание `compose.yml`: переменная, которой нет в `hosted.env` (или она пуста), получает его. Умолчания в коде (`config.ts`) мягче, они для локального запуска. `OPERATOR_EMAIL`, `OPERATOR_CONTACT` и модели по умолчанию пусты или выключены.

| Переменная | На запуск polochka.app | Что делает |
|---|---|---|
| `SHARE_MODERATION` | `auto` | Какие новые ссылки ждут проверки из-за автора: `off` — никакие; `auto` — никакие, решает фильтр содержимого, доверие автоматическое, ждут только изображения новых аккаунтов, которые ещё не видела модель; `flagged` (значение по умолчанию в коде) — похожие на фишинг от недоверенного автора; `new-accounts` — любая ссылка недоверенного автора; `all` — любая ссылка аккаунта, зарегистрированного по почте |
| `OPERATOR_EMAIL` | адрес оператора | Куда идут письма о модерации и заявки со страницы `/enterprise`. Нужен `MAIL_MODE=smtp`. Пусто — писем нет: модерация — скриптами, заявки — в таблице `enterprise_requests` |
| `MODERATION_AUTOPAUSE_REPORTS` | `3` | Столько разных жалобщиков за 7 дней ставят ссылку на паузу. `0` — никогда |
| `NEW_ACCOUNT_DAYS` | `7` | Сколько дней аккаунт считается новым (если оператор его не одобрил) |
| `NEW_ACCOUNT_MAX_LINKS` | `5` | Сколько открытых ссылок у нового аккаунта. `0` — без ограничения. Срок ссылки нового аккаунта — не больше 7 дней |
| `NEW_ACCOUNT_DAILY_LINKS` | `10` | Сколько ссылок новый аккаунт создаёт в сутки (закрытые тоже считаются) |
| `TRUST_MIN_CLEAN_SAVES` | `3` | При `SHARE_MODERATION=auto`: сколько сохранений без блокировок нужно, чтобы аккаунт старше `NEW_ACCOUNT_DAYS` стал доверенным |
| `CONTENT_FILTER_MODE` | `strict` | Фильтр содержимого: `off`, `balanced` (по умолчанию в коде), `strict` — всё отмеченное ждёт проверки при любом доверии |
| `CONTENT_FILTER_AUTOBLOCK` | `false` первые 2–4 недели, затем `true` | Автоблокировка: при `false` сразу блокируются только CSAM и явный вредоносный код, остальное ждёт вас; при `true` — ещё тяжёлые категории, в которых уверены правила или согласны обе модели |
| `MODERATION_RETENTION` | пусто | Сроки изоляции по категориям поверх умолчаний (`porn=30,gambling=keep`…) |
| `OPERATOR_CONTACT` | `privacy@polochka.app` | Адрес для обжалования, который владелец видит у заблокированной работы |
| `CONTENT_MODEL_*`, `CONTENT_CODE_MODEL_*` | см. `hosted.env.example` | Модели: все роли (основная, второе мнение, ревьюер кода) — Yandex AI Studio, один каталог и один ключ. У каждой роли можно задать свой провайдер, адрес, ключ, лимиты запросов и признак фиксированной оплаты, плюс параметры и цены. Ключи — секреты (hosted.env и Lockbox). NeuralDeep — необязательный вариант, в `hosted.env.example` закомментирован; включать только после поручения на обработку ПДн с ним ([CONTENT_FILTER.md](../../docs/specs/CONTENT_FILTER.md), «NeuralDeep»). `CONTENT_MODEL_PROVIDER=off` (умолчание `compose.yml`) — только правила. При любом другом провайдере обязателен `CONTENT_MODEL_PRIMARY`: без него приложение не запустится |
| `CONTENT_MODEL_DAILY_BUDGET_RUB` | `500` | Бюджет моделей в сутки (UTC, с 03:00 по Москве); дальше только правила и одно письмо вам. Расход хранится в базе, перезапуск и деплой его не обнуляют |
| `EMAIL_SIGNUP_DAILY_PER_SUBNET`, `EMAIL_SIGNUP_DAILY_PER_DOMAIN` | `10`, `20` | Новых полок в сутки из одной сети /24 и с одного почтового домена (кроме крупных публичных). Одноразовые адреса отклоняются всегда |

Аккаунты, созданные оператором (`account:create`, вход по паролю), и все аккаунты, существовавшие до миграции 029, доверенные. Письма и кнопки подписаны ключом из `LINK_KEY`: смена `LINK_KEY` делает недействительными и кнопки в уже отправленных письмах.

```sh
# после правки hosted.env
docker compose --env-file hosted.env up -d
# проверить, что приложение видит настройки
docker compose --env-file hosted.env exec -T app printenv SHARE_MODERATION OPERATOR_EMAIL MODERATION_AUTOPAUSE_REPORTS NEW_ACCOUNT_DAYS NEW_ACCOUNT_MAX_LINKS
```

### Письма и кнопки

Письмо приходит, когда ссылка ждёт проверки, когда фильтр или одна модель отметили ссылку доверенного автора (ссылка работает), на каждую жалобу, при автоматической паузе, при каждой блокировке, за сутки до удаления заблокированного и когда исчерпан дневной бюджет моделей. В письме: работа, тип и профиль страницы, логин автора и возраст аккаунта, причина (жалоба с комментарием, категории фильтра со счётом и словами из списков, ответы моделей) и кнопки. Письмо о сигнале CSAM содержит только идентификаторы, sha256 и что сделано — без названия, текста и кнопки «Посмотреть».

- «Посмотреть» — страница так, как её увидит получатель (песочница, грант на 60 секунд), даже пока ссылка ждёт;
- «Одобрить ссылку»; «Одобрить и доверять автору» — дальше его ссылки открываются без проверки (кроме `SHARE_MODERATION=all`);
- «Снять паузу» — после жалоб;
- «Закрыть ссылку»; «Закрыть и отключить автора» — то же, что `moderation:disable`;
- «Заблокировать» — `blocked`: получатели видят «Ссылка недоступна», содержимое изолируется и удаляется по сроку категории. На странице подтверждения можно отметить «Сохранить как доказательство (legal hold)» и указать основание — тогда удаления нет до снятия.

Кнопка ведёт на `https://polochka.app/moderation#<токен>`. Открытие страницы ничего не меняет (почтовые сканеры открывают ссылки сами): она показывает, что будет сделано, и действие выполняется только нажатием кнопки на странице. Повтор безопасен. Кнопки действуют 7 дней; после этого — скрипты. Каждое действие пишется в лог приложения как `{"event":"moderation.action",...}`.

Если письма не приходят: `docker compose --env-file hosted.env logs app | grep moderation.mail_failed`. Ошибка письма не мешает ссылке и жалобе: очередь всегда видна скриптом `queue`.

### Скрипты

Работают от runtime-роли БД и не печатают токены.

```sh
# ссылки, которые ждут проверки или стоят на паузе: состояние, причина, share id, жалобы, автор, работа
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts queue

# одобрить ссылку (жалобы на неё отмечаются рассмотренными); --trust — ещё и доверять автору
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts approve <shareId> [--trust]

# снять паузу после жалоб
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts unpause <shareId>

# доверять автору без ссылки под рукой
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts trust <логин|почта>

# ссылки, которые ждут только модель (image-unchecked; при SHARE_MODERATION=auto ещё new-account,
# задержанные до перехода на auto): что будет сделано, без изменений
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts recheck --dry-run
# то же всерьёз: непроверенные версии отправляются модели, проверенные решаются сразу
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts recheck

# ссылки, задержанные за фишинг (suspicious, content:fraud): версии перечитываются по текущим
# правилам, ссылки без канала вне страницы открываются; сначала посмотреть, что изменится
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts recheck --fraud --dry-run
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts recheck --fraud
```

`recheck --fraud` нужен один раз после обновления правил фишинга (сентябрь 2026: фишинг только с каналом вне страницы или похожим доменом, [CONTENT_FILTER, «Фишинг»](../../docs/specs/CONTENT_FILTER.md#фишинг)). Команда печатает по строке на ссылку: исход (`released`, `held` с новой причиной, `kept`) и признаки после перечитывания. В журнал пишутся `revision.rescanned` и `share.released`. Повторный запуск ничего не меняет.

Ссылка с причиной `image-unchecked` ждёт модель, а не вас: когда модель проверила версию и ничего не нашла, ссылка открывается сама (в журнале `share.released`, письма нет); если нашла — причина меняется на найденное и приходит письмо. Письмо о такой ссылке при её создании можно не разбирать. `recheck` печатает по строке на ссылку (`released`, `held` с новой причиной, `blocked`, `kept` — ждёт дальше) и итог. Модель не настроена или бюджет исчерпан — изображения ждут, а старые `new-account` без изображений при `auto` открываются. Команду стоит запустить один раз после перехода на `SHARE_MODERATION=auto` и после простоя моделей; она безопасна при повторе.

Жалобы, закрытие ссылки и блокировка:

```sh
# жалобы за 7 дней (или --days N), новые сверху: причина, комментарий, ссылка и открыта ли она,
# работа, владелец, число жалоб на ссылку и на владельца
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts reports --days 7

# закрыть одну ссылку (id из колонки SHARE)
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts revoke-share <shareId>

# заблокировать аккаунт: вход закрыт, сессии завершены, подключения агентов (и OAuth) отозваны, все ссылки закрыты
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts disable <логин|почта> --reason "фишинг"

# снять блокировку; закрытые ссылки и отозванные подключения не возвращаются
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts enable <логин|почта>
```

Комментарии к ссылкам ([COMMENTS](../../docs/specs/COMMENTS.md#модерация)):

```sh
# все комментарии ссылки, скрытые тоже: состояние (open/held/resolved/deleted/author-disabled), жалобы, автор, признаки
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts comments <shareId>

# удалить комментарий: текст и цитата стираются, жалобы на него отмечаются рассмотренными
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts delete-comment <commentId>

# показать всем подозрительный комментарий, который ждёт проверки
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts release-comment <commentId>
```

Подозрительный комментарий нового автора (просит пароль или код рядом с брендом, срочностью или адресом) виден только автору и владельцу работы, пока оператор не решит; о нём и о каждой жалобе на комментарий приходит письмо на `OPERATOR_EMAIL` с этими командами. `disable` скрывает все комментарии и реакции автора (`enable` возвращает).

Фильтр содержимого, блокировки и журнал:

```sh
# заблокировать версию, которую показывает ссылка (категория — для срока хранения)
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts block <shareId> --reason "…" --category drugs [--legal-hold --authority "…"]
# снять блокировку (id ссылки, работы, версии или комментария); удалённое не вернуть
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts unblock <id> --reason "ошибка фильтра"
# удержание по запросу органа: не удалять до снятия
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts legal-hold <id> on --authority "СК, запрос №…"
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts legal-hold <id> off
# данные переданы в полицию: удалить сейчас
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts handed-over <id> --reason "передано в МВД, КУСП №…"
# удалить заблокированное сейчас, не дожидаясь срока
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts purge-artifact <id> --reason "…"
# журнал модерации (по id аккаунта, работы, версии, ссылки, комментария или весь)
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts events [<id>]
# напоминания, удаление по сроку и повтор непроверенных моделью версий (приложение делает это само раз в час)
docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts sweep
# проверить правилами редакционный каталог
docker compose --env-file hosted.env exec -T app node --import tsx scripts/editorial-content-scan.ts
```

`disable` ничего не удаляет: работы и версии остаются, владелец снова видит их после `enable`. Причина `--reason` записывается в журнал модерации (`moderation_events`, команда `events`). `revoke-share` отмечает жалобы на ссылку рассмотренными. Локально те же команды: `npm run moderation:reports`, `moderation:queue`, `moderation:approve`, `moderation:unpause`, `moderation:trust`, `moderation:revoke-share`, `moderation:disable`, `moderation:enable`, `moderation:comments`, `moderation:delete-comment`, `moderation:release-comment`, `moderation:takedown`, `moderation:block`, `moderation:unblock`, `moderation:legal-hold`, `moderation:handed-over`, `moderation:purge-artifact`, `moderation:events`, `moderation:sweep`, `editorial:content-scan`.

### Требование госоргана или правообладателя: порядок на 24 часа

Цель — исполнить за 1–4 часа в рабочее время и не позже 24 часов всегда. После суток провайдер хостинга (Yandex Cloud) обязан ограничить доступ сам и может закрыть весь ресурс.

1. **Проверить подлинность.** Мошенники рассылают письма «от Роскомнадзора». Запись о ресурсе проверяется на [eais.rkn.gov.ru](https://eais.rkn.gov.ru/) и [blocklist.rkn.gov.ru](https://blocklist.rkn.gov.ru/); требование через Yandex Cloud приходит в консоль аккаунта. Правообладатель должен указать, кто он, что нарушено, ссылку Полки и что не разрешал использование (Соглашение, п. 8).
2. **Найти, что закрыть.** Ссылка из требования (`https://polochka.app/s#…`) — это цель для `takedown`. Если указана работа или автор — их id: `moderation:events -- <id>` и `moderation:reports` помогают сопоставить.
3. **Заблокировать** одной командой — она закрывает все ссылки на версию, изолирует содержимое по категории, пишет событие в журнал с основанием и печатает квитанцию:

   ```sh
   docker compose --env-file hosted.env exec -T app node --import tsx scripts/moderation.ts \
     takedown 'https://polochka.app/s#…' --reason "требование о блокировке" \
     --authority "Роскомнадзор, требование №… от …" --category other
   ```

   - правообладатель — `--category copyright` (работа остаётся у автора до решения по его возражению);
   - нужен ли автор: повторное нарушение или тяжёлая категория — `--disable`;
   - орган просит сохранить данные — `--legal-hold` (удаления не будет до `legal-hold <id> off`).
4. **Тот же файл в других местах** закрывать не нужно: стоп-лист SHA-256 не даёт его сохранить снова, а новые ссылки на заблокированную версию не создаются. Уже существующие копии под другими версиями ищите по sha256 из квитанции: `SELECT id FROM revisions WHERE sha256='…'`.
5. **Ответить.** Квитанцию (время UTC, id, что сделано) — в ответ провайдеру хостинга или органу; по ст. 15.3 149-ФЗ — уведомление Роскомнадзору об удалении. Номер требования и ответ сохраните в своём журнале; в `moderation_events` уже есть событие `takedown` с основанием.
6. **Сообщить автору** причину (Соглашение, п. 7), кроме CSAM и случаев, где это вредит расследованию.
7. **CSAM**: не открывать, не скачивать, не пересылать; блокировка и изоляция происходят автоматически. Заявление в МВД — с метаданными из письма и журнала, без файла; после ответа — `handed-over <id>`.

## Мониторинг

Отдельной системы мониторинга не нужно: статус оператора и скрипт внешней проверки с алертами в Telegram или webhook.

- **Статус оператора** — `GET /api/ops/status` с `Authorization: Bearer <OPS_STATUS_TOKEN>`. Задайте `OPS_STATUS_TOKEN` в `hosted.env` (`openssl rand -hex 32`) и примените `docker compose --env-file hosted.env up -d`; без токена маршрута нет (404). Ответ 200 или 503 и проверки:

  | Проверка | Красная, если |
  |---|---|
  | `database` | БД не отвечает |
  | `maintenance` | просроченные сессии или гранты лежат дольше 30 минут: цикл обслуживания остановился или падает раньше очистки |
  | `backup` | самому новому дампу в `BACKUP_BUCKET/postgres/` 26 часов и больше, или дампов нет. Ключу приложения нужно право на листинг этого бакета |
  | `disk` | свободно меньше 10% диска VM |

- **Скрипт внешней проверки** — `npm run ops:uptime` (`node scripts/ci/uptime.mjs`, без зависимостей, Node 20+) с `APP_ORIGIN`, `VIEWER_ORIGIN` и `OPS_STATUS_TOKEN`: приложение и viewer отвечают, TLS-сертификатам больше 14 дней, статус зелёный. Каждая проверка — до трёх попыток с паузой 20 секунд. Код выхода 1 при сбое.
- **Алерты.** Скрипт пишет, когда набор упавших проверок меняется: «не проходит — app health, operator status» и «все проверки снова проходят». Повторных сообщений, пока ничего не изменилось, нет; недоставленное сообщение отправится при следующем запуске. Куда:
  - `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` — бот Telegram (создайте его у @BotFather, напишите ему и возьмите `chat.id` из `https://api.telegram.org/bot<токен>/getUpdates`);
  - `ALERT_WEBHOOK_URL` — `POST {"text": …}` (входящий webhook Slack, Mattermost и совместимых).

  Прошлый результат хранится в `~/.polka-uptime-state.json` (другой путь — `UPTIME_STATE_FILE`). В сообщениях только имена проверок, без ответов сервера.

Запускайте с машины **вне** VM, иначе падение VM никто не заметит. В Yandex Cloud вместо машины подойдёт функция с таймером — [deploy/uptime-function](../uptime-function/README.md). Пример для cron раз в 5 минут (переменные — в файле с правами `600`):

```sh
# /home/ops/polka-uptime.env:
# APP_ORIGIN=https://polka.example.com
# VIEWER_ORIGIN=https://polka-viewer.example.net
# OPS_STATUS_TOKEN=…
# TELEGRAM_BOT_TOKEN=…
# TELEGRAM_CHAT_ID=…
*/5 * * * * cd /home/ops/polka && node --env-file=/home/ops/polka-uptime.env scripts/ci/uptime.mjs >/dev/null 2>&1
```

Для проверки алерта один раз запустите скрипт с заведомо неверным `APP_ORIGIN` и тем же `UPTIME_STATE_FILE` — придёт сообщение о сбое, при следующем обычном запуске — о восстановлении.

### Что видно в статусе о работе процесса

`/api/ops/status` кроме проверок отдаёт блок `runtime` (не влияет на `ok`): `rssMiB` и `heapUsedMiB` приложения, задержка цикла событий за время с прошлого опроса (`eventLoopMs`: mean, p99, max), очередь пула БД (`pool`: total, idle, waiting), слоты воркеров разбора страниц (`workers`: limit, running, waiting) и счётчики (`counters`, например `viewer.check.cached` и `viewer.file.304`). Значения цикла событий и счётчики обнуляются при каждом чтении. Что тревожно: `pool.waiting` выше нуля дольше нескольких опросов, `eventLoopMs.p99` за сотни миллисекунд, `rssMiB` рядом с лимитом контейнера, `workers.waiting` растёт.

Лимиты памяти: app 1,5 ГиБ (куча V8 ограничена `--max-old-space-size=1024`), maintenance 768 МиБ, postgres 1 ГиБ, tmpfs бэкапа 256 МиБ; renderer, если включён, ещё 1,5 ГиБ (лучше на отдельной VM).

## Метрики продукта

Полка сама считает обезличенные события использования (миграция 034, `apps/server/analytics.ts`): без cookies, сторонних скриптов и IP-адресов. Аккаунт в них — только HMAC его id под ключом из `LINK_KEY`; почты, имён, адресов страниц и данных браузера нет.

| Событие | Когда |
|---|---|
| `page_view` | анонимный человек открыл `/`, `/connect`, `/enterprise`, `/pricing`, `/discover` или `/signup` (сервер отдал страницу). Хранятся путь, `?ref=` (латиница, цифры, `._-`, до 40 символов) и домен реферера. Боты, предпросмотры, prefetch, HEAD и вошедшие не считаются |
| `signup_completed` | новая полка: `method` = `email`, `yandex`, `vk`, `oidc`, `password`; источник — `ref` и домен реферера, которые вкладка запомнила при первом заходе (sessionStorage) |
| `agent_connected` | выдан OAuth-доступ (клиент `claude-ai`, `chatgpt`, `codex`, `claude-code`, `other` — по адресу возврата и имени) или первый успешный вызов токена (`token-http`, `token-mcp`); `first` — первое подключение аккаунта |
| `work_saved` | сохранена работа или версия: `via` = `web`, `agent`, `api`; `first` — первая работа полки |
| `share_created` | создана ссылка: `via`, `first` |
| `share_opened` | получатель открыл ссылку: не чаще раза в сутки на ссылку, без получателя; просмотр владельцем и ссылки Редакции не считаются |
| `note_added` | заметка или комментарий (`by` = `owner`/`reader`) |
| `enterprise_request` | заявка с `/enterprise` (только `interest` и `teamSize`) |
| `recipient_cta_view` | гость страницы по ссылке (`/s`) или материала Ленты (`/discover`) увидел подсказку «сделали с ИИ и сохранили на Полку»: `surface` = `bar` (полоса, раз на загрузку) или `card` (карточка); `path` — какая из двух страниц. Только без сессии и с браузерным User-Agent; без получателя, без ссылки и без slug (миграция 035, `apps/server/recipient-cta.ts`) |
| `recipient_cta_click` | нажатие в подсказке: `action` = `try`, `remix`, `copy_phrase`, `yandex`, `email`. Регистрация, начатая оттуда, приходит с источником `ref:share`, `ref:share-remix`, `ref:feed` или `ref:feed-remix` |

Ещё хранится день активности аккаунта (любое действие с сессией или токеном агента) — для удержания. Сырые события и дни активности живут 13 месяцев (служебная очистка), суммарные счётчики по дням — без срока. При удалении аккаунта его события удаляются в той же операции, а цикл обслуживания повторяет это для каждого удалённого аккаунта (очистка и восстановление из копии ключа не знают).

Отчёт:

- **Страница** `https://<домен>/ops/metrics` — спрашивает `OPS_STATUS_TOKEN` (хранит его только во вкладке) и показывает таблицы: воронку по неделям регистрации (посещения → регистрации → подключили агента → первое сохранение → первая ссылка → ссылку открыли) с конверсиями, блок «Получатели → регистрации» (открытия ссылок → показы подсказки → карточка → нажатия по действиям → регистрации с `ref:share`/`ref:share-remix`), источники → регистрации, клиенты агентов, удержание D1/D7/D30 по неделям регистрации, активность по неделям и итоги за всё время. Без токена в конфигурации страницы нет (404).
- **JSON** — `GET /api/ops/metrics?weeks=12` с `Authorization: Bearer <OPS_STATUS_TOKEN>` (1–56 недель); определения метрик — в поле `definitions`.
- **CLI** — `npm run metrics` (или `docker compose --env-file hosted.env exec app npx tsx scripts/metrics.ts`), `-- --weeks 26`, `-- --json`.

Возражение против статистики (политика, раздел 3): `npm run metrics -- forget <id|логин|почта>` удаляет события аккаунта и больше их не записывает.

## Логи

Все сервисы пишут в журнал systemd на VM (драйвер Docker `journald`, `compose.yml`, `x-logging`). Деплой пересоздаёт контейнеры `app` и `maintenance`, и лог `json-file` удалялся бы вместе с контейнером; журнал хоста остаётся. Нужна VM с systemd (Ubuntu, Debian — в том числе образы Yandex Cloud). Первый `up -d` с этой настройкой пересоздаёт все контейнеры, и старые `json-file` логи пропадают один раз.

Содержимое логов не меняется: приложение не пишет адреса страниц, IP-адреса и тела запросов, ошибки — кодом события; у Caddy нет access log и записей `http.log.error` (`Caddyfile`). Размер и срок хранения задаёт journald. Один раз на VM:

```sh
sudo mkdir -p /etc/systemd/journald.conf.d /var/log/journal
printf '[Journal]\nStorage=persistent\nSystemMaxUse=2G\nMaxRetentionSec=30day\n' \
  | sudo tee /etc/systemd/journald.conf.d/polka.conf
sudo systemctl restart systemd-journald
journalctl --disk-usage
```

`Storage=persistent` — журнал на диске, он переживает и перезагрузку VM. Старые записи удаляются, когда журнал больше 2 ГБ или записи старше 30 дней.

Чтение: тег записи — имя контейнера (`polka-hosted-app-1`, `polka-hosted-maintenance-1`, `polka-hosted-caddy-1`, `polka-hosted-backup-1`, `polka-hosted-postgres-1`). Нужен `sudo` или группа `systemd-journal`.

```sh
# app за последние N часов, включая контейнеры до последнего деплоя
sudo journalctl -t polka-hosted-app-1 --since "6 hours ago" -o short-iso
# только события-ошибки приложения (JSON-строки) за сутки
sudo journalctl -t polka-hosted-app-1 --since "24 hours ago" -o cat | grep '^{"event"'
# все сервисы Полки за час, вперемешку по времени
sudo journalctl -t polka-hosted-app-1 -t polka-hosted-maintenance-1 -t polka-hosted-caddy-1 -t polka-hosted-backup-1 --since "1 hour ago"
# следить в реальном времени
sudo journalctl -t polka-hosted-app-1 -f
```

`docker compose --env-file hosted.env logs app` по-прежнему работает, но показывает только текущий контейнер, то есть с последнего деплоя.

## Исходный код изменённой версии

Полка распространяется по [AGPL-3.0](../../LICENSE). § 13 лицензии требует: если вы изменили код и даёте людям пользоваться Полкой по сети, предложите им исходный код именно вашей версии. Для этого в `hosted.env` есть `SOURCE_URL` — https-адрес репозитория или архива с вашими изменениями. Он попадает в ссылку «Открытый код» в подвале каждой страницы и у получателя ссылки, в кнопку «GitHub» в навигации и на главной, в `/llms.txt`, `/connect` и `GET /api/capabilities` (`sourceUrl`). Пусто — ссылка ведёт на исходный репозиторий `https://github.com/artkruglov/polka`; так можно, только если код не менялся.

Если `SOURCE_URL` — репозиторий вида `https://github.com/<owner>/<repo>`, приложение раз в час запрашивает у `api.github.com` число звёзд для кнопки «GitHub» (`GET /api/source/stars`, ответ кэшируется в памяти; при ошибке или другом хостинге — `{"stars":null}`, число показывается от 10). Это единственный исходящий запрос приложения, не связанный с вашими настройками; для него нужен доступ с VM к `api.github.com:443`. Без доступа кнопка остаётся, просто без числа.

```sh
# hosted.env
SOURCE_URL=https://git.example.com/team/polka
```

Держите по этому адресу код той версии, что сейчас запущена. Не хотите публиковать изменения — нужна [коммерческая лицензия](../../COMMERCIAL.md).

## Известные ограничения

- Одна VM, без HA. Для мониторинга есть статус оператора и скрипт проверки (см. «Мониторинг»); расписания и алертов в поставке нет.
- Почта выключена; импорт по ссылке выключен; интерактивный HTML по умолчанию выключен (`HTML_LIVE_MODE=disabled`).
- Caddy без admin API: изменения `Caddyfile` применяются `docker compose --env-file hosted.env restart caddy`.
- Доступ оператора (SSH-ключи, VPN, bastion) и расположение секретов — вне этого репозитория; ведите их в собственном runbook.
