# Full R17: реализация после revoke slice

В работе, очистка рабочих аккаунтов не выполнялась. Predecessors: account-deletion isolated schema16, runtime-grants permissions3/3 + app1/1, pure ledger validation5/5 приняты локально.

## Inventory перед реализацией

Root просмотрел текущие production writers:
- single HTML/files: apps/server/artifacts.ts, `${tenant}/${uploadId}`;
- bundle entrypoint сохраняется тем же ключом, остальные файлы `${tenant}/${uploadId}/files/${index}`;
- derivative: `${tenant}/derivatives/${derivativeId}/${attemptId}.html`.

Значит purge перечисляет весь точный `${tenantId}/` prefix, включая orphan versions и delete markers, а не только DB references. `polka-system/smoke/*` и test sentinels находятся вне этого prefix и должны сохраняться. Journal будет отдельным bucket/namespace.

## Найденная гонка local mail

В текущем beginEmailLogin (apps/server/email-auth.ts) challenge создаётся под email advisory lock, transaction завершается, затем выполняется writeFile `.local/mail/${id}.json`. Возможен порядок: commit challenge → purge удаляет challenge/file и anonymizes account → запоздалый writeFile создаёт файл с email/code после очистки.

Root передал Sol/Astra обязательную синхронизацию local delivery и purge до localMailCleared proof, плюс regression с paused writer. SMTP delivery не считается отзываемой и не доказывается тестом локальных файлов. Исправление ещё не принято.

## Разделение ролей

Sol предложил последовательные guarded invocations GC и purge с общим advisory4388002: у каждого один DB client; purge требует отдельный worker URL и narrow permissions, обычный GC сохраняет прежние права. Требуется единое подтверждение Astra перед новой миграцией. Один guard не должен разрешать SQL другого соединения.

Astra подтвердила separate sequential invocations; прежний вариант совместного GC/purge на одной расширенной роли отменён. Для local mail согласован отдельный delivery transaction: email advisory lock → повторный read challenge/owner → mkdir/writeFile до release. Исходный committed challenge остаётся inventory при ошибке write/commit. Не добавлять challenge FOR UPDATE после email lock из-за обратного порядка verifier. Purge берёт email lock до tenant/account и повторяет попытку при занятых challenges. Проверить обе очередности writer→purge и purge→late writer. Это принятое решение, код/тесты ещё в работе.


Root inventory дополнен login_limits: limitAttempts хеширует `email-send:${email}` и `name:${name}` через SHA-256 перед INSERT. Plaintext email/name в этой таблице не хранится; речь о точечной очистке связанных хешей. Sol получил точечное удаление этих keys до anonymization и fixture assertion; общие IP-счётчики и чужие rows не удаляются. Draft terminal erasure ещё не проверен.

Injected ledger adapter принят Astra после трёх исправлений; Luna focused tests5/5/check. Он не доказывает реальное S3 conditional PUT/versioning или полноту журнала при restore.


Astra SQL checkpoint: до execution исправить pg_temp/type shadowing в SECURITY DEFINER; complete_mail должен удалять точные IDs действительно очищенных файлов, а не заново выбранные SKIP LOCKED rows; limit hashes выводятся из заблокированного целевого account внутри SQL; worker grants проверяют ownership schema/objects. SQL не исполнялся.

S3 transport root review: pending body iterator должен иметь общий deadline/abort race; недостаточно проверки signal между chunks. Early GetObject failure должен освобождать body. Неизвестный IsTruncated/malformed listing нельзя считать полным пустым журналом. Luna исправляет с injected regressions, реальные buckets ещё не проверены.


## Следующая контрольная точка

Astra приняла исправления SQL17/worker grants и разрешила изолированную SQL/ACL проверку. Это допуск к тесту, не доказательство выполнения миграции или purge. Рабочая БД остаётся16, удаление выключено.

S3 journal transport принят scoped review после исправления optional SDK arrays, body deadline/abort cleanup, снятия listener и обработки iterator.return rejection. Luna исправила fixture на фактическом iterator с returnCalls=1; focused9/9 прошли. Тест добавлен в штатный список. Реальные conditional PUT/versioning и restore completeness ещё не приняты.

Root и Astra нашли отдельный blocker полного purge: переиспользованный content listing adapter превращает отсутствие IsTruncated в false и может принять malformed ответ за пустой prefix. Sol исправляет строгую проверку ответа; до исправления полный purge не запускать. Luna добавляет отрицательные тесты worker в отдельном файле. Дополнительно нужен yield успешного неполного batch, чтобы100 объектов не удерживали lease10 минут без работы.


