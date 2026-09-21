# Restore drill: PostgreSQL + versioned objects

Статус: контракт для review перед реализацией. Команды backup/restore из этого
документа пока не реализованы и не должны запускаться против рабочей среды.

## Цель и граница

Минимальный drill доказывает, что один согласованный backup восстанавливает:

- PostgreSQL schema и все tenant metadata;
- точные bytes исходных single и bundle revisions;
- точные bytes готовых inline derivatives;
- staging objects, на которые ещё ссылаются `uploads` и `upload_files`;
- `LINK_KEY` как отдельный секрет backup generation;
- состояние shares, audit и agent operations.

Восстановление выполняется в новые PostgreSQL database и versioned S3 bucket.
Оно не сохраняет provider-specific S3 VersionId: target storage выдаёт новые
VersionId, после чего все DB references атомарно переписываются по проверенной
карте `(object_key, source_version_id) -> target_version_id`.

Drill не является disaster recovery рабочей среды, не проверяет managed-cloud
PITR и пока не доказывает RPO ≤15 минут / RTO ≤2 часа. Он проверяет механизм,
инварианты и fail-closed запуск на синтетических данных.

## Почему DB dump и копия bucket по отдельности недостаточны

Приложение читает конкретную версию объекта, а не последний объект по key:

| DB reference                                           | Содержимое                                            |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `revisions.object_key/object_version`                  | single source или entrypoint bundle                   |
| `revision_files.object_key/object_version`             | все файлы bundle, включая entrypoint                  |
| ready `revision_derivatives.object_key/object_version` | собранный inline HTML                                 |
| `uploads.object_version`                               | staged single upload; key равен `tenant_id/upload_id` |
| `upload_files.object_key/object_version`               | staged bundle files                                   |

VersionId назначает storage provider. При записи тех же bytes в новый bucket он
изменится. Восстановленный DB dump со старыми VersionId неработоспособен, пока
references не переписаны.

Готовые revisions и ready derivatives неизменяемы. Текущий maintenance удаляет
только версии незавершённых uploads и истёкших pending derivative attempts;
committed source/derivative objects он не удаляет. Поэтому backup переносит
точный набор DB-referenced versions, а не всю историю bucket. Лишний rollback
orphan не является частью восстановления.

## Fail-closed политика

Snapshot отражает состояние только на своём cutoff. Если ссылку отозвали после
cutoff, восстановление DB «как есть» её оживит. MVP не вводит внешний durable
revocation journal. Вместо этого каждый restore до открытия listener обязан в
одной транзакции:

1. поставить `revoked=true` всем shares;
2. поставить `revoked_at` всем ещё активным `agent_connections`;
3. удалить `viewer_grants`, `grants`, `agent_connection_csrf` и `sessions`;
4. удалить незавершённые `login_challenges`;
5. не менять исходные revisions, files, manifests, receipts и audit.

После restore владелец входит заново и явно создаёт новые links/connections.
Старые recipient и agent tokens должны получать нейтральный отказ. Короткие
grant/session сроки не продлеваются.

Ротация только `LINK_KEY` не заменяет эту транзакцию: `/api/resolve` хэширует
предоставленный получателем token и сравнивает его с сохранённым
`shares.token_hash`. Старый distributed token продолжит совпадать независимо
от текущего `LINK_KEY`, если строка share осталась активной.

`LINK_KEY` всё равно входит в backup secrets. Он нужен для проверки
детерминированной связи `share.id -> token_hash` и для согласованного состояния
установки. Секрет хранится отдельно от dump и object archive, зашифрованным; в
manifest и логах остаётся только SHA-256 fingerprint. Первый drill требует
точный исходный secret и останавливается при несовпадении fingerprint. Отдельный
lost-key recovery mode можно определить позже; fail-closed поведение само по
себе не считается доказательством полного восстановления.

## Формат backup generation

Один immutable каталог имеет уникальный `backupId` и содержит:

```text
backup.json
database.dump
database.dump.sha256
objects.jsonl
objects.jsonl.sha256
objects/<sha256>
```

`backup.json` содержит version формата, UTC started/cutoff timestamps, Git
revision, список `schema_migrations`, source DB identity fingerprint, source
bucket identity fingerprint, число DB rows/object references/unique blobs,
общий размер, fingerprint `LINK_KEY` и checksums файлов. Ни DSN, ни credentials,
ни сам `LINK_KEY` туда не попадают.

