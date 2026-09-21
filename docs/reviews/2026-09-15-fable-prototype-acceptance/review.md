# Fable 5.1 — финальное приёмочное ревью прототипной итерации

**Дата:** 15 сентября 2026  
**Результат:** `accept with changes`; замечания переданы Opus и исправлены.

## Что проверено

- Landing, `/bring`, `/connections`, `/s`, `/discover` соответствуют новой рамке.
- URL-путь остаётся честным demo: не скачивает содержимое, не создаёт receipt и не показывает чужие данные как сохранённые.
- Рабочая цепочка upload → receipt → share → `/s` сохранена.
- CSP, storage, migrations и share schema не менялись.
- `/api/capabilities` сообщает `urlImport:false`, `htmlRuntime:false`.

## Замечания Fable и исправления Opus

1. Удалено пользовательское слово «артефакт» из Login и серверного fallback-заголовка; добавлен словарный тест по всем TSX.
2. `docs/LANDING.md`, `README.md` и `docs/INTERFACES.md` синхронизированы с разделением real/demo/plan; убраны обещания VPN и готового URL/ZIP/runtime.
3. Блок «Команды и компании» на Landing явно помечен `plan`; готовые на вид SSO/корпоративные гарантии убраны.
4. MCP-origin и сортировка витрины помечены demo/plan.
5. Исправлен `aria-controls` вкладок `/bring`.

## Итоговые статусы

- **Real:** загрузка HTML/TXT/PNG/JPEG/WebP до 5 МБ, receipt, версии, папки, профили static/limited/unsupported, ссылка 1/7/30 дней, отзыв, `/s`, жалоба, вход/выход.
- **Demo:** распознавание URL в браузере, редакционная витрина, будущие подключения и агентские сценарии.
- **Plan:** серверный URL-import, interactive networkless runtime, ZIP, MCP, Telegram, «Сохранить себе», реакции, командная Полка, Enterprise и самостоятельная регистрация.

## Проверки после исправлений

- `npm run check` — успешно.
- `npm run build` — успешно; остаётся только предупреждение Vite о размере чанка.
- `npm test` — 31/31.
- `git diff --check` — чисто.
- `GET /api/health` — `{"ok":true}`.
- `GET /api/capabilities` — `urlImport:false`, `htmlRuntime:false`.

Перед публичной публикацией остаются ручные браузерные проверки сценариев из [Fable prototype handoff](../2026-09-15-fable-prototype-handoff.md), особенно загрузка ограниченного HTML, отзыв ссылки и просмотр из российской сети.
