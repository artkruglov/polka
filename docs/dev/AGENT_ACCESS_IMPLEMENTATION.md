# Реализация: доступ агентов к принятому

> **Статус:** план от 01.10.2026, код не писался. Что и зачем — [../specs/AGENT_ACCESS_AND_MEMORY.md](../specs/AGENT_ACCESS_AND_MEMORY.md); схемы — [../specs/DATA_MODELS.md](../specs/DATA_MODELS.md). Пути файлов указаны по результатам чтения репозитория 01.10.2026 и требуют сверки перед работой.

## Порядок и размер

| # | Работа | Размер | Миграция | Основные файлы |
|---|---|---|---|---|
| 1 | `GET /api/v1/works` (`query`, `since`, `cursor`), `since` в `polka_list`; scope `read`, без байтов | S | — | `apps/server/publish-api.ts`, `apps/server/agent-management.ts` (поиск, строка ~248–253), `apps/server/mcp-server.ts` |
| 2 | Ранжирование поиска `ts_rank_cd` с весом заголовка, в рамках одной полки | S | возможно индекс | `apps/server/search-text.ts`, `agent-management.ts` |
| 3 | Правило «автоправка не двигает `pinned` ссылку» | S | 054 `shares.follow_mode` | `apps/server/agent-publish.ts:285–310` |
| 4 | `GET /api/v1/events?after=` над `audit_outbox`, `payload` | S | 055 | `deploy/migrations/001`, `011`, новый маршрут |
| 5 | Карточка полки `tenants.card_md` в `polka_context` | S | 056 | `apps/server/mcp-server.ts`, настройки полки |
| 6 | `owner_account_id`, `accepted_revision_id`, право `curate`, событие `revision.accepted` | S | 057 | `artifacts`, `agent-management.ts`, UI карточки работы |
| 7 | Service account + task-токены | M | 058 | `apps/server/service-auth.ts`, `agent_connections`, `agent-scope.ts` |
| 8 | Поиск по нескольким полкам (после `TEAM_SHELVES=on`) | M | — | `agent-management.ts`, `shelfId` в ответе |
| 9 | Вебхуки (по запросу пилота) | M | 059 | `webhook_subscriptions/deliveries`, защита из `url-import` |

Нумерация миграций рабочая: последняя сейчас 053. Пункты 1–6 не зависят друг от друга, кроме 6 → 4 (событие `revision.accepted`). Пункт 7 выпускается вместе с пилотом полок отделов, раньше при трёх и более запросах на cron/CI с личных полок.

## Принципы реализации

- REST-паритет с MCP: тонкие обёртки над теми же функциями, что вызывает `mcp-server.ts`; схемы в `packages/contracts`; тест, который сверяет список MCP-инструментов с маршрутами.
- Поведение человеческих токенов и MCP не меняем.
- Новые права не выдаются существующим подключениям задним числом (как сделано для `sign_in` в миграции 036).
- Новые таблицы и колонки с персональными данными добавляем в стирание аккаунта (`terminal_erase_account_metadata`, `apps/server/account-erase.ts`).
- `audit_outbox.actor_id NOT NULL` (001): для service account нужна миграция до пункта 7.
- Payload событий и ответы API не содержат содержимого работ и секретов ссылок.

## Тесты

- `GET /works`: токен с `read` видит только свою полку; без `read` 403; ответ без байтов; `since` и `cursor` стабильны.
- Режим ссылки: HTTP-публикация человеком по-прежнему двигает ссылку; service account двигает только `follows`; `pinned` не двигается (`tests/publish-api.test.ts` закрепляет текущее поведение, строка ~455, его править осознанно).
- Service account: уход ответственного замораживает токен через 14 дней; `read`+`share` отклоняются; срок не больше 90 дней.
- События: белый список действий, отсутствие содержимого, порядок курсора.
- Стирание аккаунта: все новые таблицы и колонки покрыты.

## Не проверено перед стартом

- Принимает ли `polka-pull` OAuth-токены со scope `read`.
- Лимит 120 запросов за 10 минут на подключение (по документации).
- Как Enterprise-выгрузка в SIEM читает `audit_outbox`, чтобы не сломать её новым полем `payload` (приватный репозиторий).
- Достаточна ли защита от SSRF из `url-import` для вебхуков.
- Рынок: аккаунт получателя для артефактов Claude, ChatGPT Canvas, коннектор ChatGPT (ручная проверка).
