# Штатный restore: приёмка в процессе

21.09.2026. Реализация Sol: отдельная команда для уже восстановленной закрытой цели, immutable completion receipt, startup gate и restore Compose overlay. Root подтвердил read-only рендер Compose с синтетическими значениями: 5 services, migrate → storage-check → restore-reconcile → app → maintenance; приложение не получает restore/ledger credentials, receipt доступен ему только на чтение. [Результат](compose-result.json). Сервисы не запускались, инфраструктура не создавалась.

Sol сообщил tsc и focused 10/10 (receipt/gate/target/reconcile); это scoped evidence автора. Astra закрыла ранние замечания к identity, путям, FIFO, порядку запуска и ACL. Остался дефект отмены во время записи receipt: до atomic link отмена должна остановить публикацию; link является точкой фиксации. Пакет не принят до исправления и регрессии.

Далее: финальное ревью, интегрированные тесты и изолированный реальный CLI/gate сценарий. Предыдущий full restore18 drill доказал библиотечный путь, но не эту новую штатную команду. Приёмка контейнерного runtime и облака остаётся открытой. Оператор удерживает запрет записи, каждый новый restore требует нового runId; DB OID и receipt сами этого не гарантируют. Backups с local-mail spool не поддержаны этим overlay: descriptor должен подтверждать localMailSpool=absent.

## Исправление отмены и scoped приёмка

Отмена до atomic link теперь не публикует receipt и удаляет временный файл; уже существующий receipt сохраняется. Успешный link — точка фиксации. Astra дала static GO после проверки исправления. Root независимо запустил receipt/gate/target/reconcile:10/10, skipped0, exit0 (tool chunk265e89). Новые три test files включены в default suite. Это ещё не проверка настоящего CLI child и listener на изолированных PG/S3 — следующий пакет Sol.

Интегрированный default suite root session80198: `npm test`, exit0,188/188,skipped0. Проверки destructive PG/S3 по-прежнему выполняются отдельно.

## Operational fixture: до запуска

Подготовлены расширение `test-runtime-grants-isolated.ts` и `restore-target-integration.test.ts`: отдельная временная MinIO read-only identity, точные AccessDenied, реальный CLI с непустым журналом, suppression bytes/PII, exact retry и actual-main отрицательные/положительный сценарии. Astra execution-review остановила запуск до исправлений: unknown-outcome создания mc directory не должен давать ложный cleanup success; внешний timeout должен остановить CLI/app grandchildren до удаления ресурсов. Sol исправляет; реального прогона этого сценария ещё нет.

Первый actual runner session36710 exit1 остановился на отсутствующем untracked `tests/email-purge-race.test.ts` после runtime3+purge2. Новые IAM resources созданы/удалены, ledgerReaderResidueRemoved=true и syntheticResidueRemoved=true; workingResourcesUsed=false. Причина исчезновения файла не установлена. Root восстановил точный собственный fixture и последующее исправление confirmation_session_hash из истории этой задачи (не из догадки/упрощения теста). Повторная приёмка впереди.

Run79056: восстановленный mail fixture прошёл2/2; всего12 проверок до нового operational test прошли. Operational остановился на ожидании403 для unversioned GetObject журнала: MinIO разрешил чтение. PUT и exact-version DELETE запреты прошли. Истинная readonly-гарантия и exact-version клиентская привязка отличаются от запрета latest-read; Astra оценивает корректировку проверки по фактическому контракту. Все временные ресурсы удалены с readback. [Факты](first-operational-failure.json).

## Operational local acceptance: passed

Root run49995, `node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=18`, exit0:14/14. Separate actual MinIO reader permits version list/read, denies PUT, exact-version DELETE and content-bucket read with403 AccessDenied. Latest read is permitted by this MinIO release: fixture records exact sentinel bytes/VersionId; Astra accepted this correction without widening IAM policy. Application transport keeps explicit-version reads.

Actual restore CLI with restore-only LOGIN reconciles a nonempty revoke journal and stale restored owner/object: PII scrubbed, object prefix empty; exact retry preserves receipt bytes and inode. Actual main refuses missing receipt, changed runId, backup hash and content target before listener, then reaches healthz with correct authority. All prior SQL/ACL/mail/purge checks pass. Temporary IAM user/policy/config directory, DB/roles/buckets removed with readbacks; workingResourcesUsed=false. [Result](operational-result.json).

This accepts the local operational path, not container runtime, production cloud IAM, RPO/RTO, retention or an arbitrary local-mail backup. Descriptor attestations, closed-target operator barrier and fresh generation IDs remain operator responsibilities. Full pg_dump/restore and this operational CLI have separate acceptance evidence; no combined cloud drill is claimed.
