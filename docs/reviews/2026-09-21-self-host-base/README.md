# Self-host base: локальные проверки

Это частичная реализация SELF_HOST_BASE_SPEC, не доказательство готовой облачной поставки.

## Координация readiness

`apps/server/health.ts`: пять pure tests проходят. Проверены single-flight/cache, общий deadline, отказ запоздалому успеху, no adapter invocation после shutdown и фактически прошедшее время при задержанном timer. Astra приняла coordinator. Реальные adapters и HTTP endpoints подключены после ревью Astra. Общий каталог миграций schema1–13 используется migrate и readiness.

## S3 bootstrap

`node --import tsx --env-file=.env scripts/storage-check.ts --confirm-bootstrap` завершился exit0 на локальном MinIO с application credentials. Проверены Enabled versioning, canary latest + exact version bytes, conditional creation/412, listing собственной версии, exact-version deletion и последующий404. Постоянный публичный служебный canary `polka-system/readiness-v1` оставлен для будущего readonly readiness; пользовательские prefixes/quota/policies не изменялись.

Первый запуск остановился на canary read. Ограниченная диагностика показала ECONNRESET при повторном использовании socket сразу после ожидаемого412. Скрипт одноразовой проверки теперь не переиспользует HTTP sockets, имеет ограниченные connection/request deadlines и не повторяет неоднозначные PUT. После изменения полная локальная проверка прошла.

При потерянном ответе PUT неизвестная версия может остаться на сервере: failure log сохраняет только безопасные phase/probeKey и cleanupPending. Cleanup удаляет только VersionIds, возвращённые для уникального key текущего запуска. Скрипт не объявляет неизвестные поздние записи исключёнными и не удаляет произвольные объекты по listing.

## Что остаётся

Отдельный bootstrap/migration provisioning, guarded scheduled maintenance, self-host compose, собранный immutable image и clean-checkout installation. Local MinIO smoke не подтверждает IAM/conditional/version semantics Яндекс Object Storage, private bucket policy, cloud readiness или production restore.

## Интеграция и реальные локальные зависимости

Luna реализовала DB/S3 adapters; Sol — shared migrations catalog, health routes и main wiring; Astra приняла исправления и integration. 17 focused tests (coordinator5, adapters8, routes2, migrations2) прошли; TypeScript passed. Эти проверки включены в default test script. Прямая зависимость @smithy/node-http-handler4.12.1 закреплена из уже установленной версии.

Ведущий выполнил read-only probe реальных локальных PostgreSQL/MinIO: ready=true,24ms. После controlled restart HTTP /healthz вернул200 `{status:alive}`, /readyz вернул200 `{status:ready}`; оба no-store. Никакие пользовательские данные/политики для этой проверки не менялись. Ошибки зависимостей и остановка проверены injected tests; рабочие DB/S3 ради отказа не выключали. Это локальная приёмка, не облачная.

## Разделение bootstrap и scheduler

Sol отделил DB-only migrate от S3 provisioning. Явная локальная команда `npm run storage:bootstrap-local` разрешает только generated loopback:9038/polka-local target, затем запускает strict storage-check. localsetup печатает infra→migrate→bootstrap. Guard/order/failure/catalog tests5/5, check passed; Astra scoped review принят. Реальный повтор bootstrap пока не выполнялся. DB migrator всё ещё требует общие env переменные для config parsing; S3 I/O в нём нет.

Ведущий подготовил pure maintenance-scheduler с actual-child-exit barrier, interval-after-completion, TERM/deadline/KILL grace, отменой и защитой от исключений в event sink/terminate.6/6 tests, Astra scoped review принят после исправлений. Scheduler пока не подключён к CLI: нужны singleton guard maintenance и adapter с достоверным close/exit. Это не работающая периодическая уборка.

### Повтор локального bootstrap

`npm run storage:bootstrap-local` выполнен ведущим на существующем локальном MinIO: exit0, versioning/exactVersionRead/conditionalCreate/versionList/exactVersionDelete=true. Постоянный canary сохранён, проверочный объект удалён. Это повторная локальная установка storage, не чистая установка полного self-host image.

Child adapter Luna:3/3tests, node executable/shellfalse, close authoritative, pre-spawnfail sanitized, повторные post-spawnerror не считаютсяexit и не остаютсябезlistener. stdout/stderr покаignore: передCLI нужна фильтрация boundedоперационныхJSONлогов и singleton guard.

### Логи дочернего процесса

Добавлен pure maintenance-log-filter: пропускает только известные JSON event/reason и неотрицательные целые counters, отбрасывает остальные поля/raw errors;4KiB line и64KiB forwarded total.3/3tests, Astra scoped review принят. Scheduler/child/logfilter проверки включены в default suite. Singleton helper ещё на ревью: найдены abort/sessionloss края; его нельзя подключать к GC до исправлений и приёмки.