`objects.jsonl` содержит для каждой уникальной source reference:

```json
{
  "key": "tenant/upload",
  "sourceVersionId": "opaque",
  "sha256": "64 hex",
  "size": 123,
  "roles": ["revision", "upload"]
}
```

Одинаковый `(key, sourceVersionId)` дедуплицируется. Если DB roles заявляют для
него разные size/hash, backup завершается ошибкой. Object archive адресуется по
content hash; межтенантная дедупликация существует только внутри зашифрованного
backup archive и не меняет runtime storage или quota.

Список references строится из одного остановленного состояния DB:

```sql
SELECT 'revision' AS role, object_key, object_version, size, sha256
FROM revisions
UNION ALL
SELECT 'revision_file', object_key, object_version, size, sha256
FROM revision_files
UNION ALL
SELECT 'derivative', object_key, object_version, size, sha256
FROM revision_derivatives
WHERE state='ready'
UNION ALL
SELECT 'upload', tenant_id::text || '/' || id::text, object_version,
       (request->>'size')::bigint, request->>'sha256'
FROM uploads
WHERE kind='single' AND object_version IS NOT NULL
UNION ALL
SELECT 'upload_file', uf.object_key, uf.object_version,
       (u.request->'manifest'->'files'->uf.file_index->>'size')::bigint,
       u.request->'manifest'->'files'->uf.file_index->>'sha256'
FROM upload_files uf
JOIN uploads u ON u.id=uf.upload_id
WHERE u.receipt IS NOT NULL OR u.reconciled_at IS NULL;
```

Каждая версия скачивается через `GetObject(Bucket, Key, VersionId)`. Backup
пересчитывает SHA-256 и размер bytes, сравнивает их с DB metadata и только затем
пишет archive. Ready derivative проверяется по собственным `size/sha256`.

`maintenance.ts` удаляет exact objects истёкшего/aborted bundle и ставит
`uploads.reconciled_at`, но сохраняет `upload_files` как metadata idempotency
tombstone. Такие rows намеренно не являются live object references и не входят
в archive. Missing version для committed revision/ready derivative/finalized
upload или ещё не reconciled staging всегда остаётся фатальной ошибкой.

## Получение согласованного snapshot

Первый local drill использует два полностью синтетических стека и не подключён
к рабочим DB/S3. Для будущего staging backup порядок такой:

1. Остановить app, viewer, worker и scheduled maintenance. Graceful shutdown
   должен завершить активные requests.
2. Убедиться, что в source DB нет app connections и открытых write
   transactions. Не использовать advisory lock: текущие writers его не берут.
3. Снять `pg_dump --format=custom --no-owner --no-acl`; проверить ненулевой exit
   status и удалить незавершённый output при ошибке.
4. Не возобновляя writers/maintenance, выгрузить reference manifest и все exact
   object versions, проверить bytes и checksums.
5. Сохранить encrypted `LINK_KEY` в той же backup generation и завершить
   `backup.json` только после всех проверок.
6. После durable upload готового generation разрешить writers снова.

Object PUT выполняется внутри некоторых DB transactions. Остановка writers и
ожидание завершения DB sessions обязательны: иначе dump может увидеть object
reference, когда bytes ещё не вошли в backup, или пропустить только что
зафиксированную revision. Orphan без DB reference допустимо не копировать.

Целевой интерфейс будущей команды:

```sh
umask 077
export DRILL_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export BACKUP_DIR="/secure/polka-backups/$DRILL_ID"

node --import tsx scripts/backup.ts create \
  --database-url-env DRILL_SOURCE_DATABASE_URL \
  --s3-endpoint-env DRILL_SOURCE_S3_ENDPOINT \
  --s3-access-key-env DRILL_SOURCE_S3_ACCESS_KEY \
  --s3-secret-key-env DRILL_SOURCE_S3_SECRET_KEY \
  --s3-bucket-env DRILL_SOURCE_S3_BUCKET \
  --link-key-env DRILL_SOURCE_LINK_KEY \
  --output "$BACKUP_DIR"
```

Команда принимает только имена environment variables, не значения, не
включает shell tracing и редактирует только новый backup directory. В MVP она
отказывается работать, если writers не объявлены остановленными явным
`--maintenance-window` guard и DB всё ещё имеет чужие активные sessions.

