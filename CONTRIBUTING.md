# Участие в разработке

Спасибо за интерес к Полке. Проект в стадии prerelease: API, схема БД и интерфейс могут меняться.

## Перед началом

- Для крупных изменений сначала откройте issue и опишите задачу пользователя.
- Об уязвимостях — только приватно, см. [SECURITY.md](SECURITY.md).
- Продуктовые границы — [docs/PRODUCT.md](docs/PRODUCT.md): Полка хранит и показывает результаты агентов, а не генерирует их.

## Локальный запуск

Node.js ≥22.16, npm, Docker. Подробно — [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md).

```bash
npm ci
npm run local:setup   # создаёт .env с локальными секретами
npm run infra:up      # PostgreSQL и MinIO в Docker
npm run db:migrate
npm run build
npm run dev           # http://127.0.0.1:4390
```

## Проверки перед pull request

```bash
npm run check   # слои frontend + TypeScript
npm run build
npm test        # создаёт отдельную БД и bucket, после прогона удаляет их
```

Отдельные наборы (`npm run test:live`, `test:mcp` и др.) используют рабочий `.env` и пишут в него — запускайте их только на локальной, не ценной базе.

## Правила

- Схема меняется только новой миграцией в `deploy/migrations/` (существующие не редактируются) и обновлением `packages/migrations.ts`.
- Новые права runtime-роли — через `deploy/runtime-grants.sql`.
- Не коммитьте `.env`, `.local/`, дампы, пользовательские файлы и ключи.
- Форматирование: `npm run format`.
- Отправляя pull request, вы соглашаетесь распространять вклад на условиях [Apache-2.0](LICENSE).
