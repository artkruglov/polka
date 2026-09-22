# R09: корзина и восстановление

> **Статус:** реализовано. Корзина, восстановление и закрытие ссылок работают в интерфейсе и через MCP.

Контракт реализации, 2026-09-21. Код ещё не реализован. R09 требует организовать
личную полку без потери версий; R17 отдельно требует export и account lifecycle.
Этот пакет добавляет обратимое перемещение работы в корзину. Permanent delete,
срок автоматической очистки, удаление аккаунта и очистка backups сюда не входят.

## Поведение и данные

- В корзину перемещается artifact со всеми версиями. Title, folder, latest
  revision, source bytes, manifests, receipts и ready derivatives сохраняются.
  `used_bytes` и `derivative_used_bytes` не уменьшаются. Корзина занимает место.
- Обычная полка и MCP list показывают только active artifacts. У владельца есть
  отдельный список корзины и read-only detail с версиями и скачиванием originals.
  Rename/move, новая revision, build, static/live preview и share в корзине запрещены.
  Восстановление возвращает прежнюю папку и все версии, но не открывает доступ.
- Все старые shares остаются revoked навсегда после restore. Новый доступ требует
  явного выпуска нового share ID/token. Старые recipient grants и owner viewer
  grants также не оживают. Уже доставленные браузеру bytes отозвать невозможно;
  гарантируется отказ новым запросам после commit, а не удаление полученной копии.

Добавить следующую свободную migration (не фиксировать номер до merge):
`artifacts.trashed_at timestamptz NULL`,
`artifacts.lifecycle_version integer NOT NULL DEFAULT 0 CHECK (...>=0)`.
Это отдельный CAS счётчик переходов active↔trash, не номер revision.
Индекс active shelf `(tenant_id,updated_at DESC,id DESC) WHERE trashed_at IS NULL`
и trash list `(tenant_id,trashed_at DESC,id DESC) WHERE trashed_at IS NOT NULL`.
DTO Artifact получает `trashedAt: string|null`, `lifecycleVersion: number`.
Не менять immutable revision/derivative schema и не добавлять cascade delete.

## API и переходы

Owner session endpoints, существующая Origin/CSRF граница:

- `POST /api/artifacts/:id/trash`
- `POST /api/artifacts/:id/restore`

Оба принимают strict `{expectedLifecycleVersion, expectedRevisionId}` и возвращают
минимальный snapshot `{id,trashedAt,lifecycleVersion}` прямо из transaction.
Другой tenant/disabled owner → neutral 404. Несовпадение версии состояния или
latest revision → 409 без изменений. Переход увеличивает lifecycle_version на 1.
Повтор с тем же expected version принимается без второй мутации/audit только
если текущее поколение ровно expected+1, desired state уже достигнуто и latest
revision совпадает. После дальнейших переходов старый запрос получает 409.

Trash transaction: owner/tenant lock; блокировка относящихся pending uploads
в порядке id; artifact lock и CAS; затем shares и pending derivatives в порядке id.
Tenant lock первый, как у всех нынешних writers; никаких вложенных transactions.
Service actor writers по-прежнему берут tenant→connection до upload/artifact.
Под одним commit:

1. Установить trashed_at и увеличить lifecycle_version/updated_at.
2. Отозвать все shares artifact, включая прежние версии.
3. Удалить viewer_grants **всех revisions artifact**, включая owner grants;
   затем recipient grants всех revisions/shares artifact. Порядок учитывает
   source_grant_hash FK. Не удалять sessions или connections владельца.
4. Пометить aborted только unreceipted uploads этого tenant с
   `request.artifactId = artifact.id`. Сохранять keys, metadata и idempotency
   tombstones для существующего maintenance; не выполнять S3 delete здесь.
5. Pending derivative attempts пометить истёкшими, сохранив attempt_id/state
   pending и reservation до штатного GC. Не обнулять reservation при возможном
   S3 orphan. Ready derivatives не менять.
6. Audit `artifact.trashed`; restore пишет `artifact.restored`.

Restore меняет только lifecycle state/updated_at, не очищает aborted у uploads,
не меняет revoked, не создаёт grants и не возобновляет worker. Новая revision
требует нового upload key. Истёкший pending build проходит прежний GC/retry путь.

## Доступ, гонки и реальные точки интеграции

`apps/server/artifacts.ts`: `getArtifact` оставляет owner detail доступным в
корзине, возвращает state; `readRevisionSource`/`exportRevision` сохраняют owner
скачивание. Не делать глобальный active-фильтр в source reader: он используется
и export, и builder. Active check нужен отдельно в mutation/build callers.
`beginUploadInTransaction`, `validateUploadTarget`, bundle begin/PUT/finalize и
single PUT/finalize проверяют active target под tenant lock. Не ограничиваться
begin: старый upload мог существовать до trash. Receipted replay не создаёт
версию и может вернуть прежний immutable receipt; он не означает active artifact.

`apps/server/app.ts`: default shelf SQL исключает trash; отдельный
`GET /api/trash?cursor=...` с лимитом 24+1 и microsecond `(trashed_at,id)` cursor.
Owner detail/revision list/download остаются tenant-bound; owner `/document`
отказывает для trash. `/api/resolve`, общий `granted` для recipient bytes/document
проверяют active artifact через revision/share, а не только revoked.