## Restore в новый storage

Target requirements:

- новый пустой PostgreSQL database;
- новый пустой private bucket с versioning `Enabled`;
- другие endpoint, database name, bucket и credentials;
- тот же commit/schema generation, что в backup;
- app/viewer/worker/maintenance ещё не запущены.

Restore сначала проверяет, что source и target identities различны. Он никогда
не использует `pg_restore --clean`, не удаляет source volumes/buckets и не
перезаписывает непустой target.

Порядок:

1. Проверить checksums backup generation и fingerprint отдельно полученного
   `LINK_KEY`.
2. Восстановить `database.dump` в пустую target DB через
   `pg_restore --exit-on-error --no-owner --no-acl`. До завершения object remap
   сеть target app закрыта.
3. Включить versioning target bucket. Для каждого unique object загрузить bytes
   под тем же key, с metadata `sha256`, получить непустой новый VersionId и
   немедленно перечитать exact version для проверки SHA-256/size.
4. Записать временную mapping table с `key`, `source_version_id`,
   `target_version_id`, `sha256`, `size`.
5. В одной DB transaction удалить `upload_files` только у незавершённых уже
   reconciled uploads, сохранив сами `uploads` как idempotency tombstones; затем
   проверить полное покрытие live references и переписать `object_version` в
   `revisions`, `revision_files`, ready `revision_derivatives`, `uploads` и
   оставшиеся `upload_files`.
6. В той же transaction выполнить fail-closed изменения доступа.
7. Проверить constraints, counts, schema versions и quota sums; только затем
   commit. При любой ошибке transaction откатывается, target остаётся закрыт.
8. Запустить offline verifier всех exact object reads. После его успеха поднять
   target app на отдельном loopback origin и выполнить acceptance.

Ready derivative защищён trigger `revision_derivative_ready_immutable`.
Restore transaction как владелец schema временно отключает только этот trigger,
обновляет только `object_version`, затем включает trigger до commit. PostgreSQL
DDL транзакционен; ошибка откатывает и updates, и состояние trigger. Все другие
constraints/triggers остаются включёнными.

Fail-closed SQL является обязательной частью будущего restore tool, а не
ручным post-step:

```sql
UPDATE shares SET revoked=true WHERE NOT revoked;
UPDATE agent_connections
SET revoked_at=COALESCE(revoked_at, clock_timestamp())
WHERE revoked_at IS NULL;
DELETE FROM viewer_grants;
DELETE FROM grants;
DELETE FROM agent_connection_csrf;
DELETE FROM sessions;
DELETE FROM login_challenges;
```

Целевой интерфейс:

```sh
node --import tsx scripts/restore.ts apply \
  --backup "$BACKUP_DIR" \
  --database-url-env DRILL_TARGET_DATABASE_URL \
  --s3-endpoint-env DRILL_TARGET_S3_ENDPOINT \
  --s3-access-key-env DRILL_TARGET_S3_ACCESS_KEY \
  --s3-secret-key-env DRILL_TARGET_S3_SECRET_KEY \
  --s3-bucket-env DRILL_TARGET_S3_BUCKET \
  --link-key-env DRILL_TARGET_LINK_KEY \
  --require-empty --fail-closed

node --import tsx scripts/restore.ts verify \
  --backup "$BACKUP_DIR" \
  --database-url-env DRILL_TARGET_DATABASE_URL \
  --s3-endpoint-env DRILL_TARGET_S3_ENDPOINT \
  --s3-access-key-env DRILL_TARGET_S3_ACCESS_KEY \
  --s3-secret-key-env DRILL_TARGET_S3_SECRET_KEY \
  --s3-bucket-env DRILL_TARGET_S3_BUCKET
```

Это контракт будущих команд, а не уже существующие scripts.

## Изоляция local drill

Drill использует два новых project names, сети, DB, buckets и named volumes:
`polka-drill-source-$DRILL_ID` и `polka-drill-target-$DRILL_ID`. Порты выдаются
явно и не равны локальным `54388`, `9038`, `4390`, `4391`. Все variables имеют
префикс `DRILL_SOURCE_` или `DRILL_TARGET_`; production-compatible generic
`DATABASE_URL`/`S3_*` в restore shell не экспортируются.

Перед любой записью tool проверяет:

