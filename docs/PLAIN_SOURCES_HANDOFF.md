# Передача: обычные исходники → UI

- Repo <repo>, codex/foundation-plan, без нового коммита; dirty tree сохранять.
- Backend готов: текст/PNG/JPEG/WebP source, MCP/ZIP/file; immutable revision, pinned bytes, hash/size и ACL.
- Тип SingleFileSourceDescriptor в packages/contracts/agent-context.ts; реализация apps/server/agent-context.ts; тест tests/single-file-agent-context.test.ts.
- Catalog теперь возвращает mime. NonHTML source: manifest=null, manifestSha256=null, sourceDescriptor kind single-file/schema1/files; paths source.txt/png/jpg/webp.
- Check успешно; isolated single-file+HTML3/3 и library-source1/1. Внешняя модель и browser UI для обычного материала ещё не проверены.
- Следующий один результат Luna medium: показать формат в templates и не отправлять nonHTML в HTML library preview; «Скопировать для агента» и точные downloads оставить. По возможности существующие shared компоненты, без нового viewer/масштабного редизайна.
- Приёмка UI: check/build, один точечный браузерный сценарий текста/источника. Не повторять полный backend suite.
- Полный остаток цели: audit journal, отрицательные UI-сценарии, внешняя модель/пакет, интеграционная приёмка и безопасное локальное обновление. Рабочая БД schema21 не изменена; тестовые ресурсы очищены.

Этап UI закрыт: Luna добавила формат, HTML-only preview и Исходники для nonHTML, check/build успешны. Root проверил текстовый шаблон участником в браузере, purpose=base и exact package pins; см. UI-ACCEPTANCE.md. Следующий функциональный остаток — корпоративный журнал событий; negative UI и внешняя модель остаются в общей приёмке.
