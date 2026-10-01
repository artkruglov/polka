# Модели данных: доступ агентов к принятому

> **Статус:** предложение от 01.10.2026, миграций нет. Контекст — [AGENT_ACCESS_AND_MEMORY.md](AGENT_ACCESS_AND_MEMORY.md). Номера миграций свободны с 054 (последняя — 053). Имена колонок и таблиц рабочие, при реализации сверять с кодом.

Принципы: все новые колонки допускают NULL или имеют значение по умолчанию; старым работам ничего не проставляем задним числом; новые права не выдаём существующим подключениям; каждую новую таблицу добавляем в стирание аккаунта (`terminal_erase_account_metadata`, `apps/server/account-erase.ts`), иначе упадут тесты удаления.

## 1. Работа: владелец и принятая версия

```sql
ALTER TABLE artifacts
  ADD COLUMN owner_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN accepted_revision_id uuid NULL REFERENCES revisions(id) ON DELETE SET NULL;
```

- `created_by` («кто создал») и `owner_account_id` («кто отвечает») разные: на полке отдела работы принадлежат полке, владелец необязателен.
- `accepted_revision_id = NULL` означает «отметки нет». Старые работы не получают `accepted` автоматически.
- Принимает версию человек с ролью `curator` и выше или токен с правом `curate` (см. [AGENT_ROLES.md](AGENT_ROLES.md)). Принять можно только ревизию этой же работы.
- Публичные ссылки остаются на конкретной ревизии (`shares.revision_id`). «Ссылку на текущую принятую» по умолчанию не делаем.

## 2. Ссылка: режим следования

```sql
ALTER TABLE shares
  ADD COLUMN follow_mode text NOT NULL DEFAULT 'pinned'
    CHECK (follow_mode IN ('pinned','follows'));
```

- `pinned`: ссылка не двигается автоматически (по умолчанию).
- `follows`: включает человек; токен service account может её двигать при новой версии.
- Поведение человеческих токенов и MCP не меняем: HTTP-публикация с `artifactId` и scope `share` двигает ссылку (`agent-publish.ts:285–310`, `linkMoved`); MCP двигает только явным `moveShareId`.

## 3. Service account

```sql
CREATE TABLE service_principals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  responsible_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','disabled')),
  frozen_at       timestamptz NULL,
  created_by      uuid NOT NULL REFERENCES accounts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz NULL
);

ALTER TABLE agent_connections
  ADD COLUMN principal_type text NOT NULL DEFAULT 'human' CHECK (principal_type IN ('human','service')),
  ADD COLUMN service_principal_id uuid NULL REFERENCES service_principals(id) ON DELETE CASCADE;
```

Правила:

- Одна полка на service account.
- Ответственный человек обязателен при создании. Когда он уходит с полки, `status` становится `frozen` и через 14 дней токены перестают работать, если админ не назначил нового ответственного.
- Срок токена не больше 90 дней, ротация. Триггер `revoke_agents_on_leaving` (045) отзывает только человеческие подключения.
- Сочетание прав `read` и `share` запрещено; по умолчанию права только `read` и `capture`.
- `liveConnectionSql` (`apps/server/service-auth.ts`) учитывает `principal_type`.
- Аудит: `audit_outbox.actor_id` сейчас `NOT NULL` (001), для service account нужна миграция (`CHECK` по `actor_type`, либо `service_principal_id` в строке аудита).

## 4. Task-токен

Обобщение `parent_id` из миграции 046 (сейчас 30 минут и только для загрузки проекта).

| Поле | Значение |
|---|---|
| родитель | долгий токен service account (`parent_id`) |
| срок | 5–60 минут |
| область | аудитория `/api/v1`, `folder_ids`, подмножество прав родителя |
| аудит | service account + выдавший ответственный + `task_id` |

Enterprise задаёт политику («только task-токены», предельный срок).

## 5. События

Отдельную таблицу не заводим: читаем `audit_outbox` (001, 011) через белый список действий.

```sql
ALTER TABLE audit_outbox ADD COLUMN payload jsonb NULL;
```

- Действия сейчас: `revision.saved`, `share.published/enabled/approved/revoked/unpaused`, `artifact.moved/trashed/restored/metadata_updated`, `folder.*` (действия `share.created` в аудите нет, оно есть только во внутренних событиях `PolkaEvent`).
- Новые: `owner.changed`, `revision.accepted`.
- `payload` только типизированный и без содержимого работы: тип, id, актор, id ревизии.
- Чтение: `GET /api/v1/events?after=<cursor>`; курсор — `id` записи (`bigserial`). Без `after` лента отдаёт пустой список и текущий конец; `after=0` — с начала истории. Событие видно через 5 секунд после записи, чтобы запись, закоммиченная позже соседей с меньшим номером, не потерялась. Реализовано 01.10.2026: в ленте `revision.saved` и `artifact.metadata_updated/moved/trashed/restored`, права `read`, токен с ограничением по папкам видит только их работы; `payload` пишет пока только `revision.saved` (`artifactId`, `revisionId`, `number`).
- Вебхуки позже: `webhook_subscriptions` и `webhook_deliveries` (подпись HMAC, повторы, `delivery_id`, запрет приватных адресов), только когда пилот потребует push.

## 6. Карточка полки

```sql
ALTER TABLE tenants ADD COLUMN card_md text NULL CHECK (char_length(card_md) <= 8000);
```

Свободный текст куратора («как у нас принято»), отдаётся первым в `polka_context`. Структурированные поля (`purpose`, `audience`, `naming_rules`) не вводим, пока агенты не перестанут следовать свободному тексту.

## 7. Чтение по токену

`GET /api/v1/works` (scope `read`):

| Параметр | Смысл |
|---|---|
| `query` | полнотекстовый поиск внутри полки токена |
| `since` | работы, изменённые после момента |
| `cursor`, `limit` | постраничный вывод |

Ответ как у `polka_list`: id, название, последняя ревизия, `accepted_revision_id`, фрагмент; без байтов, без секретов ссылок. `GET /api/v1/works/:id` отдаёт метаданные и список ревизий. Поиск по нескольким полкам для агента только с явным `allowed_shelf_ids`, проверкой роли на каждой полке и без счётчиков и фрагментов за пределами права; включать после `TEAM_SHELVES=on`.
