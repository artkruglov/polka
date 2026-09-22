# Документация Полки

Если вы здесь впервые, начните с [README](../README.md), затем прочитайте [архитектуру](architecture.md) и [состояние](status.md).

## Пользователю

| Документ | О чём |
|---|---|
| [connect-agents.md](connect-agents.md) | Как подключить Claude.ai, ChatGPT, Claude Code, Codex, скрипты и CI |
| [faq.md](faq.md) | Лимиты, сеть, отзыв ссылок, почему ссылки Claude/ChatGPT не импортируются |
| [MCP_CONNECTOR.md](MCP_CONNECTOR.md) | Коннектор для Claude.ai и ChatGPT: OAuth 2.1, разрешения, отзыв, приёмка |
| [PUBLISH_API.md](PUBLISH_API.md) | `POST /api/v1/publish`, `GET /api/v1/status/:id`, ошибки, CLI |

## Разработчику и оператору

| Документ | О чём |
|---|---|
| [architecture.md](architecture.md) | Что где работает, данные, путь страницы к получателю, границы доверия |
| [local-development.md](local-development.md) | Локальный запуск, тесты, интерактивный режим, почта, restore drill |
| [status.md](status.md) | Одна таблица: что работает, что в коде, чего нет |
| [roadmap.md](roadmap.md) | Этапы: что сделано и что дальше |
| [deploy/BASE.md](../deploy/BASE.md) | Базовая самостоятельная установка: образ, PostgreSQL, S3, роли БД |
| [deploy/hosted/README.md](../deploy/hosted/README.md) | Установка на одну VM с Caddy, как polochka.app |
| [deploy/RESTORE.md](../deploy/RESTORE.md) | Восстановление из резервной копии |
| [../CHANGELOG.md](../CHANGELOG.md) | История изменений |

## Спецификации

Контракты отдельных частей. У каждой в начале стоит статус: **реализовано** (код соответствует документу), **контракт** (действующие требования) или **историческое** (контекст решений, на текущий код не распространяется). В спецификациях сохранены протоколы приёмки со старыми номерами схемы. Текущее состояние смотрите в [status.md](status.md).

| Документ | Статус | О чём |
|---|---|---|
| [BUNDLE_INLINE_SPEC.md](BUNDLE_INLINE_SPEC.md) | реализовано | Сборка интерактивной производной, React runtime |
| [LIVE_VIEWER_SPEC.md](LIVE_VIEWER_SPEC.md) | историческое | Первый локальный эксперимент изолированного viewer; текущее — HOSTED_VIEWER_DELTA |
| [HOSTED_VIEWER_DELTA.md](HOSTED_VIEWER_DELTA.md) | реализовано | Viewer на отдельном домене в hosted-установке |
| [FRONTEND_COMPONENT_SYSTEM.md](FRONTEND_COMPONENT_SYSTEM.md) | реализовано | Слои и компоненты интерфейса |
| [specs/BUNDLE_SPEC.md](specs/BUNDLE_SPEC.md) | реализовано | Manifest и пакет файлов |
| [specs/MCP_IMPLEMENTATION_SPEC.md](specs/MCP_IMPLEMENTATION_SPEC.md) | реализовано | MCP-сервер: транспорт, авторизация, инструменты |
| [specs/MCP_ONBOARDING_SPEC.md](specs/MCP_ONBOARDING_SPEC.md) | реализовано | Выдача токена на странице «Агенты» |
| [specs/TRASH_SPEC.md](specs/TRASH_SPEC.md) | реализовано | Корзина и восстановление |
| [specs/AGENT_CONTEXT_TEMPLATES.md](specs/AGENT_CONTEXT_TEMPLATES.md) | реализовано | Контекст для агента и закреплённые шаблоны |
| [specs/COMPANY_TEMPLATE_LIBRARY.md](specs/COMPANY_TEMPLATE_LIBRARY.md) | реализовано | Библиотеки шаблонов: роли, приглашения, журнал |
| [specs/SELF_HOST_BASE_SPEC.md](specs/SELF_HOST_BASE_SPEC.md) | реализовано | Health, readiness, maintenance |
| [specs/RESTORE_DRILL_SPEC.md](specs/RESTORE_DRILL_SPEC.md) | реализовано | Совместное восстановление БД и объектов |
| [specs/URL_IMPORT_SUPPORT.md](specs/URL_IMPORT_SUPPORT.md) | реализовано | Импорт по URL (выключен по умолчанию) |
| [specs/ACCOUNT_DELETION_SPEC.md](specs/ACCOUNT_DELETION_SPEC.md) | контракт | Удаление аккаунта и очистка данных |
| [specs/PRODUCT.md](specs/PRODUCT.md) | контракт | Для кого продукт, границы, словарь |
| [specs/REQUIREMENTS.md](specs/REQUIREMENTS.md) | контракт | Требования R01–R20 |
| [specs/DECISIONS.md](specs/DECISIONS.md) | историческое | Журнал решений |
| [specs/ONBOARDING_SPEC.md](specs/ONBOARDING_SPEC.md) | историческое | Первый вход и первый результат |
| [specs/CLAUDE_IMPORT_EXPERIMENT.md](specs/CLAUDE_IMPORT_EXPERIMENT.md) | историческое | Почему ссылки Claude нельзя забрать сервером |

## Прочее

- [screenshots/](screenshots/) — снимки polochka.app для README.
- `reviews/2026-09-2*-editorial-*` — протоколы приёмки материалов «Интересного». На них ссылаются манифесты каталога (`evidencePath`), поэтому они остаются в репозитории.

## Правила

1. Поведение меняется вместе с документом: пользовательские инструкции, `status.md` и нужная спецификация обновляются в том же pull request.
2. «В коде», «работает на polochka.app» и «проверено вручную с настоящим клиентом» — это разные статусы.
3. Новый план не пишется параллельным документом: этапы живут в [roadmap.md](roadmap.md), решения — в [specs/DECISIONS.md](specs/DECISIONS.md).
