# Участие в разработке

Спасибо за интерес к Полке. Проект в стадии prerelease, поэтому API, схема БД и интерфейс могут меняться. Issues и pull requests принимаются на русском и на английском. *Issues and pull requests are welcome in Russian or English.*

## Перед началом

- Для крупных изменений сначала откройте issue и опишите задачу пользователя.
- Об уязвимостях сообщайте только приватно, см. [SECURITY.md](SECURITY.md).
- Продуктовые границы описаны в [docs/specs/PRODUCT.md](docs/specs/PRODUCT.md). Полка хранит и показывает результаты агентов, но не генерирует их. Что уже сделано и что планируется: [docs/status.md](docs/status.md), [docs/roadmap.md](docs/roadmap.md).
- Участники следуют [кодексу поведения](CODE_OF_CONDUCT.md).

## Локальный запуск

Нужны Node.js ≥ 22.16, npm и Docker. Подробности в [docs/local-development.md](docs/local-development.md).

```bash
npm ci
npm run local:setup              # .env с локальными секретами
npm run infra:up                 # PostgreSQL и MinIO в Docker, только 127.0.0.1
npm run db:migrate
npm run storage:bootstrap-local
npm run account:create -- demo --generate
npm run build
npm run dev                      # http://127.0.0.1:4390
```

## Проверки перед pull request

```bash
npm run check          # слои frontend + TypeScript
npm run build
npm test               # временные БД и bucket, после прогона удаляются
npm test -- --live     # файлы из tests/live-suite.json с включённым viewer
```

`npm test -- --live` обязателен, если изменения касаются viewer, сборщика, runtime, корзины или «Интересного». Один файл запускается так: `npm test -- --live tests/trash.test.ts`. `npm run test:live` — то же, что `npm test -- --live`. Прочие отдельные команды (`test:restore-guards`, `test:url-import-runtime` и другие из `package.json`) описаны в [docs/local-development.md](docs/local-development.md).

CI повторяет `check`, `build` и `npm test`, а ещё проверяет лицензии production-зависимостей, секреты в истории и собранный Docker-образ.

## Правила

- **Слои frontend.** `apps/web/src` делится на слои `app → pages → widgets → features → entities → shared`, и импортировать можно только в сторону нижних слоёв. Срезы одного слоя (например, две страницы) друг друга не импортируют, исключение — `shared` и `app`. Из-за пределов `apps/web/src` разрешены только `packages/contracts` и `packages/editorial.ts`. Всё это проверяет `npm run check:layers`. Общие компоненты и токены лежат в `shared/ui`, подробности в [docs/FRONTEND_COMPONENT_SYSTEM.md](docs/FRONTEND_COMPONENT_SYSTEM.md).
- **Контракты.** Схемы и лимиты, общие для сервера и клиента, живут в `packages/contracts` (zod).
- **Один сервис на действие.** Web, MCP и publish API вызывают одни и те же сервисы в `apps/server`. Не дублируйте проверки tenant, scope и идемпотентности в транспорте.
- **Схема.** Схема меняется только новой миграцией в `deploy/migrations/` (существующие миграции не редактируются) и обновлением `packages/migrations.ts`. Новые права runtime-роли добавляются в `deploy/runtime-grants.sql`.
- **Runtime.** Новая библиотека в `packages/contracts/runtime.ts` требует записи в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) и лицензии из списка, который разрешает CI.
- **Секреты.** Не коммитьте `.env`, `.local/`, дампы, пользовательские файлы, токены и ключи.
- **Документация.** Изменение поведения обновляет нужный документ в `docs/`, [docs/status.md](docs/status.md) и раздел `Unreleased` в [CHANGELOG.md](CHANGELOG.md).
- **Форматирование:** `npm run format`.

Отправляя pull request, вы соглашаетесь распространять свой вклад на условиях [Apache-2.0](LICENSE).
