# Передача: UI просмотра → браузерная приёмка

- Репозиторий `<repo>`, ветка `codex/foundation-plan`; коммит не создан, рабочее дерево содержит ранее накопленные изменения — не reset/add-all.
- Готово: schema25, изолированный просмотр single HTML и готового bundle, точные revision/publication/session/membership epoch; токен до 60 секунд, повторная авторизация при чтении.
- Файлы сервера: `apps/server/template-library-viewer.ts`, `template-library-access.ts`, `template-library-routes.ts`, `live-viewer.ts`; миграция `deploy/migrations/025_template_library_viewer_grants.sql`.
- API: POST `/api/template-libraries/:libraryId/publications/:publicationId/live-view`, JSON `{artifactId,revisionId}`; 200 `{status:"ready",url,expiresAt,profile}`, 409 `{status:"preparation_required",revisionId,build}`, отказ доступа 404.
- URL iframe — отдельный VIEWER_ORIGIN `/library-document/:token`; не заменять ссылкой владельца или публичным share.
- Sol: TypeScript успешно; viewer 1/1, migrations/access 8/8, после исправления runner смешанный migrations+viewer 5/5. Полный текущий suite не запускался.
- Runner `scripts/test-isolated.ts` выделяет viewer в отдельный процесс с live env и при полном запуске; обычные тесты остаются live-disabled.
- Ведущий: финальный `test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=25` успешен; доказательство `reviews/2026-09-21-library-invitations/schema25-runtime-final-result.json`.
- Не готово: авторизованная подготовка bundle без готового derivative; fixture viewer проверяет готовые bytes, не реальную сборку.
- UI Luna готов: `features/template-library-preview/{index.tsx,styles.css}`, кнопка в `pages/templates/index.tsx`; loading/error/retry/close/refresh, отмена fetch, точные pins. Ведущий нашёл и Luna исправила разбор 409 status. После исправления check/build прошли.
- UI: `apps/web/src/pages/templates/index.tsx`, существующие shared компоненты; при смене пользователя/библиотеки закрывать старый просмотр; не включать широкие разрешения iframe.
- Следующий один результат (свежий контекст): ограниченный браузерный проход на disposable fixture, включая интерактив, preparation-required и отказ после отзыва доступа. Флаг TEMPLATE_LIBRARY_BROWSER_PREPARED=true собирает team-report настоящим сборщиком владельца; без флага проверяется 409. Браузером проверены prepared viewer, клавиатурный интерактив, refresh и Escape; следующий ограниченный проход — pointer/mobile, 409 и отзыв. Доказательство в UI-ACCEPTANCE.md; backend-аудит не повторять.
- Общий остаток цели: подготовка bundle, контекст non-HTML, корпоративный аудит, реальный агент и общая приёмка. UI-пакет сам по себе цель не завершает.
- Рабочая БД остаётся schema21; не мигрировать и не перезапускать её этим пакетом. Тестовые ресурсы очищены; серверный исполнитель завершён, новых процессов этого этапа нет.


## Следующий этап: кнопка подготовки (сервер принят 21.09.2026)

- Sol реализовал POST `/api/template-libraries/:libraryId/publications/:publicationId/prepare-live-view`, body `{artifactId,revisionId}`. Ответ `{revisionId,concurrent,state,runtimeProfile,reason,path}`; concurrent даёт HTTP202, завершённая попытка HTTP200. 404 — нет доступа.
- Проверки Sol: check успешно, isolated viewer suite 3/3. Ведущий проверил explicit sourceTenantId, epoch, порядок блокировок и детерминированный barrier отзыва после чтения bytes до finalize.
- Тесты включают real member build→viewer, outsider/mismatch, concurrent prepare, quota source/member, owner route, revoke→expiry→maintenance→rejoin→retry. Рабочие ресурсы не изменены, isolated DB/bucket очищены. Полный suite не запускался.
- Остаточная pending-резервация после отзыва очищается после срока попытки (5 минут) и ближайшего успешного maintenance; без maintenance срока автоматической очистки нет.
- Следующий один результат Luna medium: в `features/template-library-preview` для preparation_required показать «Подготовить просмотр», POST prepare с теми же pins, pending — понятное ожидание/ручная проверка, ready — заново запросить live-view; unsupported/failed/403/404/quota различать понятным текстом. Без бесконечного polling и без автоповтора сборки после ошибки.
- Проверка: check/build; затем отдельный браузерный проход без TEMPLATE_LIBRARY_BROWSER_PREPARED — участник сам подготавливает материал и открывает интерактив. Завершённый owner-prepared UI-проход не заменяет этот критерий.


### Закрытая граница UI-подготовки

Luna реализовала кнопку и ручную проверку pending; root проверил конечный путь неподготовленный bundle → подготовка участником → iframe, мобильный размер и native click интерактива. Check/build прошли, fixture очищен. Доказательства: UI-ACCEPTANCE.md, library-prepare-mobile.png. Следующий функциональный пакет — контекст обычных non-HTML файлов; отрицательные UI-проверки viewer сохранить в общей приёмке, не забыть. Рабочая БД schema21 не менялась.
