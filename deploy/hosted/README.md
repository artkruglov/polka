# Хостинг на одной VM

Пример поставки Полки на одну VM: PostgreSQL на той же машине, внешнее S3-совместимое хранилище с версионированием, TLS через Caddy. Это не HA и не production-сертификация. Ниже `polka.example.com` и `polka-viewer.example.net` — заглушки, подставьте свои домены.

## Состав

| Сервис | Назначение |
|---|---|
| `postgres` | PostgreSQL 16 на VM (volume `pgdata`), внутренняя Docker-сеть и `127.0.0.1:5432` на хосте (никогда не `0.0.0.0`). Роли: `polka_admin` (суперпользователь, только для init), `polka_schema` (владелец схемы, миграции, бэкап), `polka_runtime` (приложение, без DDL) |
| `migrate` → `grants` → `storage-check` | одноразовые шаги при каждом `up`: все миграции (точный набор — в `packages/migrations.ts`, сейчас по 033; 031 — из параллельной ветки), `deploy/runtime-grants.sql`, проверка versioned S3 |
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
curl -s https://polka.example.com/api/editorial | grep -o '"slug"' | wc -l   # 15
docker compose --env-file hosted.env exec -T postgres psql -U polka_admin -d polka -Atc \
  "SELECT slug, derivative_id IS NOT NULL, builder_version FROM editorial_publications WHERE withdrawn_at IS NULL ORDER BY slug"
# 15 строк вида fractions|t|bundle-inline-v6 (или прежняя версия, если производная уже была готова)
```

Первый запуск печатает 15 строк `{"slug":…,"status":"published","version":"interactive"}` (или `replaced`, если до этого были опубликованы статичные снимки). Затем откройте любую карточку `https://polka.example.com/discover`: над работой «Интерактивная версия», iframe с `https://polka-viewer.example.net`, материал реагирует (например, выбор ответа в «Доли без зубрёжки»).

Раз в неделю запускайте ту же команду (share живёт 30 дней, публикация с share, истекающей в ближайшие 7 дней, заменяется свежей копией без перерыва). Вывод — по строке `{"slug":…,"status":…,"version":"interactive"|"static"}`: `published`, `unchanged`, `replaced`, `renewed`; `blocked` (slug занят другим tenant) и `failed` дают exit 1. Откат viewer'а (`HTML_LIVE_MODE=disabled`) сразу скрывает интерактивные публикации; после него запустите ту же команду, и она вернёт статичные снимки (`replaced`, `"version":"static"`). Новые материалы добавляются в `content/editorial/candidates.json`, снимки — `npx tsx scripts/editorial-static-snapshots.ts`; опубликовать только их, не трогая остальные: та же команда с `--only <slug>,<slug>`. Снять материал: `scripts/editorial-publish.ts withdraw --confirm-publication --tenant … --owner … --publication …`.

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

`up -d` заново выполняет миграции и grants, затем перезапускает app. `deploy/runtime-grants.sql` проверяет точный номер последней миграции (точный набор — в `packages/migrations.ts`, сейчас 033): релиз с новой миграцией приносит и обновлённый recipe. Миграции идут одной транзакцией; таймаут на одну команду — `MIGRATION_STATEMENT_TIMEOUT_MS` (по умолчанию 120000). При ошибке job печатает имя файла миграции и SQLSTATE, всё откатывается.

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
- Срок хранения дампов задаёт правило жизненного цикла на `BACKUP_BUCKET`, код их не удаляет. На polochka.app: префикс `postgres/`, удаление через 30 дней, прежние версии — через день (`PutBucketLifecycleConfiguration`, S3 API). Политика обработки данных обещает именно этот срок: меняете правило — меняйте и текст `docs/legal/privacy.md`.
- Внеочередной дамп перед обновлением: `docker compose --env-file hosted.env restart backup` (первый дамп после старта делается сразу).
- Ключ бэкапа: задайте отдельные `BACKUP_S3_ACCESS_KEY`/`BACKUP_S3_SECRET_KEY` с правом только на запись (`PutObject`) в `BACKUP_BUCKET`, без чтения, удаления и доступа к бакету объектов. Если они пусты, используется ключ приложения — это допустимо только временно. Версионирование и, по возможности, object lock/retention на бакете бэкапов защищают дампы от перезаписи.
- `hosted.env` (в том числе `LINK_KEY` и пароли БД) храните в менеджере секретов или офлайн, **не** в бакете бэкапов и не в другом бакете, куда пишет эта установка: иначе утечка одного ключа раскрывает и данные, и все секреты. Потеря `LINK_KEY` ломает все выданные ссылки.
- RPO — до одного интервала бэкапа для метаданных; RTO не измерен. Проверьте восстановление на отдельной VM до того, как полагаться на бэкапы.

