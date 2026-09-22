# Self-host base: health, readiness и maintenance

> **Статус:** реализовано. Health/readiness и maintenance работают; инструкция по установке — [deploy/BASE.md](../../deploy/BASE.md).

Контракт поставки, актуализирован 21.09.2026; не готовая production поставка.
Health/readiness, отдельный DB-only мигратор, guarded maintenance и
`deploy/compose.base.yml` реализованы и проверены локально. Image build/runtime
smoke и clean-checkout установка ещё не приняты. Рабочая БД остаётся schema16;
каталог и изолированная приёмка уже включают schema18.

## Текущие точки кода

`apps/server/main.ts` подключает health coordinator, отдельные DB/S3 probes,
health routes до frontend, app и optional viewer; shutdown закрывает ресурсы.
`scripts/migrate.ts` получает только DATABASE_URL и использует общий каталог
миграций, транзакцию и advisory lock через migration-runner. S3 provisioning
вынесен в отдельный local bootstrap; storage-check проверяет заранее подготовленный
bucket. `scripts/maintenance-runner.ts` запускает ограниченные проходы maintenance;
обычный GC, purge и restore имеют разные назначения и права.

Schema18 runtime/purge/restore роли и полный backup → фактическое удаление →
pg_restore → очистка до запуска приложения проверены на изолированных ресурсах.
Это не штатный cloud restore command и не production IAM/retention acceptance.
Локальная поставка,
удаление и восстановление.
Ниже требования сохраняют силу; наличие требования не означает его приёмку.

## Health endpoints

`GET /healthz`: 200 `{status:"alive"}`, без DB/S3/auth/config values. При начале
shutdown — 503 `{status:"stopping"}`. Это liveness процесса/event loop, не
готовность обслуживать данные. Не перезапускать app только из-за падения S3/DB.

`GET /readyz`: 200 `{status:"ready"}` только при успешных свежих проверках ниже,
иначе 503 `{status:"not_ready"}`. Оба маршрута no-store/noindex/nosniff, никакого
DSN, bucket, object key, provider error/message, secret или версии зависимостей.
Публичный краткий status допустим; подробные причины только безопасные категории
в operator logs (`db`, `schema`, `storage`, `timeout`, `stopping`). GET не меняет
web Origin/auth semantics. Зарегистрировать до frontend fallback.

Readiness — shared single-flight на процесс, cache outcome не дольше5s, отсутствие
первого результата не считается ready. Один общий deadline2s; не более одного
незавершённого probe. DB и S3 можно проверять параллельно. Endpoint после deadline
возвращает503; истёкшая операция не должна позже записать ready. Cleanup/abort
выполняется и при shutdown; timeout не просто Promise.race с забытым I/O.

DB: отдельный probe pool max1 с **теми же app credentials**, checkout/statement
timeouts ≤1s; не расходовать основной pool8 на частые health requests. Запрос
проверяет доступность и точное ожидаемое множество schema_migrations; отсутствующая
таблица/пропуск/более новая схема → not_ready. Один общий migration catalog для
scripts/migrate и probe, извлечь при интеграции; не дублировать число13 в модуле.
Probe pool изолирован, поэтому нельзя timeout-ом закрыть рабочую DB session.
Это не доказательство DML прав: их проверяет deployment smoke.

S3: отдельный client с теми же endpoint/region/app credentials, maxAttempts1,
ограниченными connection/request timeout и AbortSignal. `HeadBucket` одного
недостаточно: он не доказывает чтение object/version или versioning Enabled.
Проверять `GetBucketVersioning.Status==='Enabled'` и чтение маленького служебного
canary, созданного bootstrap, например `polka-system/readiness-v1`. Body —
фиксированная публичная строка формата, не tenant bytes. `GetObject` должен
вернуть непустой VersionId, отличный от `null`; затем exact GetObject с этим
VersionId возвращает те же известные bytes. Ограничить чтение body256B и остановить
stream при превышении; валидировать содержимое, не доверять только metadata.
Canary не находится под tenant/upload prefix, штатный GC его не выбирает.
Readiness **не делает PUT/DELETE/enable-versioning** на каждом запросе.

Canary и GetBucketVersioning требуют явных прав app credentials. Его успешное
чтение не доказывает запись, ListBucketVersions, DeleteObjectVersion или private
policy. Не называть readiness полной проверкой S3 compatibility. List permissions
проверяются отдельно bootstrap smoke/maintenance, не перечислением всех tenant
objects в публичном health endpoint. Probe не проверяет SMTP доставку, browser
runtime, worker correctness или наличие успешного backup.

