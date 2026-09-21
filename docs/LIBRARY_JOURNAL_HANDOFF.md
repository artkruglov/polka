# Передача: журнал библиотеки → UI

- Repo <repo>, codex/foundation-plan; dirty tree сохранять, коммит не создан.
- Сервер schema26 реализован и проверен: GET /api/template-libraries/:libraryId/events?before=<id>&limit=50, max100. Active-admin-only, чужой/reader/revoked доступ запрещён.
- Response `{items,nextBefore}`; item `{id,libraryId,actor:{id,deleted},action,target:{type,id,deleted},oldRole,newRole,createdAt}`. Cursor/id — строки, не преобразовывать bigint в JS number.
- События create/invite/accept/revoke/rolechange/publish/withdraw атомарны, no-op/replay без дублей. После purge actor/target может быть deleted/null; не выводить выдуманное имя.
- Check pass; migrations5/5; isolated management/invites6/6; final schema26 restricted runtime/purge/mail/restore/S3/app flow pass, cleanup true, workingResourcesUsed=false. Full suite не запускался.
- Следующий один результат Luna medium: кнопка История для admin в существующем управлении библиотекой; общий Dialog, русские названия действий и ролей, дата, actor/target; постранично Показать ещё, loading/error/retry/empty, abort/stale protection при смене account/library.
- Имена можно брать только из уже доступного списка участников; для недоступного имени показать короткий ID, для deleted — Удалённый аккаунт. Email/token не показывать. API ошибки доступа очищают прежние события.
- Не менять backend/миграции; check/build, затем одна браузерная проверка admin→history и reader без кнопки/доступа.
- Рабочая БД остаётся schema21. Миграции применялись только на disposable ресурсах. История хранится до удаления установки; lifecycle библиотеки — archive, физический delete с журналом запрещён.
- Остаток общей цели: UI журнала, negative viewer UI, внешний агент/пакет, интеграционная приёмка и безопасное локальное обновление. Не объявлять внешний релиз.


### UI реализован, следующая граница — браузер

Luna добавила admin-only История, общий Dialog, русские действия/роли, bounded pagination, deleted labels и очистку при403/404. Root review исправления приняты: abort loadMore на unmount/context switch, aborted guard initial fetch, закрытие во время readonly-загрузки разрешено. Luna check успешен, root npm run build exit0. Общий request получил необязательный четвёртый аргумент signal, существующие вызовы совместимы.

Root один раз выполнил npm test на интегрированных server packages: 238+3=241 passed, 0failed/0skipped, cleanup true, workingResourcesModified=false. Доказательство reviews/2026-09-21-library-invitations/integrated-suite-result.json. Это не browser acceptance нового журнала. Следующий один результат: admin открывает историю, reader не видит кнопку; визуальная проверка ролей и пагинации на disposable schema26.

Root browser acceptance: admin history, actual role change и reader без кнопки подтверждены; evidence UI-ACCEPTANCE.md/library-journal-role.png. Большая pagination и deleted UI не проверены браузером. Fixture очищен, рабочая БД21 неизменна.
