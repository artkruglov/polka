# Документация Полки

Если вы здесь впервые, начните с [README](../README.md), затем прочитайте [архитектуру](architecture.md) и [состояние](status.md).

## Пользователю

| Документ | О чём |
|---|---|
| [connect-agents.md](connect-agents.md) | Как подключить Claude.ai, ChatGPT, Claude Code, Codex, скрипты и CI |
| [faq.md](faq.md) | Лимиты, сеть, отзыв ссылок, почему ссылки Claude/ChatGPT не импортируются |
| [MCP_CONNECTOR.md](MCP_CONNECTOR.md) | Коннектор для Claude.ai и ChatGPT: OAuth 2.1, разрешения, отзыв, приёмка |
| [legal/privacy.md](legal/privacy.md), [legal/terms.md](legal/terms.md) | Черновики политики обработки данных и пользовательского соглашения для polochka.app (не проверены юристом) |
| [PUBLISH_API.md](PUBLISH_API.md) | HTTP API: публикация, статус, проекты, ссылка для входа; ошибки, лимиты, CLI |
| [legal/bot.md](legal/bot.md) | PolkaRenderer: что делает робот Полки и как запретить его в robots.txt |

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
| [ops/google-oauth-setup.md](ops/google-oauth-setup.md) | Вход через Google: настройка клиента в Google Cloud Console |
| [EDITORIAL_CHECKLIST.md](EDITORIAL_CHECKLIST.md) | Чек-лист материала «Ленты» перед публикацией |
| [../CHANGELOG.md](../CHANGELOG.md) | История изменений |

## Спецификации