## Bootstrap, app compose и миграции

Новый `deploy/compose.base.yml` использует один уже собранный immutable
release image digest для `migrate`, `storage-check`, `app`, `maintenance`.
Не подменять недоступный image непроверенным тегом. Registry acceptance отдельно.
Для первой воспроизводимой установки private DB/S3 endpoints задаёт оператор;
dev MinIO compose не объявлять поддержанной production distribution.

`migrate`: одноразовый job с DB schema-owner credential. Вынести provisioning из
обязательного DB migration path: штатный self-host job мигрирует schema; bucket
и его private policy/versioning заранее provisioned. Старый local bootstrap
сохранить отдельным явным режимом, не ломать `npm run db:migrate` незаметно.
При fail app/maintenance не стартуют. Advisory lock остаётся, migrations не
запускаются автоматически каждым app replica. Приёмка clean bootstrap + повтор
на той же schema. Down migrations не придумывать: rollback на совместимый image
допустим только для совместимой schema, иначе восстановление проверенного backup.

`storage-check`: одноразовый job **с app credentials**, после migration, без
CreateBucket/изменения policy. Проверяет versioning; создаёт/проверяет immutable
canary. На уникальном служебном key выполняет conditional PUT→exact version
read/hash→повторный conditional PUT получает412→ListObjectVersions с узким prefix
находит эту версию→DeleteObject exact VersionId→чтение подтверждает отсутствие.
Cleanup только собственного key/version, не bucket-wide; canary остаётся.
Не создавать tenant/upload rows и не расходовать пользовательскую quota.
Проверка на service prefix не заменяет ревью IAM policy для tenant prefixes и
один реальный upload/export/cleanup smoke в выделенном deployment tenant.

Compose dependencies: DB readiness (если DB сервис входит в конкретный stack)
→ migrate service_completed_successfully → storage-check completed → app и
maintenance. Для внешней DB job имеет bounded ожидание, не бесконечный restart.
App healthcheck вызывает /readyz через встроенный Node HTTP/fetch с deadline,
не требует curl в slim image. При unhealthy не делать автоматический destroy
volumes или recreate schema; compose health сам по себе не restart policy.
Proxy направляет запросы только в ready instance, bootstrap smoke проверяет это.

App `HOST=0.0.0.0` внутри container, наружу bind только нужного интерфейса/прокси.
App/maintenance используют app credentials; schema owner не передаётся им.
Bootstrap выдаёт runtime DB role нужные schema/table/sequence permissions,
включая SELECT schema_migrations; default privileges покрывают следующие
migrations. Не считать успешный owner migration проверкой runtime role.
Секреты предоставляет оператор, не committed env. Текущий config принимает env;
если используется Compose secrets file, нужен явный ограниченный adapter, без
`source` произвольного shell file и без логирования значений. Не обещать поддержку
`*_FILE`, пока её нет. Read-only root filesystem + writable bounded `/tmp`, user
node, stop grace period, memory/CPU limits и no DB/S3 public ports в sample.

## Scheduled maintenance

Отдельный maintenance container с тем же release image и DB/S3 settings.
Простой runner запускает существующий одноразовый maintenance каждые60s **после
завершения предыдущего**; не setInterval с перекрывающимися promises. SIGTERM
останавливает scheduler и завершает child; deadline одного run60s, затем bounded
grace5s и termination. Не нужен jobs framework или system cron внутри app.

Сам одноразовый maintenance, включая ручные вызовы, получает dedicated DB session
и `pg_try_advisory_lock(4388002)` до выбора кандидатов. Busy → безопасный skipped
outcome, не параллельная уборка. Lock session удерживается до полного завершения,
unlock/release в finally; потеря guard session прекращает run, не продолжает его
без singleton. Не держать один SQL transaction на весь run: текущие per-tenant
transactions/committed-ref guards остаются. S3 requests получают timeout/abort;
никаких S3 operations после окончания protected run. Аварийная остановка сохраняет
нынешние retry/tombstone/orphan semantics; не освобождать reservations вручную.

Логи: start/completed/failed/skipped, duration и counts, безопасный reason code.
Не логировать URLs, filenames, provider diagnostics или env. Operator проверяет
последний successful cleanup и failures; живой scheduler не равен успешному GC.
Не делать /readyz зависимым от последнего maintenance success: временная ошибка
уборки не закрывает чтение всех работ. Задержка cleanup видна отдельно оператору.

