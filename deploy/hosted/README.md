# Hosted pilot: одна VM

Ограниченная пилотная поставка на одной VM. Это не HA и не production-сертификация. Сейчас работает `https://polochka.app` (Yandex Cloud, ru-central1).

## Состав

| Сервис | Назначение |
|---|---|
| `postgres` | PostgreSQL 16 на VM (volume `pgdata`), слушает только внутреннюю Docker-сеть. Роли: `polka_admin` (суперпользователь, только для init), `polka_schema` (владелец схемы, миграции, бэкап), `polka_runtime` (приложение, без DDL) |
| `migrate` → `grants` → `storage-check` | одноразовые шаги при каждом `up`: миграции 001–026, `deploy/runtime-grants.sql`, проверка versioned S3 |
| `app` | приложение, `HTML_LIVE_MODE=disabled` (статический HTML в sandbox) |
| `maintenance` | очистка истёкших загрузок, сессий, грантов |
| `caddy` | TLS (Let's Encrypt, автоматически), без access log |
| `backup` | `pg_dump` раз в сутки в `polka-staging-backups/postgres/` |

Объекты хранятся в приватном versioned-бакете `polka-staging-objects`. Интерактивный HTML выключен, пока нет отдельного домена viewer (например, `polochka.page`); см. [HOSTED_VIEWER_DELTA](../../docs/HOSTED_VIEWER_DELTA.md).

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
- Почта выключена; интерактивный HTML выключен; импорт по ссылке выключен.