Контракты отдельных частей. У каждой в начале стоит статус: **реализовано** (код соответствует документу), **в коде** (реализовано, но выключено по умолчанию или не на polochka.app), **контракт** (действующие требования) или **историческое** (контекст решений, на текущий код не распространяется). В спецификациях сохранены протоколы приёмки со старыми номерами схемы. Текущее состояние смотрите в [status.md](status.md).

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
| [specs/SHELF_SNAPSHOT.md](specs/SHELF_SNAPSHOT.md) | в коде | Снимок полки на дату: `GET /api/v1/snapshot` |
| [specs/POSITIONING.md](specs/POSITIONING.md) | с 02.10.2026 | Позиционирование «Полка хранит принятое»: тезисы, аудитории, что говорить и что нет |
| [specs/AGENT_ACCESS_AND_MEMORY.md](specs/AGENT_ACCESS_AND_MEMORY.md) | в коде (частично) | Полка хранит принятое, Drive — рабочее; чтение агентом, лента событий, карточка полки, принятая версия, service accounts, поиск по полкам. Схемы — [DATA_MODELS](specs/DATA_MODELS.md), роли — [AGENT_ROLES](specs/AGENT_ROLES.md), порядок работ — [dev/AGENT_ACCESS_IMPLEMENTATION](dev/AGENT_ACCESS_IMPLEMENTATION.md) |
| [specs/COMPANY_TEMPLATE_LIBRARY.md](specs/COMPANY_TEMPLATE_LIBRARY.md) | реализовано | Библиотеки шаблонов: роли, приглашения, журнал |
| [specs/SELF_HOST_BASE_SPEC.md](specs/SELF_HOST_BASE_SPEC.md) | реализовано | Health, readiness, maintenance |
| [specs/RESTORE_DRILL_SPEC.md](specs/RESTORE_DRILL_SPEC.md) | реализовано | Совместное восстановление БД и объектов |
| [specs/URL_IMPORT_SUPPORT.md](specs/URL_IMPORT_SUPPORT.md) | в коде, эксперимент | Импорт по URL, таблица источников и рендерер: выключены по умолчанию и на polochka.app, в веб-интерфейсе поля для ссылки нет |
| [specs/SAVED_LINKS.md](specs/SAVED_LINKS.md) | реализовано | «Сохранить как ссылку»: работа-закладка |
| [specs/SIGN_IN_PROVIDERS.md](specs/SIGN_IN_PROVIDERS.md) | реализовано | Яндекс ID, VK ID, Google, свой OIDC; почтовые домены; временные полки, объединение, ссылка для входа от агента |
| [specs/ABUSE_PROTECTION.md](specs/ABUSE_PROTECTION.md) | реализовано | Доверие к аккаунту, лимиты новых аккаунтов, жалобы, автопауза, письма оператору |
| [specs/CONTENT_FILTER.md](specs/CONTENT_FILTER.md) | реализовано | Фильтр запрещённого содержимого, модели, фишинг, журнал модерации |
| [specs/COMMENTS.md](specs/COMMENTS.md) | в коде | Комментарии и реакции получателей (на polochka.app — только заметки владельца) |
| [specs/CONTENT_SEARCH.md](specs/CONTENT_SEARCH.md) | реализовано | Поиск по тексту работ |
| [specs/PROJECTS.md](specs/PROJECTS.md) | реализовано | Проекты: папка связанных страниц одной работой |
| [specs/TEAM_SHELVES.md](specs/TEAM_SHELVES.md) | в коде | Полки отделов: участники и роли, агенты по полкам, администратор компании (`TEAM_SHELVES=off` по умолчанию) |
| [specs/EXTENSIONS.md](specs/EXTENSIONS.md) | реализовано | Точки расширения открытого ядра |
| [specs/SHELF_COVERS.md](specs/SHELF_COVERS.md) | реализовано | Обложки на полке (снимки экрана — по флагу) |
| [specs/ONBOARDING_V2.md](specs/ONBOARDING_V2.md) | реализовано | Первый запуск: `/start` и чек-лист на полке |
| [specs/RECIPIENT_CONVERSION.md](specs/RECIPIENT_CONVERSION.md) | реализовано | Подсказка гостю у получателя и в «Ленте» завести свою полку |
| [specs/DISCOVER_V2.md](specs/DISCOVER_V2.md) | историческое | Название «Лента» (сделано); остальное — предложение |
| [specs/ACCOUNT_DELETION_SPEC.md](specs/ACCOUNT_DELETION_SPEC.md) | контракт | Удаление аккаунта и очистка данных |
| [specs/PRODUCT.md](specs/PRODUCT.md) | контракт | Для кого продукт, границы, словарь |
| [specs/REQUIREMENTS.md](specs/REQUIREMENTS.md) | контракт | Требования R01–R20 |
| [specs/DECISIONS.md](specs/DECISIONS.md) | журнал | Принятые решения, последнее — 26.09.2026 |
| [specs/ONBOARDING_SPEC.md](specs/ONBOARDING_SPEC.md) | историческое | Первый вход и первый результат |
| [specs/CLAUDE_IMPORT_EXPERIMENT.md](specs/CLAUDE_IMPORT_EXPERIMENT.md) | историческое | Почему ссылки Claude нельзя забрать сервером |
| [research/HEADLESS_PUBLIC_LINKS.md](research/HEADLESS_PUBLIC_LINKS.md) | исследование | Серверный headless-рендер публичных ссылок AI-продуктов |

## Прочее

- [screenshots/](screenshots/) — снимки polochka.app для README, [assets/](assets/) — логотип и картинка для соцсетей, [assets/og/](assets/og/) — исходники карточек превью ссылок (`node scripts/render-og-images.mjs`). Перерисовка снимков: `node scripts/render-readme-assets.mjs`.
- `reviews/2026-09-2*-editorial-*` — протоколы приёмки материалов «Ленты». На них ссылаются манифесты каталога (`evidencePath`), поэтому они остаются в репозитории. Остальные протоколы ревью и снимки дизайна (`docs/reviews/**`, `docs/design/**`) удалены 27.09.2026 и хранятся в приватном архиве оператора.

## Правила

1. Поведение меняется вместе с документом: пользовательские инструкции, `status.md` и нужная спецификация обновляются в том же pull request.
2. «В коде», «работает на polochka.app» и «проверено вручную с настоящим клиентом» — это разные статусы.
3. Новый план не пишется параллельным документом: этапы живут в [roadmap.md](roadmap.md), решения — в [specs/DECISIONS.md](specs/DECISIONS.md).