### Минимальная интеграция singleton и abort в текущий GC

Уточнение 21.09.2026 для следующего кода. Самый простой безопасный вариант —
**один dedicated `pg.Client` держит session advisory lock4388002 и исполняет все
последовательные GC transactions**. Не отдельная guard connection плюс рабочий
pool: при потере guard второй connection мог бы продолжить COMMIT уже без lock.
Session advisory lock переживает BEGIN/COMMIT каждого кандидата, но исчезает
вместе с его DB session; открытая transaction тогда тоже не может быть продолжена.
Общий app `db.ts`/pool и web transaction helper менять не требуется.

One-shot получает AbortController; SIGTERM/SIGINT и local deadline60s вызывают
один stop. Dedicated client: connection timeout≤5s, server statement_timeout≤15s,
client-side query wait≤15s и обработчик `error`/неожиданного `end`. Loss/timeout
делают controller aborted **до** дальнейших callbacks, закрывают/уничтожают
connection и abort S3. `query.signal` установленный pg не поддерживает: нельзя
полагаться на это поле. Client-side timeout сам по себе не освобождает query:
использовать поддержанное закрытие dedicated connection, не вернуть его в pool.
После stop не переподключаться и не переиспользовать client в том же run.

Порядок: connect → `pg_try_advisory_lock(4388002)` → если false, safe skipped/exit0
без candidate SELECT/S3 → защищённый run → закончить все await/rollback → unlock
на том же живом client → close. Нормальное закрытие отметить отдельно, чтобы
собственный end не превратился в lock_lost. При error/end/deadline stop не делать
unlock через новую connection. Handlers поставить до connect, снять в finally;
закрыть client/S3 при любой ветке. Никогда не отпускать advisory lock, пока ещё
запускается protected I/O; после abort дождаться прекращения работы adapters.

В `scripts/maintenance.ts` все SELECT/DELETE и транзакции перенести на этот client
через небольшой helper `runCandidate(client, signal, operation)`: check active →
BEGIN → tenant lock → текущие upload/derivative locks/rechecks → operation →
check active → COMMIT. Проверять active перед **каждым** новым SQL/S3 запросом и
после каждого await, особенно после listing/delete и до metadata UPDATE/COMMIT.
В abort/error ветке только best-effort ROLLBACK/connection close; rollback допустим
после stop, business updates — нет. Не использовать нынешний `transaction()`:
он checkout-ит другой connection и безусловно делает COMMIT после callback.

S3 для one-shot — отдельный client с теми же runtime credentials/bucket, maxAttempts1,
connection timeout1s/request timeout3s; каждый send получает общий run signal.
Сохранить `storedVersions` page bound100 и exact key membership; проверить VersionId
непустой и не `null` перед DeleteObject, иначе fail, не latest/key-only delete.
Все версии уже найденного кандидата удаляются под его tenant/row locks. Следующий
SQL update означает «все перечисленные удаления подтвердились», не «мы запросили
удаление». Ошибка/abort/неизвестный delete outcome оставляет DB transaction
незафиксированной; поздний успешный remote delete возможен, поэтому следующий
run спокойно повторяет listing/deletes и завершает reconciliation.

Сохраняются: receipted uploads не выбираются, committed revision/revision_files
keys защищены, source/ready derivatives не очищаются, aborted upload tombstone
не удаляется, pending derivative становится failed только после законченного
cleanup своего attempt key. Quota/reservation не освобождать в exception handler.
Успешные counters увеличивать после подтверждённого COMMIT. Если abort пришёл
после отправки COMMIT, результат может быть неизвестен: нельзя обещать, что сервер
его отменил. Завершить run как failed/unknown, без повторной business mutation;
следующий run читает durable state. Такой COMMIT уже был отправлен после успешных
S3 deletes и сохраняет GC инварианты независимо от потери acknowledgement.

Общие expired grants/sessions/limits cleanup statements также идут через этот
client с abort checks, лучше одним коротким финальным transaction. Для
`apps/server/email-maintenance.ts` вынести
`cleanupEmailChallengesInTransaction(c, limit, assertActive)`; существующий web/
test wrapper сохранить. Maintenance использует переданный client, не nested
transaction. Проверять active перед/после unlink локального письма и до DELETE;
ENOENT по-прежнему допустим. Файловое удаление может завершиться при rollback,
но selected challenges уже expired/consumed; следующий проход завершит metadata.