- source DB identity != target DB identity;
- source `(endpoint,bucket)` != target `(endpoint,bucket)`;
- target DB не содержит user tables, target bucket не содержит versions/delete
  markers;
- target содержит sentinel с текущим `DRILL_ID`;
- hostname target listener loopback-only.

Исходный synthetic stack содержит один drill tenant, но backup/restore всегда
охватывает всю отдельную DB. Tenant-level `pg_dump` не поддерживается: связи с
accounts, sessions, audit, shares и operations делают выборочный dump хрупким.
Рабочая DB не мутируется и не используется для seed. Удаление после drill
разрешено только по совпавшему sentinel/project name и никогда не принимает
source identifiers.

## Acceptance fixture

До backup в synthetic source создаются:

- single HTML revision;
- four-file bundle revision и ready derivative;
- активный share с сохранённым test token только в памяти harness;
- уже revoked share;
- active owner session и agent connection;
- один finalized upload receipt и один безопасный staged upload;
- reconciled aborted bundle с сохранёнными dead `upload_files` metadata, чьи
  object versions уже отсутствуют;
- audit rows для capture, preview, share и revoke.

Backup намеренно снимается **до** отзыва активного test share. Затем source
share отзывается, чтобы смоделировать потерю событий после cutoff. Restore
старого snapshot обязан всё равно отказать старому recipient token благодаря
fail-closed transaction.

Acceptance target:

1. Число revisions/files/ready derivatives и их metadata совпадает с backup;
   dead `upload_files` reconciled bundle удалены, а upload tombstone сохранён.
2. Каждый DB-referenced target VersionId непустой, отличается от source
   VersionId и читается по exact `(key, VersionId)`.
3. SHA-256 и size всех source, bundle и derivative bytes совпадают; manifest
   hash и сумма `total_size` проходят текущую canonical validation.
4. `tenants.used_bytes` и `derivative_used_bytes` совпадают с восстановленными
   immutable rows и не изменились из-за remap.
5. Старый active recipient token и ранее revoked token оба получают одинаковый
   нейтральный отказ от `POST /api/resolve`.
6. Старые session cookie, viewer grant, grant и agent token не авторизуют запрос.
7. После нового login владелец видит и экспортирует исходные bytes, но share
   остаётся revoked, пока владелец явно не создаст новый link.
8. Новый link получает новый share id; старый token остаётся недействительным.
9. Status/replay старых agent operations не создаёт link и не меняет revision.
10. Maintenance на target не удаляет ни один committed source/derivative object;
    cleanup staged fixture затрагивает только его exact keys/versions.
11. Source drill stack остаётся доступен и неизменён restore-командами.

Для проверки `LINK_KEY` verifier пересчитывает ожидаемый `token_hash` для DB
shares и сравнивает его с сохранённым значением, не выводя token. Несовпадение
блокирует запуск. Recipient test передаёт token напрямую HTTP client и не пишет
URL/body в лог.

## Опасности и явные stop conditions

- Нельзя открывать target app до object remap и fail-closed commit.
- Нельзя считать bucket-level latest-object mirror достаточным: DB закрепляет
  VersionId.
- Нельзя копировать физический MinIO volume как переносимый backup между
  providers.
- Нельзя запускать migration поверх dump другой версии в первом drill. Upgrade
  restore — отдельный сценарий после доказанного same-version restore.
- Нельзя логировать environment, DSN, credentials, `LINK_KEY`, share/agent
  tokens или object bytes.
- Нельзя продолжать при missing reference, checksum mismatch, `VersionId=null`,
  непустом target или невозможности снова включить immutable trigger.
- Нельзя объявлять RPO/RTO по одному локальному drill; нужно измерение staging
  backup generation, upload, restore, verify и переключения.

## Evidence будущего запуска

Evidence сохраняет только backup id, commit, schema versions, timestamps,
counts, byte totals, checksums/fingerprints, длительности стадий и результаты
acceptance. Секреты, tokens, filenames пользователя и object contents туда не
попадают. Успешный отчёт отдельно фиксирует:

- cutoff и фактический RPO;
- время до verified DB+objects и время до healthy target;
- количество remapped VersionId;
- число принудительно отозванных shares/connections;
- результат сценария old snapshot -> old recipient denied;
- уничтожение только target drill resources по sentinel.