Root integration check: `npx tsx --env-file=.env --test tests/account-purge.test.ts tests/account-purge-negative.test.ts tests/maintenance-adapters.test.ts tests/erasure-ledger-s3.test.ts` завершился exit0,20/20. Worker3 + negative7 + journal9 + content adapter1. Новые тесты включены в штатный список. Negative harness исправлен после root review: типизированные зависимости, правильная инъекция unlink и assert вызова. Это injected/component проверки, не выполнение SQL17 и не реальные операции S3. Malformed listing blocker закрыт scoped Astra review и регрессией. Следующий шаг — изолированная SQL/ACL и полная purge/restore приёмка.


## Изолированная SQL17/ACL приёмка выполнена

Root выполнил `node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic` после Astra review runner и fixture. Session11436, exit0: runtime3/3, purge SQL2/2, revoke app1/1. Exact schema17/grants применялись только к временной БД с отдельными owner/runtime/purge LOGIN. Fixture проверил stale attempts, yield/reclaim, exact mail inventory при освобождении занятой строки, metadata tombstones и сохранность соседнего rate-limit key. Synthetic DB/bucket/три роли удалены; runner проверил отсутствие остатка. Рабочие ресурсы не использовались.

Результат: [isolated-sql-result.json](isolated-sql-result.json). Это реальная SQL/ACL проверка и прежний revoke app flow. S3 journal ack в SQL fixture синтетический; она не доказывает полный worker с реальным S3, mail-file race или restore suppression. Следующий пакет — именно эти интеграции. Рабочая схема остаётся16, deletion выключен.


Restore plan component принят scoped Astra review после исправления потери VersionId у одинаковых bytes. Каждая запись связана со своим acknowledgement по индексу с проверкой key/hash; изменение или удаление одной из одинаковых исторических версий теперь блокирует открытие. Sol reported check + focused3/3; тест включён в штатный список. Это только component proof, не фактическое восстановление.

Для проверки mail race Sol выделил `deliverLocalEmailChallenge`, который вызывается настоящим `beginEmailLogin`. Передаваемый writer выполняется внутри transaction после email advisory и повторной проверки challenge/owner. Luna готовит тест с реальными PG locks и временными файлами; production delivery сохраняет прежние параметры записи. Этот тест ещё не запущен.


Интеграционная регрессия после выделения local-delivery helper и добавления компонентов purge/restore: root `npm test`, session43680, exit0,178/178. Каталог исходников17 проверен отдельно от рабочей БД; эта команда не применяла миграции17/18 и не запускала protected purge. В набор входят injection/component tests, обычные локальные app fixtures и прежние сценарии; mail race/реальный S3 purge/restore остаются отдельной приёмкой.


## Mail race: запуск с расхождением версии схемы

Session96314 завершилась exit0: runtime3/3 +purgeSQL2/2 +mailrace2/2 +app1/1. Проверены обе очередности через actual delivery helper/PG locks/tempfiles. Но исполнение фактически использовало schema18, хотя review handoff относился к17: параллельная правка каталога попала в запуск. Результат предварительный до отдельного review18, не приёмка18/restore. Runner подтвердил удаление временных ресурсов, workingResourcesUsed=false. [Факты запуска](mail-race-provisional-result.json).

Root добавил обязательный `--expected-schema=<reviewed version>`: расхождение с каталогом останавливает runner до создания ресурсов. На время следующих reviewed runs требуется зафиксировать владение catalog/migrations/grants; изменения согласуются до запуска.


## Review18: до следующего запуска

Astra не приняла18: `restore_suppressed` должен быть исключён из обычного claim, иначе блокирует очередь; restore registration не должна расширять права обычного purge worker до отключения активных аккаунтов; historical `purged_at` не заменяется временем восстановления; retry проверяет неизменность исторических полей и не допускает NULL обход проверки. Sol получил исправления. `--expected-schema` guard принят и проверен root несовпадением17/18 (exit1 до создания ресурсов). Предварительный mail-result не закрывает эти критерии.


Astra closure18 (static): прежние четыре SQL замечания закрыты в текущем коде. Новый restore-only recipe пока требует явной проверки различия restore/app/purge/owner ролей и current_user=session_user=schema_owner перед выдачей прав. Иначе существующая purge-роль проходит preflight и получает restore authority. Исполнение18 после этих исправлений ещё не разрешено; reconciler и отдельная функциональная приёмка остаются в работе.