Изолируемые файлы: `scripts/maintenance-guard.ts` (client lifecycle/lock/abort),
`scripts/maintenance.ts` (wiring прежнего GC), минимальный helper export в
email-maintenance.ts, tests/maintenance-guard.test.ts и отдельные GC regression
tests. `maintenance-child.ts`/scheduler — независимый пакет; они
супервизируют процесс, но не заменяют singleton внутри ручного one-shot.

Приёмка без лишних fixtures: два one-shot/две connections → второй skipped без
S3; guard session loss в barrier после одного delete → нет metadata UPDATE/COMMIT,
нет следующих deletes, другой session может затем взять lock; abort после listing
и до finalize → rollback/tombstone сохранён; SQL/S3 timeout не ведёт к pool reuse;
следующий run завершает частичный cleanup, committed source/derivative exact reads
и quotas неизменны. Test abort сразу перед COMMIT отличать от потери ответа уже
отправленного COMMIT. Обычный successful GC и email wrapper остаются совместимыми.

## Live viewer и граница приёмки

Base self-host compose: `HTML_LIVE_ENABLED=false`. Нынешний config требует HTTP,
противоположные loopback hostnames, совпадение hostname/listener и ports; этот
режим не работает с container HOST0.0.0.0 или HTTPS reverse proxy. Не ослаблять
gate, чтобы compose «прошёл». Hosted live release зависит от отдельного
[HOSTED_VIEWER_DELTA](../HOSTED_VIEWER_DELTA.md) и его двухдоменной browser приёмки.
Base operational package не закрывает основной interactive beta сценарий.

## Разделение реализации и tests

Независимо: `apps/server/health.ts` с dependency-injected probe adapters,
single-flight/cache/deadline/shutdown и Fastify registration function;
`tests/health.test.ts` на fake adapters/clock. Не импортировать config/db/storage
глобально, не менять app.ts/main.ts/migrate.ts, которыми занимается интегратор.
Отдельные real DB/S3 adapters и root mounting идут после review pure contract;
их fake success не выдаётся за provider acceptance.

Отдельно: shared migration catalog + DB/S3 adapters/bootstrap smoke;
main shutdown marks stopping; register health before frontend; singleton guard
в maintenance; runner; compose/docs. `tests/maintenance-runner.test.ts` проверяет
no overlap, busy lock, guard loss, deadline/SIGTERM и bounded cleanup. Реальный
local smoke проверяет missing schema, wrong app S3 permissions, disabled
versioning, failed dependencies, повтор миграций, exact object probe cleanup и
сохранность tenant bytes. Health tests: status/body/headers, coalescing, cache
expiry, never-resolving dependency, late success after timeout, abort/dispose.

Принятие контейнера требует реального build/start/stop с nonroot image, migration
failure blocking start, DB/S3 outage и recovery без restart storm, graceful stop
и two maintenance invocations. До этого документ и unit tests — подготовка,
не утверждение «production compose работает»; paid/cloud ресурсы не создаются.

## Реализованный локальный запуск, 21.09.2026

- `npm run db:migrate`: только миграции DB; не меняет bucket policy.
- `npm run storage:bootstrap-local`: отдельный bootstrap строго для локальной dev-конфигурации; не команда облачной установки.
- `npm run maintenance`: один ограниченный по времени проход; dedicated DB session/lock4388002; при занятом lock безопасно пропускает проход.
- `npm run maintenance:watch`: runner запускает следующий проход через60s после закрытия предыдущего child; TERM, grace5s, затем KILL; перекрытие проходов запрещено.

Обе maintenance команды выполняют реальную очистку истёкших временных данных той DB/S3, которую задаёт окружение. Сначала проверьте выбранное окружение и backup-процедуру; команда не предназначена для пробного запуска на неизвестных данных. Локально принят target-only synthetic schema18 drill, включая удаление после backup и reconciliation перед запуском; daemon на рабочей DB не запускался. Команды не заменяют непройденную контейнерную/облачную приёмку выше.

Регрессионные проверки разделены на maintenance-scheduler, maintenance-child, maintenance-log-filter, maintenance-guard и maintenance-gc. Упомянутый выше единый maintenance-runner.test.ts заменён этими focused файлами. Доказательства.