### Runner и реальный безопасный child

Root подключил maintenance-runner.ts к scheduler/child: SIGINT/SIGTERM, отдельные scheduler.* события, stdout/stderr через bounded JSON filters с общим64KiB budget. Astra scoped review принят. Scheduler6/filter3/child4 unit tests прошли; добавлен пятый child test с реальным Node/tsx subprocess, который не импортирует приложение/GC: safe output filtering и graceful TERMexit подтверждены. Никакой рабочей уборки в этом smoke не выполнялось. Подключение фактического GC и полный daemon acceptance остаются за отдельной интеграцией Sol.

### Singleton GC и synthetic restore schema14

Sol подключил фактический cleanup к принятому singleton guard через отдельные
PostgreSQL/S3 adapters. Один dedicated PostgreSQL client удерживает advisory
lock и выполняет все короткие транзакции последовательно. Upload и pending
derivative удаляются только по точным key/VersionId после повторной проверки
DB references; counters публикуются после commit. Query, S3 request и закрытие
имеют bounds, а abort/потеря guard проверяются до и после внешнего I/O.
Email cleanup использует ту же guarded transaction. Quota, receipts и ready
references cleanup не переписывает.

Focused GC+guard tests: 20 passed, 0 failed. Они включают rollback/retry после
частичного exact-version delete, guard loss, null VersionId, busy singleton без
S3, query timeout, deferred query после close и зависшее setup-close. `npm run
check` и diff check прошли. Astra приняла scoped review. Рабочий GC при этой
проверке не запускался.

После review выполнен один изолированный schema14 restore/maintenance drill:

```sh
npx tsx --env-file=.env scripts/restore-drill.ts --confirm-synthetic
```

До записей script потребовал queryless loopback DB/S3 URLs, уникальные
`polka_restore_drill_<id>_{source,target}` DB и
`polka-restore-drill-<id>-{source,target}` buckets, отсутствие collisions и
отличие от working DB/bucket. Удаление разрешалось только database comments и
bucket sentinels текущего run. Maintenance child получил только target
synthetic DB/bucket.

Run `26092084b16996` завершился exit0: schemaVersion14, 7 object references и 7
remapped VersionIds. Safe maintenance events дали counters uploads1,
derivatives0, email0. Staged target version удалён, source staged version,
полный multiset committed references и quota сохранены. Старые recipient
tokens вернули404, session401, agent был отклонён; share hashes, fresh owner
login/export/new share, rejected replay stability и trash restore прошли.
Finally подтвердил удаление обеих synthetic DB и buckets
(`syntheticResidueRemoved:true`). Это локальный synthetic regression;
`productionRestoreProven:false`, hosted provider migration, RPO и RTO не
доказаны.

## Контейнерные оригиналы редакции

После реального каталога найден packaging gap: editorial-publish проверяет content/editorial/<slug>/index.html, но runtime image не копировал content. Dockerfile теперь включает content/editorial и LICENSE; .dockerignore исключение сохраняет provenance README рядом с оригиналами. Локально проверены наличие12 исходников/README и совпадение candidate hashes. Публикация/seed при запуске образа не добавлены. Registry/build остаётся непроверенным; статическая правка Dockerfile не выдаётся за успешную сборку контейнера.

## Base compose и DB-only мигратор

Luna подготовила deploy/compose.base.yml/base.env.example/BASE.md и offline image digest checker. Root нашёл, что прежний migrate импортировал app config и требовал S3/LINK/APP secrets; заменён собственным pg.Client DATABASE_URL-only. Сохранены единая транзакция, advisory lock4388001, version markers после SQL и rollback. Четыре focused test прошли, включая чтение отсутствующего SQL и bounded reject/hang close. CLI с пустым окружением кроме DATABASE_URL и PATH достигает ожидаемого локального connection refusal без app/S3 config, выводит только безопасную ошибку. Рабочие миграции16 не запускались.

Astra выявила отсутствие deploy/base.env в Docker ignore и unbounded close. Root добавил build-context exclusion; close ограничен1s, при провале dedicated CLI завершается exit1 без provider diagnostics. В Git тот же файл исключён отдельно. Документация требует runtime grants/default privileges и отдельной проверки runtime role.

Root read-only Compose config с синтетическими значениями:4services, один digest, migrate получает только schema-owner DATABASE_URL, остальные runtime URL, rootfs read-only/user node, только app hostport127.0.0.1, оба эксперимента выключены. Image checker читает POLKA_IMAGE через Node --env-file, не source shell. Временный файл удалён; сервисы не запускались. MAIL_MODE зафиксирован disabled; SMTP требует отдельной конфигурации. Это статически проверенный candidate, контейнерная/облачная приёмка всё ещё не выполнена.