## Вход по почте

По умолчанию выключен (`MAIL_MODE=disabled`): аккаунты с паролем выдаёт оператор. С `MAIL_MODE=smtp` вход — по восьмизначному коду из письма. В режиме `EMAIL_SIGNUP=invite` (по умолчанию в этой форме установки) код получают только:

- аккаунты, к которым оператор привязал адрес: `docker compose --env-file hosted.env run --rm app node --import tsx scripts/account-email.ts <логин> <почта>` — вход по коду откроет полку этого аккаунта;
- адреса и домены из `EMAIL_SIGNUP_ALLOW` (`anna@example.com,@team.example.com`) — при первом входе у них появится новая полка.

Остальным форма отвечает так же, но письмо не уходит, поэтому по ней нельзя узнать, кто приглашён. `EMAIL_SIGNUP=open` открывает регистрацию любому адресу.

Отправка через Yandex Cloud Postbox:

1. В консоли Postbox создайте адрес (домен приложения, DKIM «Простой») и добавьте у DNS-провайдера показанные две CNAME-записи DKIM, а также SPF в корне домена (`TXT "v=spf1 include:spf.postbox.yandexcloud.net ~all"`; если SPF уже есть, добавьте `include:spf.postbox.yandexcloud.net` перед `all`) и DMARC (`TXT _dmarc "v=DMARC1;p=none"`). Записи — по [документации Postbox](https://yandex.cloud/ru/docs/postbox/concepts/dns-records). Дождитесь статуса «Success».
2. Сервисный аккаунт с ролью `postbox.sender` и его API-ключ со scope `yc.postbox.send`.
3. В `hosted.env`: `MAIL_MODE=smtp`, `SMTP_HOST=postbox.cloud.yandex.net`, `SMTP_PORT=587`, `SMTP_USER=<ID API-ключа>`, `SMTP_PASS=<секрет API-ключа>`, `MAIL_FROM=no-reply@<APP_HOST>`, затем `docker compose --env-file hosted.env up -d`.

**Домены почты для новых полок.** В этой форме установки `EMAIL_SIGNUP_DOMAINS=ru-only`: новую полку по коду можно открыть только на адресах Яндекса, Mail.ru, Рамблера, VK и на домене самой установки. Причина — ч. 10 ст. 8 149-ФЗ. Существующие аккаунты на других доменах входят по коду, пока `EMAIL_LOGIN_DOMAINS=any`. Подробности — [SIGN_IN_PROVIDERS.md](../../docs/specs/SIGN_IN_PROVIDERS.md).

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

**Доступ компании:** `ORG_DOMAINS=company.ru=<id библиотеки шаблонов>:reader`. Сотрудник с подтверждённой почтой `@company.ru`, вошедший через Яндекс ID (у Яндекс 360 это аккаунт организации), становится читателем библиотеки. Исключённого администратором домен обратно не добавит.

После изменения — `docker compose --env-file hosted.env up -d`.

## Комментарии

`COMMENTS_MODE=owner-notes` (по умолчанию здесь):
- к работе пишет только её владелец и его агент — это заметки к фрагментам;
- получатели ссылки их читают, но не отвечают;
- реакций и писем нет;
- комментарии получателей, оставленные раньше, скрыты, но не удалены.

Другие значения:
- `on` — комментарии получателей ([COMMENTS.md](../../docs/specs/COMMENTS.md));
- `off` — обсуждений нет вовсе.

## Модерация

Правила — [docs/specs/ABUSE_PROTECTION.md](../../docs/specs/ABUSE_PROTECTION.md) (доверие, жалобы, письма) и [docs/specs/CONTENT_FILTER.md](../../docs/specs/CONTENT_FILTER.md) (фильтр запрещённого содержимого, модели, блокировка, изоляция и удаление). Отдельной админки нет: оператор получает письма с кнопками только о том, что отметила автоматика, и о жалобах, а без почты пользуется скриптами ниже.

### Настройки

В `hosted.env` (все передаются через `compose.yml`):

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
| `CONTENT_MODEL_*`, `CONTENT_CODE_MODEL_*` | см. `hosted.env.example` | Модели: основная и ревьюер кода — NeuralDeep (только модели из `CONTENT_MODEL_ND_ALLOWED`, на его оборудовании в России), второе мнение и запасная — Yandex AI Studio; у каждой роли свой провайдер, адрес, ключ, лимиты запросов и признак фиксированной оплаты, плюс параметры и цены. Ключи — секреты (hosted.env и Lockbox). До включения NeuralDeep — поручение на обработку ПДн с ним ([CONTENT_FILTER.md](../../docs/specs/CONTENT_FILTER.md), «NeuralDeep»). `CONTENT_MODEL_PROVIDER=off` — только правила |
| `CONTENT_MODEL_DAILY_BUDGET_RUB` | `500` | Бюджет моделей в сутки; дальше только правила и одно письмо вам |
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
```

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

Внешней системы алертов в репозитории нет. Есть то, что к ней подключается:

- **Статус оператора** — `GET /api/ops/status` с `Authorization: Bearer <OPS_STATUS_TOKEN>`. Задайте `OPS_STATUS_TOKEN` в `hosted.env` (`openssl rand -hex 32`) и примените `docker compose --env-file hosted.env up -d`; без токена маршрута нет (404). Ответ 200 или 503 и проверки:

  | Проверка | Красная, если |
  |---|---|
  | `database` | БД не отвечает |
  | `maintenance` | просроченные сессии или гранты лежат дольше 30 минут: цикл обслуживания остановился или падает раньше очистки |
  | `backup` | самому новому дампу в `BACKUP_BUCKET/postgres/` 26 часов и больше, или дампов нет. Ключу приложения нужно право на листинг этого бакета |
  | `disk` | свободно меньше 10% диска VM |

- **Скрипт внешней проверки** — `node scripts/ci/uptime.mjs` с `APP_ORIGIN`, `VIEWER_ORIGIN` и `OPS_STATUS_TOKEN`: приложение и viewer отвечают, TLS-сертификатам больше 14 дней, статус зелёный. Код выхода 1 при сбое. Запускайте его по расписанию с машины вне VM (cron, любой uptime-сервис с проверкой HTTP-кода статуса).

## Исходный код изменённой версии

Полка распространяется по [AGPL-3.0](../../LICENSE). § 13 лицензии требует: если вы изменили код и даёте людям пользоваться Полкой по сети, предложите им исходный код именно вашей версии. Для этого в `hosted.env` есть `SOURCE_URL` — https-адрес репозитория или архива с вашими изменениями. Он попадает в ссылку «Открытый код» в подвале каждой страницы и у получателя ссылки, в `/llms.txt`, `/connect` и `GET /api/capabilities` (`sourceUrl`). Пусто — ссылка ведёт на исходный репозиторий `https://github.com/artkruglov/polka`; так можно, только если код не менялся.

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