## Schema18 SQL/ACL и mail race приняты изолированно

После закрытия review замечаний root выполнил `node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=18`. Session39124, exit0: runtime3 +purgeSQL2 +mailrace2 +restoreSQL4 +revokeapp1 =12/12. Timeline restore fixture перенесён в2020 для действительно исторических дат. Отдельные owner/runtime/purge/restore LOGIN, exact recipes, metadata-present/absent, NULL/conflicting retry, ordinary-claim exclusion, сохранение historical purged_at проверены. Временные DB/bucket/четыре роли удалены, residue check прошёл. Рабочие данные не использованы.

[Результат](isolated-schema18-result.json) заменяет предварительный запуск как evidence SQL/ACL/mail. Он не доказывает удаление через настоящий S3 или восстановление полноценного старого backup, включая существующий purged job. Эти сценарии остаются следующими обязательными шагами. Рабочая schema16 и выключенное удаление сохранены.


Первый actual S3 run session26512 завершился exit1 на restore reconciliation (`guard_lost`, testline426). Ordinary purge counters/empty prefix до этой точки прошли, но fullS3 test не принят. Предыдущие runtime/purge/mail/restoreSQL проверки прошли; app test после сбоя не запускался. Runner подтвердил удаление временных ресурсов, рабочие не использованы. Sol диагностирует первичную SQL ошибку под guard, без ослабления защиты. [Ошибка](real-s3-first-failure.json).


## Реальный локальный S3: проверка пройдена

Diagnostic99225 локализовал23514 в register; diagnostic72948 уточнил `agent_connections_check1`: historical revokedAt был раньше created_at восстановленного подключения. SQL18 исправлен: local revoke использует COALESCE(existing,GREATEST(clock_timestamp(),created_at)), historical journal/receipt не меняются. Local publication/derivative события также используют время локального действия. Astra приняла targeted fix; ограничения БД и тестовые данные не ослаблялись.

Root run50104, `node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=18`, exit0:13/13. Ordinary worker удалил4 точные версии/delete markers. Restore очистил3 восстановленных объекта в случаях already-purged job, revoked-only snapshot и отсутствующего tenant; journal VersionIds/hashes и точная версия соседа сохранены. Четыре SQL роли и mail race также прошли. Две временные buckets/DB/четыре роли удалены и отсутствие проверено. Рабочие ресурсы не использовались.

[Факты](real-s3-result.json). Это реальный локальный MinIO+PG сценарий, не pg_dump/pg_restore полного backup и не доказательство production IAM/retention. Следующий этап: встроить reconciliation в полный restore drill до открытия приложения; проверить прерывание/retry и недоступный journal на этом пути.


Root дополнил realS3fixture отрицательными сценариями: недоступный/некорректный journal preload не создаёт registration; первая реальная версия удаляется, вторая операция намеренно падает; тот же restoreRunId повторно очищает две оставшиеся версии, третий вызов не удаляет metadata/bytes. Журнал и сосед сохранены. После Astra review run51436 exit0,13/13, cleanuptrue/workingfalse. [Факты retry](real-s3-retry-result.json). Это ещё не app-startup barrier полного pg_restore; его проверяет следующий restore drill.


## Полный backup → удаление → restore на schema18

После исправлений Sol и допуска Astra root выполнил `node --env-file=.env --import tsx scripts/restore-drill.ts --confirm-synthetic`, session18716, exit0. Настоящие pg_dump/pg_restore и 8/8 object remaps: после backup источник реально удалён через worker, журнал содержит revoke и purged. Reconciliation удаляет старые bytes/PII до первого запуска приложения; историческая дата удаления и версии журнала сохранены. Соседний аккаунт: новый вход, exact export, новая ссылка, корзина и maintenance проходят; старый доступ отвергнут. Временные ресурсы удалены. [Результат](full-restore-schema18-result.json).

Это локальная приёмка с fixture admin; отдельные SQL роли проверены другим runner. Production IAM, retention, cloud restore/RPO/RTO остаются открыты. Рабочая БД остаётся16, удаление выключено.

Интегрированный default suite после schema18/reconcile: root session48712, `npm test`, exit0, 180/180, skipped0. Изолированные destructive fixtures не входят в этот набор и имеют отдельные evidence выше.
