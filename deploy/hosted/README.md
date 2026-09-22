# Hosted pilot: одна VM

Ограниченная пилотная поставка на одной VM. Это не HA и не production-сертификация. Сейчас работает `https://polochka.app` (Yandex Cloud, ru-central1).

## Состав

| Сервис | Назначение |
|---|---|
| `postgres` | PostgreSQL 16 на VM (volume `pgdata`), внутренняя Docker-сеть и `127.0.0.1:5432` на хосте (никогда не `0.0.0.0`). Роли: `polka_admin` (суперпользователь, только для init), `polka_schema` (владелец схемы, миграции, бэкап), `polka_runtime` (приложение, без DDL) |
| `migrate` → `grants` → `storage-check` | одноразовые шаги при каждом `up`: миграции 001–026, `deploy/runtime-grants.sql`, проверка versioned S3 |
| `app` | приложение: app listener `127.0.0.1:4390`, viewer listener `127.0.0.1:4391` (только при `HTML_LIVE_MODE=production`); `network_mode: host` |
| `maintenance` | очистка истёкших загрузок, сессий, грантов; `network_mode: host` |
| `caddy` | TLS (Let's Encrypt, автоматически) для `APP_HOST` и `VIEWER_HOST_NAME`, без access log и admin API; `network_mode: host`, единственный публичный listener (80/443) |
| `backup` | `pg_dump` раз в сутки в `polka-staging-backups/postgres/` |

Объекты хранятся в приватном versioned-бакете `polka-staging-objects`. Интерактивный HTML включается `HTML_LIVE_MODE=production` и работает только на отдельном registrable domain viewer (`VIEWER_HOST_NAME=polochka.page`); по умолчанию `disabled`. Контракт: [HOSTED_VIEWER_DELTA](../../docs/HOSTED_VIEWER_DELTA.md).

`app`, `maintenance`, `storage-check` и `caddy` работают в сети хоста: `viewer-config.ts` требует loopback listeners, а Caddy проксирует на `127.0.0.1`. Поэтому на VM порты 4390/4391/5432 должны быть свободны и закрыты извне (они и так слушают только loopback), а в security group открыты только 22/80/443 (TCP) и 443/UDP для HTTP/3 по желанию.

## Первый запуск

```sh
git clone https://github.com/artkruglov/polka.git /opt/polka && cd /opt/polka
git checkout <commit>
docker build -t polka:<short-commit> .
cp deploy/hosted/hosted.env.example deploy/hosted/hosted.env && chmod 600 deploy/hosted/hosted.env
# заполнить: пароли `openssl rand -hex 24`, LINK_KEY `openssl rand -hex 32`, S3-ключ, POLKA_IMAGE
cd deploy/hosted && docker compose --env-file hosted.env up -d
```

DNS: A-запись домена на IP VM, **без** прокси CDN (Cloudflare «DNS only»): CDN видел бы токены агентов и мог бы менять HTML.

Аккаунт (регистрация по почте выключена, пока нет SMTP):

```sh
printf '%s' "$PASSWORD" | docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/account.ts <login>
```

## Редакционный каталог («Интересное»)

Каталог наполняет `scripts/editorial-seed-hosted.ts` из `content/editorial/static-candidates.json` (в образе). Версию он выбирает по `HTML_LIVE_MODE` контейнера, то есть так же, как app:

- `production`: оригинал `content/editorial/<slug>/index.html` сохраняется однофайловым пакетом, собирается live-builder'ом (bundle-inline v4; принимаются готовые v4/v3), share и публикация привязываются к готовой производной. Получатель и карточки `/discover` открывают интерактивную версию сразу. [Evidence](../../docs/reviews/2026-09-22-editorial-live/README.md).
- `disabled` (или флаг `--static-only`): статичный снимок `content/editorial/<slug>/static/index.html` ([evidence](../../docs/reviews/2026-09-22-editorial-static/README.md)).

Замена одной версии на другую идёт одной транзакцией (`replaced`), каталог не пустеет. Если производную собрать нельзя, у slug остаётся (или публикуется) статичный снимок: строка `"version":"static"` в stdout, причина в stderr (`"fallback":"static"`).

Один раз создать редакционный аккаунт (пароль генерируется на VM и хранится только у оператора):

```sh
cd /opt/polka/deploy/hosted
umask 077 && openssl rand -base64 24 > /root/polka-redakciya.pw
docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/account.ts redakciya < /root/polka-redakciya.pw
```

Перевести каталог на интерактивные версии: сначала развернуть образ с этим коммитом (раздел «Обновление»), убедиться, что включён viewer (`curl -s https://polochka.app/api/capabilities` → `"liveMode":"production"`), затем:

```sh
cd /opt/polka/deploy/hosted
docker compose --env-file hosted.env run --rm -T --no-deps app \
  node --import tsx scripts/editorial-seed-hosted.ts --confirm-publication --login redakciya
curl -s https://polochka.app/api/editorial | grep -o '"slug"' | wc -l   # 12
docker compose --env-file hosted.env exec -T postgres psql -U polka_admin -d polka -Atc \
  "SELECT slug, derivative_id IS NOT NULL, builder_version FROM editorial_publications WHERE withdrawn_at IS NULL ORDER BY slug"
# 12 строк вида fractions|t|bundle-inline-v4
```

Первый запуск печатает 12 строк `{"slug":…,"status":"replaced","version":"interactive"}`. Затем открыть в браузере любую карточку `https://polochka.app/discover`: над работой «Интерактивная версия», iframe с `https://polochka.page`, материал реагирует (например, выбор ответа в «Доли без зубрёжки»).

Раз в неделю запускать ту же команду (share живёт 30 дней, публикация с share, истекающей в ближайшие 7 дней, заменяется свежей копией без перерыва). Вывод — по строке `{"slug":…,"status":…,"version":"interactive"|"static"}`: `published`, `unchanged`, `replaced`, `renewed`; `blocked` (slug занят другим tenant) и `failed` дают exit 1. Откат viewer'а (`HTML_LIVE_MODE=disabled`) сразу скрывает интерактивные публикации; после него запустите ту же команду, и она вернёт статичные снимки (`replaced`, `"version":"static"`). Снять материал: `scripts/editorial-publish.ts withdraw --confirm-publication --tenant … --owner … --publication …`.

## Интерактивный viewer (`polochka.page`)

Viewer vhost в `Caddyfile`: только `127.0.0.1:4391` с фиксированным `Host: 127.0.0.1:4391` (иначе `live-viewer.ts` отвечает 404), удаляет `Cookie`/`Authorization` из запроса и `Set-Cookie`/`X-Frame-Options` из ответа, `Cache-Control: no-store`, HSTS, без access log. HTTP viewer запрос обрывается без редиректа (capability не попадает в `Location`); HTTP app редиректится на HTTPS. Host, не совпадающий с SNI, получает 421; неизвестный SNI не получает сертификата; неизвестный Host на :80 обрывается.

Включение:

1. A-запись `polochka.page` → IP VM (DNS only, без CDN). Проверить: `dig +short polochka.page`.
2. В `hosted.env`: `VIEWER_HOST_NAME=polochka.page` (обязателен с этой версии compose даже при `disabled`), новый `POLKA_IMAGE`, пока `HTML_LIVE_MODE=disabled`.
3. `docker compose --env-file hosted.env up -d` — пересоздаёт app/maintenance/caddy в сети хоста, публикует postgres на loopback. Caddy выпускает сертификат для обоих доменов: `docker compose --env-file hosted.env logs caddy | grep -E 'certificate obtained|error'`.
4. Проверить TLS viewer до включения: `curl -sI https://polochka.page/` → 502 (viewer listener ещё не поднят) с HSTS и `no-store`, без `Set-Cookie`, `curl -sI http://polochka.page/document/x` → обрыв соединения, без `Location`.
5. `HTML_LIVE_MODE=production` в `hosted.env`, затем `docker compose --env-file hosted.env up -d`. В логах app: `Experimental production HTML viewer is enabled.`; `curl -s https://polochka.app/api/capabilities` → `"liveMode":"production"`, `"htmlRuntime":false`.
6. Пройти acceptance из [HOSTED_VIEWER_DELTA](../../docs/HOSTED_VIEWER_DELTA.md#acceptance-что-именно-записать) и записать результат.

**Откат:** `HTML_LIVE_MODE=disabled` в `hosted.env` и `docker compose --env-file hosted.env up -d`. Viewer listener не поднимается, выданные ранее capability URL перестают читаться сразу (флаг проверяется при каждом чтении), статический HTML, скачивание и экспорт не меняются. Производные (`revision_derivatives`) остаются в БД и снова используются после включения.

## Обновление

```sh
cd /opt/polka && git fetch && git checkout <new-commit>
docker build -t polka:<new-short> .
sed -i 's/^POLKA_IMAGE=.*/POLKA_IMAGE=polka:<new-short>/' deploy/hosted/hosted.env
cd deploy/hosted && docker compose --env-file hosted.env up -d
```

`up -d` заново выполняет миграции и grants, затем перезапускает app. Если новая версия добавляет миграцию, сначала обновите `deploy/runtime-grants.sql` (он проверяет точный номер последней миграции).

## Откат

- **Без новых миграций:** вернуть прежний `POLKA_IMAGE` и `docker compose up -d`.
- **С миграцией:** откатывать только бинарник нельзя. Остановите `app`/`maintenance`, восстановите дамп, сделанный перед обновлением (`pg_restore --clean` от `polka_schema` в пустую БД), затем поднимите прежний образ. Объекты S3 версионированы и не удаляются при откате. Процедура согласования БД/объектов — [deploy/RESTORE.md](../RESTORE.md).

## Бэкапы и секреты

- Дамп БД: ежедневно, `s3://polka-staging-backups/postgres/polka-<UTC>.dump`. Перед обновлением сделайте внеочередной: `docker compose --env-file hosted.env exec backup sh -c 'pg_dump -Fc -d "$BACKUP_DATABASE_URL" -f /tmp/x.dump'` или просто перезапустите `backup`.
- `hosted.env` (включая `LINK_KEY`) лежит на VM и копией в `s3://polka-staging-backups/secrets/hosted.env`. Потеря `LINK_KEY` ломает все выданные ссылки.
- RPO сейчас до 24 часов для метаданных; RTO не измерен. Проверка восстановления на отдельной VM ещё не проводилась.

## Доступ оператора

Порт 22 открыт только для ключа `polka_yc_ed25519`. Если SSH недоступен из сети оператора (VPN), команды выполняются через ops-агент на VM: скрипт кладётся в `s3://polka-staging-ops/inbox/`, результат появляется в `outbox/`. Агент выполняет скрипты от root; доступ к бакету равен root-доступу к VM.

## Известные ограничения пилота

- Одна VM, динамический внешний IP (квота статических адресов исчерпана): после stop/start IP меняется, нужно обновить A-запись.
- Нет мониторинга и алертов, кроме healthcheck контейнеров.
- Почта выключена; импорт по ссылке выключен; интерактивный HTML по умолчанию выключен (`HTML_LIVE_MODE=disabled`).
- Caddy без admin API: изменения `Caddyfile` применяются `docker compose restart caddy`.