`apps/server/shares.ts`: `lockArtifact`/publish/share требуют active. Старые
`agent_operations` receipts не менять; replay старого share возвращает closed
с `url:null` и после restore. Новый idempotency key нужен для новой ссылки.
Revoke остаётся допустимым и идемпотентным в любом состоянии.

`apps/server/live-viewer.ts`: active artifact требуется при owner/recipient
issuance **и** в `authorizedRevision`. Выдачу любых grants (также `/api/resolve`)
перевести в короткую transaction tenant→artifact→share с повторной проверкой
active/share/session внутри неё. Это сериализует issuance с trash: grant либо
создан до trash и удалён, либо issuance получает отказ. Один SQL active predicate
без общей блокировки недостаточен: параллельная вставка owner grant могла бы
завершиться после удаления grants и снова работать после restore.
Read-запросы, авторизованные до trash commit, могут завершиться; новых grants
или запросов после commit это исключение не разрешает.

`apps/server/bundle-derivatives.ts` и `agent-preview.ts`: prepare и каждый runner
transaction проверяют active artifact. Зафиксировать lifecycle_version при
prepare, повторно сравнивать перед result/ready PUT и non-ready settlement;
worker остаётся вне SQL transaction. Проверка поколения исключает завершение
старого worker после быстрых trash→restore. До S3 ready PUT остаются прежние
tenant/derivative locks. Не менять accepted orphan cleanup и quota accounting.

`apps/server/agent-capture.ts`: revision target active checks общие с web services;
fresh capture без artifactId создаёт новую active работу. `statusForAgent`
сохраняет connection binding и receipt для восстановления после потерянного
ответа; добавить artifactState (`active`/`trashed`) для saved receipt и не
показывать trash preview как доступный. `mcp-readonly.ts` list active-only;
prepare/share для trash отказывают. Новые MCP management tools и `manage` scope
не входят только в текущий server/UI пакет. Это временная граница реализации,
не human-only политика: полное управление через агента остаётся требованием.
Ближайший follow-up описан в [MCP_IMPLEMENTATION_SPEC.md](MCP_IMPLEMENTATION_SPEC.md#management-follow-up-r09).
Авторизованный агент выполняет rename/move/trash/restore без обязательного
подтверждения человеком, через те же tenant/CAS services.

## UI и acceptance

В `App.tsx` добавить доступную из полки корзину; у active artifact действие
«В корзину» с коротким подтверждением: версии сохранятся, ссылки перестанут
работать. Trash detail показывает дату, занимаемый размер, версии, скачать,
«Восстановить»; live iframe демонтируется после успешного trash. Нет обещания
освобождения места/удаления через N дней. Restore: «Работа восстановлена.
Старые ссылки закрыты»; новая отправка выполняется прежним явным действием.
409 обновляет snapshot и просит повторить осмысленное действие; не autoretry.
Смена view/query сбрасывает cursor. После мутации refetch active/trash/detail.

Обязательные integration assertions:

1. Cross-tenant и disabled owner не читают/не меняют trash; CAS, точный retry и
   ABA trash→restore→trash не позволяют старому запросу менять новое состояние.
2. Single + bundle с несколькими revisions: trash/restore сохраняют все IDs,
   hashes, VersionIds, manifests, ready derivative и quotas; owner exports до,
   в корзине и после восстановления byte-identical.
3. Old shares, recipient grants, owner/recipient live grants не работают в
   корзине и после restore; fresh explicit share получает новый ID; старый
   MCP share receipt остаётся closed. Barrier test issuance↔trash проверяет
   отсутствие grant, который оживает после restore.
4. Pending single/bundle revise uploads становятся aborted, PUT/finalize/replay
   не добавляют revision и после restore; committed capture receipt остаётся
   прежним со state=trashed. Fresh capture без target работает.
5. Worker barrier: trash во время worker, затем restore до его завершения;
   старый результат не становится ready/не списывает quota. GC убирает только
   orphan/staging keys; committed source/ready derivative сохраняются.
6. Active web/MCP search и pagination не включают trash; trash cursor сохраняет
   microseconds; owner UI не оставляет запущенный iframe после trash, restore
   не включает share автоматически. Keyboard/mobile smoke для обоих состояний.

## Принятые продуктовые решения и оставшиеся границы

R09 не задаёт owner-download policy в корзине: этот контракт разрешает export
ради R17, но запрещает выполнение preview до restore. Папки сейчас не удаляются,
поэтому исходный folder_id сохраняется; будущая folder deletion требует отдельной
политики. Корзина не освобождает quota и не имеет срока хранения. Эти решения
нужно отражать в интерфейсе, а не выдавать за завершённый account deletion R17.

## Следующий backend пакет после restore drill

Сначала migration/DTO и `artifact-trash.ts`: общие InTransaction переходы с
переданным PoolClient/Actor и owner wrappers. Не делать service, который требует
session cookie внутри business logic: следующий MCP adapter передаст проверенный
ServiceActor через существующий transaction runner и запишет agent audit identity.
Затем последовательно закрыть upload/share/build/grant access paths из этого
контракта, добавить thin HTTP handlers/list и integration assertions 1–5.
Выпуск кнопок UI зависит от прохождения backend доступа/гонок, а не наоборот.
Общая auth/transaction логика не копируется в будущие MCP tools. Реализацию не
начинать до завершения отдельного restore пакета и назначения root.
