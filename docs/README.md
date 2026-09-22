# Документация Полки

**Передача релиза Claude:** [GitHub, production-блокеры и порядок запуска](CLAUDE_RELEASE_HANDOFF.md).

Актуальная редакция: 21 сентября 2026. Начните с продукта, затем состояния и дорожной карты. Архивные документы не задают текущий scope.

| Документ | За что отвечает |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Для кого продукт, ценность, jobs, границы MVP, словарь |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Требования и критерии приёмки с идентификаторами R01–R20 |
| [STATUS.md](STATUS.md) | Что действительно работает; что только нарисовано; текущие проверки |
| [UX.md](UX.md) | Карта экранов, навигация, единый дизайн и отсутствующие состояния |
| [ONBOARDING_SPEC.md](ONBOARDING_SPEC.md) | Регистрация, первый результат и мастер MCP: детальные истории |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Хранение, API, агенты, HTML, данные и границы доверия |
| [ROADMAP.md](ROADMAP.md) | Единственный актуальный порядок разработки и условия выпуска |
| [BUNDLE_SPEC.md](BUNDLE_SPEC.md) | Manifest, текущее хранение одиночного HTML и следующий multi-file capture |
| [LIVE_VIEWER_SPEC.md](LIVE_VIEWER_SPEC.md) | Контракт локального live HTML эксперимента и незакрытые риски hosted |
| [MODEL_WORKFLOW.md](MODEL_WORKFLOW.md) | Модели, делегирование, ревью и пакеты исполнения дорожной карты |
| [LAUNCH.md](LAUNCH.md) | Облако, ёмкость, эксплуатация, open source и запуск |
| [CONTENT.md](CONTENT.md) | Стартовая коллекция и правила авторства |
| [ACCOUNT_DELETION_SPEC.md](ACCOUNT_DELETION_SPEC.md) | Контракт R17: отзыв доступа, удаление данных и ограничения резервных копий; revoke принят локально, полный purge в разработке |
| [SELF_HOST_BASE_SPEC.md](SELF_HOST_BASE_SPEC.md) | Readiness, maintenance и критерии локальной/контейнерной поставки |
| [research/COLD_START_PROMPT.md](research/COLD_START_PROMPT.md) | Готовый промпт для отдельного исследования артефактов |
| [URL_IMPORT_SUPPORT.md](URL_IMPORT_SUPPORT.md) | Проверенная поддержка источников URL-import и ограничения viewer |
| [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | Запуск и проверки текущего кода |
| [DECISIONS.md](DECISIONS.md) | Принятые изменения против прежних требований |

[Повторная ревизия](reviews/2026-09-20-requirements-revision/REVIEW.md) и [базовое ревью](reviews/2026-09-20-mvp-audit/REVIEW.md) — доказательства и найденные противоречия. [Архив](archive/README.md) — прежние планы, исторические ревью и исходные требования.

## Правила сопровождения

1. Пользовательское решение меняет PRODUCT/REQUIREMENTS; порядок — ROADMAP; фактический статус — STATUS. Не создавать очередной параллельный «финальный план».
2. У задачи есть критерий и доказательство. «В коде», «проверено локально», «проверено в облаке» — разные статусы.
3. Генеративный макет/React-демо не подтверждает готовность серверной функции.
4. Устаревший документ хранится в archive; reviews/evidence/design — справочные материалы, не backlog. Новое решение ссылается на предыдущее, но не наследует отменённый запрет.
5. REQUIREMENTS_TRACE.csv и reference/lanka-requirements.json сохраняют старые PR-ID; их preserved/adapted не означают выполнение новых R-ID. Путь дальнейшего развития отражён в REQUIREMENTS и DECISIONS.

- [Производное для просмотра bundle](BUNDLE_INLINE_SPEC.md) — сборщик, локальная интеграция и оставшаяся приёмка.
- [MCP_IMPLEMENTATION_SPEC](MCP_IMPLEMENTATION_SPEC.md) — контракт реализованного локального сервера; незавершённые приёмки перечислены в STATUS.
- [MCP_ONBOARDING_SPEC](MCP_ONBOARDING_SPEC.md) — контракт настоящего подключения в интерфейсе; заменяет MCP-демо старого ONBOARDING_SPEC.
- [MCP_CONNECTOR](MCP_CONNECTOR.md) — Полка как коннектор Claude.ai и ChatGPT: OAuth 2.1, согласие, `polka_publish`, отзыв и ограничения.
- [PUBLISH_API](PUBLISH_API.md) — HTTP API публикации (`POST /api/v1/publish`) и CLI без зависимостей для агентов и скриптов без MCP.

- [HOSTED_VIEWER_DELTA](HOSTED_VIEWER_DELTA.md) — переход от локального runtime к HTTPS staging и ещё не пройденные проверки.

- [RESTORE_DRILL_SPEC](RESTORE_DRILL_SPEC.md) — контракт совместного восстановления DB+objects; изолированное восстановление schema18 и журнала удаления принято; штатный restore CLI/startup gate и отдельная read-only identity приняты локально, облачная приёмка впереди.

- [TRASH_SPEC](TRASH_SPEC.md) — обратимая корзина, сохранность версий, отзыв доступа и гонки; backend/UI и MCP management приняты локально с ограничениями из STATUS. Полный purge и облачная приёмка остаются открытыми.

- [Контекст для агента и закреплённые шаблоны](AGENT_CONTEXT_TEMPLATES.md) — реализация v2, API/MCP, экспорт и границы корпоративного доступа.
