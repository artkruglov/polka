# B3: MCP для внешних агентов

20.09.2026. Контракт реализации, не готовое подключение. Цель: Codex CLI и Claude Code сохраняют оригинальный файл/bundle, получают receipt и разрешённую ссылку. Полка не запускает встроенную модель или чат. Основа: [ONBOARDING_SPEC](ONBOARDING_SPEC.md), [BUNDLE_SPEC](BUNDLE_SPEC.md).

## Transport и проверенные предпосылки

Выбрать stateless Streamable HTTP `/mcp` через официальный SDK v2: `@modelcontextprotocol/server` и `@modelcontextprotocol/fastify`, зафиксировать версии в lockfile. На дату проверки npm сообщает 2.0.0 для обоих; ничего не установлено. `createMcpHandler(factory, { legacy: 'stateless' })` обслуживает revision 2026-07-28 и legacy 2025 traffic; parsing/version negotiation/JSON-RPC errors/HTTP methods оставить SDK. Не писать собственный transport и не вводить legacy SSE endpoint. [SDK protocol support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28), [Fastify adapter](https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html).

Локально выполнены только `--version` и `mcp add --help`: Codex 0.153.4 поддерживает `--url` и `--bearer-token-env-var`; Claude Code 2.1.278 — `--transport http` и `--header`. Это подтверждение интерфейса настройки, **не end-to-end совместимости**. Конфиги/секреты не читались; login и модели не запускались. [Official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP](https://code.claude.com/docs/en/mcp).

Для Codex: `codex mcp add polka --url <MCP_URL> --bearer-token-env-var POLKA_MCP_TOKEN`. Для Claude использовать HTTP server с Authorization header в личной конфигурации; не помещать настоящий токен в prompt, git или примеры команд. UI выдаёт конкретную инструкцию после проверки выбранного клиента.

## Auth boundary

Отдельный Fastify listener/plugin root для MCP, без session-cookie auth. Существующий web Origin-check не ослаблять. CLI без Origin допускается; присутствующий Origin сверяется с явным allowlist, `null` и посторонний отклоняются. Host также проверяется; loopback HTTP локально, HTTPS self-host/cloud. Viewer origin не получает доступ к MCP. Bearer проверяется на каждом HTTP request и в service перед защищённым действием; session cookie, share grant и чужие provider tokens не принимаются.

Первый двухклиентный срез — явно обозначенный **CLI token mode**: owner через session/CSRF выдаёт случайный 32-byte token, видимый один раз; БД хранит hash, account/tenant, scopes, endpoint audience, expiry, revoked_at. TTL: 7 дней по умолчанию, максимум 30; rotation — новое подключение. Missing/expired/revoked → 401; недостаточный scope → 403. Revoke блокирует следующий вызов, включая retry прежнего idempotency key. Уже созданные shares отзываются отдельно.

Обновление 22.09: OAuth-режим для чат-коннекторов реализован по [MCP_CONNECTOR](MCP_CONNECTOR.md) (RFC 9728/8414/7591/8707, PKCE S256, ротация refresh); выданный доступ — та же строка agent_connections, поэтому service actor и проверки scope общие. Token mode не объявляется полной реализацией MCP OAuth authorization. Для общего remote onboarding добавить стандартный authorization server: Protected Resource Metadata, discovery, Authorization Code+PKCE, resource/audience binding, issuer/redirect validation; не писать свой OAuth вручную. Тот же service actor работает в обоих режимах. [Нормативная MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

`ServiceActor` несёт проверенные account/tenant/connection/scopes; tool input не задаёт tenant/actor. Mutating service повторно проверяет connection в транзакции с порядком locks tenant → connection → upload/artifact; revoke использует совместимый порядок. In-flight операция, уже удерживающая lock, может завершиться до revoke; следующий вызов после завершения revoke запрещён. Audit: actor_type=agent, on_behalf_of, connection_id, action/target; без tokens/prompts/content.

## Tools v1

Wire names с underscore; короткие стабильные schemas и structuredContent, без raw HTML в результатах.

| Tool | Scope | Контракт |
|---|---|---|
| `polka_context` | context | Tenant label, scopes, лимиты, реальные runtime/import capabilities, guide URI, API version |
| `polka_list` | read | Пагинация/поиск только tenant; metadata, без bytes/share secrets |
| `polka_capture` | capture | key, title, optional folder, manifest + files с utf8/base64; новый private artifact |
| `polka_status` | context | По key/uploadId — только операции данного connection; receipt/build outcome. Чужие tenant операции всегда скрыты |
| `polka_revise` | revise | Как capture плюс artifactId/baseRevisionId; CAS, новая immutable revision, ссылка сама не переключается |
| `polka_share` | share | key, artifactId, expectedRevisionId, TTL 1/7/30 дней; unlisted URL только после реального разрешённого share |
| `polka_revoke_share` | share | Конкретный shareId в tenant; идемпотентный отзыв |

Capture/revise используют существующие begin/put/finalize application services, не loopback HTTP. Клиент читает свои локальные файлы; server не принимает локальный path для чтения. Base64 декодируется строго, utf8 превращается в bytes; проверяются manifest hashes, ≤64 файла/5MiB исходных bytes и отдельный transport cap 8MiB. Предварительно проверить весь payload до reservation. Binary representation не прогонять через модель ради пересчёта hash: клиенту дать короткий guide/локальный helper для подготовки payload.

Idempotency capture сохраняет существующее tenant-wide key пространство: повтор восстанавливает тот же upload/receipt, изменённый canonical request → conflict; scope revoke проверяется до replay. Share требует отдельного operation receipt в транзакции с изменением shares: потеря ответа не создаёт новую ссылку и не отзывает предыдущую. Query/status не делает capture/build автоматически. Отсутствие share scope оставляет сохранение private; не пытаться выдать shareUrl через list/status.

Read-only resources: `polka://guides/capture-v1`, `polka://guides/html-inline-v1`, `polka://guides/sharing-v1`. Это серверные инструкции/ограничения; содержимое загруженных файлов не становится инструкцией tool. Capture receipt и готовность preview — разные поля; unsupported original остаётся сохранённым. Build делегируется принятому bounded worker lifecycle, не синхронному parser в API event loop.

## Реализация mutations: один service, одна транзакция на шаг

Контракт следующего пакета (не реализовано). В `artifacts.ts` вынести тела begin/put/finalize/status/abort для single и bundle в функции `...InTransaction(c, context, input)`. Они используют только переданный `PoolClient`, не вызывают `transaction`, `db.query` или публичный wrapper. Существующие web-функции остаются wrappers с прежними аргументами/DTO. MCP adapter вызывает те же тела через `withServiceActorTransaction`, а не оборачивает существующий transaction-owning service. Share/публикацию/отзыв аналогично вынести из `app.ts` в общий service; HTTP handlers только parse/auth/call/serialize.

`MutationContext` создаётся сервером: owner Actor, заблокированная tenant row, nullable connectionId и актуальные scopes. Для web wrapper сначала блокирует tenant; для MCP существующий helper блокирует tenant → connection, проверяет enabled owner, audience, expiry/revoke и scope, затем передаёт context. Общие тела далее блокируют upload → artifact → share по необходимости. PUT, abort и web share также переходят на этот порядок. Для publish/revoke можно сначала прочитать artifactId из share без lock, затем заблокировать artifact и перечитать share `FOR UPDATE` с повторной tenant/ID проверкой. Не брать tenant после upload/share. Revoke подключения остаётся tenant → connection. S3 PUT выполняется внутри защищённого upload шага до COMMIT; worker build сюда не включать.

**Привязка upload.** Добавить nullable `uploads.connection_id` и composite FK `(connection_id,tenant_id,account_id)` к соответствующему UNIQUE в agent_connections; существующие web uploads остаются NULL, backfill нет. Begin записывает connectionId в той же транзакции, что reservation. Tenant-wide `(tenant_id,idempotency_key)` сохраняется: если ключ существует у другого connection или web upload, MCP получает conflict без receipt/metadata; нельзя присвоить существующий upload новому подключению. Только затем сравнивается нормализованный request. PUT/finalize/abort/status повторно проверяют connectionId до возврата любого receipt. Owner web может управлять своими agent uploads; это не даёт другому service connection такого права.

Scope определяется действием: begin capture запрещает artifactId/baseRevisionId, revise требует оба; после lock upload PUT/finalize/abort проверяют `capture` либо `revise` по сохранённому request, а не по произвольному параметру клиента. Helper можно разделить на проверку connection и `requireScope(context, scope)`, но scope должен быть проверен в той же транзакции до bytes/receipt/изменений. `polka_status` требует context, ищет key/uploadId только в своём connection и возвращает upload progress/receipt и build outcome его revision, без share URL и без запуска работы. Все status-запросы и staged-file reads используют тот же c. Missing/foreign → одинаковый not found.

**Capture/revise orchestration.** Проверить весь payload/manifest/decoded limits до begin. Затем отдельные короткие транзакции: begin → каждый PUT → finalize, с повторной авторизацией на каждом шаге. Не держать внешнюю транзакцию на весь bundle и не запускать шаги параллельно под одним c. Разрыв/revoke между шагами оставляет durable upload для действующего retry либо maintenance; не стирать reservation при неизвестном результате S3. Существующие quota/CAS/pinned hashes/receipt и GC tombstones сохраняются. Audit получает nullable connection_id с FK; actor_id остаётся owner, agent attribution определяется connection_id, без содержимого файлов или токенов.

**Атомарный share receipt.** Добавить `agent_operations` с tenant/account/connection binding, operation=`share`, key, canonical request/hash и immutable result; UNIQUE `(tenant_id,operation,key)`, отдельное от upload namespace. Под tenant → connection сначала проверить scope и существующий receipt: другой connection или изменённый request → conflict. Новый запрос блокирует artifact, проверяет expectedRevisionId и использует общий share service, затем пишет receipt в той же транзакции. Result фиксирует shareId, revisionId, derivativeId и expiresAt; URL вычисляется из shareId только в ответе авторизованного share-вызова. Не вычислять result через последующий `getArtifact`, который может увидеть уже другую версию.

Если активная share уже указывает на expected revision, зафиксировать её в receipt; если она указывает на другую версию, вернуть conflict и не публиковать молча новую. MCP v1 revise не переключает share; отдельный publish tool пока не добавлять. Retry прежнего share key не создаёт и не открывает новую ссылку после её revoke/expiry: возвращает исходные идентификаторы и актуальное closed состояние, URL=null. `polka_status` не раскрывает share receipts; повтор `polka_share` снова требует share scope. Отзыв share идемпотентен и использует общий service, без удаления operation tombstone.

Приёмка refactor: прежние web single/bundle тесты; потерянный ответ после begin/PUT/finalize/share; changed request и чужой connection с тем же key; revoke между PUT и finalize и перед replay готового receipt; параллельные revise CAS и share/publish; S3→DB rollback с прежним GC; status не раскрывает другой connection или share URL. Проверить, что mutation path не открывает вложенную транзакцию и не обращается к pool из `InTransaction`.

## Activation и приёмка

`issued` после выдачи токена, `seen` после авторизованного MCP запроса, `verified` только после capture тестовой страницы и server receipt. Client name/version — заявленная metadata; реальная совместимость фиксируется отдельным протоколом запуска соответствующего binary. Отсутствие initialize в новой ревизии не препятствует активации; HTTP health-check недостаточен.

Принять отдельно Codex 0.153.4 и Claude Code 2.1.278: configured endpoint → context/guide → capture team-report → receipt → открытие owner → явный share → независимый recipient; revise сохраняет старую ссылку; потерянный ответ/retry не дублирует данные; revoke подключения запрещает следующий запрос. Записать фактическую negotiated protocol revision. Проверить wrong tenant/audience/Origin, scope, TTL, quota, CAS, malformed bytes, restart и unchanged web session protection. SDK-клиентские unit tests не заменяют два реальных клиента. Hosted interactive acceptance остаётся зависимостью выпуска, даже если remote MCP capture работает.

## Реализованный foundation-срез

Миграция009 и `apps/server/service-auth.ts`: `POST /api/agent-connections/csrf`, `POST /api/agent-connections`, `GET /api/agent-connections`, `POST /api/agent-connections/:id/revoke`. Mutations сохраняют web Origin-check; issue/revoke дополнительно требуют session-bound `x-polka-csrf`. Максимум20 active, все видны независимо от длины истории; возвращается до100 завершённых. TTL default7/max30, token32 random bytes хранится только hash. Audience сейчас ровно APP_ORIGIN/mcp. Helper перепроверяет actor в транзакции tenant→connection. Transport ещё отсутствует: следующие tools должны использовать этот helper, а не обходить его через существующие web routes.

## Management follow-up R09

Требование пользователя: полноценное управление работами через MCP, без
обязательного ручного подтверждения в web UI. Текущий server/UI пакет
[TRASH_SPEC.md](TRASH_SPEC.md) временно реализует owner routes первым; отсутствие
management tools после него — явный незавершённый долг, а не принятая human-only
граница продукта. Ближайший отдельный пакет добавляет rename/move/trash/restore
через агента; не заменять его инструкцией «откройте Полку и нажмите кнопку».

- Добавить отдельный `manage` scope в contracts, DB scopes constraint, token
  issue/list UI и guides. Старые токены не расширять автоматически. Уполномоченный
  токен с этим scope не требует нового human approval на каждый вызов.
- Tools `polka_update_artifact`, `polka_trash`, `polka_restore` используют общие
  InTransaction services. Tenant→connection recheck перед каждым изменением и
  replay, затем существующие upload/artifact locks. Actor берётся из token,
  не из аргументов. Expiry/revoke/disabled account → отказ до mutation.
- Metadata сохраняет expectedTitle/expectedFolderId CAS; trash/restore используют
  expectedLifecycleVersion/expectedRevisionId и точный retry из TRASH_SPEC.
  На 409 агент перечитывает состояние и принимает решение; скрытого retry с
  обновлённым CAS нет. Audit отличает agent/connection от human actor.
- `polka_list` получает явный фильтр `active|trashed`, по умолчанию active;
  trash discovery требует `read`, изменение — `manage`. Scope context/status не
  становится обходом tenant/connection доступа. Trash/restore не выдаёт share URL,
  не запускает preview, не отзывает connection и не восстанавливает старые shares.
- Acceptance: native клиент с `read+manage` находит, переименовывает/перемещает,
  отправляет в корзину и восстанавливает работу через tools без web действий;
  нет manage, чужой tenant, stale CAS, revoked/expired token и ABA retry дают
  корректный отказ без изменений. После restore old share/grants всё ещё закрыты,
  версии/bytes/quota сохранены. Выпуск новой ссылки по-прежнему требует `share`.

Это продолжение R09 management, не добавление permanent deletion или account
lifecycle R17. Пока пакет не реализован и не проверен реальным клиентом, не
объявлять полный MCP management завершённым.

### Implementation contract следующего пакета Sol

Уточнение 21.09.2026 после принятия trash backend: использовать существующие
`updateArtifactMetadataInTransaction` и `transitionArtifactLifecycleInTransaction`;
web wrappers не вызывать из внешней transaction. Подтверждение человеком на
каждую mutation не требуется. `manage` не подразумевает `read`, `capture`,
`revise` или `share`; для самостоятельного поиска и изменения выдать
`context+read+manage`. Default выдачи остаётся context+capture; manage opt-in.

| Tool | Scope | Strict input / результат |
|---|---|---|
| `polka_list` | read | Существующие query/folderId/limit/cursor + `state: active\|trashed` default active. Каждый item содержит title, folderId, latest revision metadata, trashedAt, lifecycleVersion; без share/token/bytes |
| `polka_get_artifact` | read | `{artifactId}` → та же безопасная metadata projection, включая корзину; neutral404 для чужого/несуществующего ID |
| `polka_list_folders` | read | `{cursor?,limit?}` limit1–25 default25 → `{items:[{id,name}],nextCursor}` для выбора существующей папки |
| `polka_update_artifact` | manage | `{key,artifactId,title?,folderId?,expectedTitle,expectedFolderId}`; title/folderId и CAS берутся из текущего metadata schema; хотя бы одно изменение обязательно |
| `polka_trash` | manage | `{artifactId,expectedLifecycleVersion,expectedRevisionId}` → существующий ArtifactLifecycleSnapshot |
| `polka_restore` | manage | Тот же lifecycle input/output; новые версии/ссылки автоматически не создаются |

`polka_get_artifact` не возвращает raw `getArtifact()` DTO: тот содержит share URL.
Нужна явная allowlist projection с запросом через текущий tenant. В корзине
preview capability недоступна; наличие сохранённого ready derivative не выдаётся
за разрешение запуска. Список folders — только существующие folders; создание и
удаление folders не добавлять в этот пакет. Missing folder проверяется общим service.

Active list сохраняет `(updated_at,id)`, trash list использует `(trashed_at,id)`;
в обоих cursor date содержит DB microseconds. Новые cursor envelopes включают
state; несовпадение state→400. Прежний `{date,id}` cursor принимать только для
active для совместимости. После смены state/query/folder клиент начинает с пустого
cursor. Folder cursor `(name,id)` строгий bounded base64url JSON. Запросы 25+1,
сортировка и сравнение используют одинаковый DB collation; никаких полных
tenant dumps ради списка. Новые metadata reads можно вынести в agent-management.ts.

**Idempotency различается по существующим контрактам.** Lifecycle tools не
получают отдельный key: exact retry expected+1/desired state возвращает тот же
snapshot без audit, а последующий ABA переход оставляет старый запрос409. Не
обходить эту проверку бессрочным operation receipt. Rename/move, напротив, требуют
key: после успеха expectedTitle уже изменился и обычный повтор CAS дал бы409.
Расширить `agent_operations.operation` значением `metadata`; прочие columns/FK и
unique `(tenant_id,operation,idempotency_key)` сохраняются.

Metadata transaction: `withServiceActorTransaction(actor,'manage',...)` → поиск
operation по tenant/metadata/key. Сначала connection binding, затем canonical
request/hash equality. Чужой connection или changed request→409 без disclosure.
Canonical request строится из parsed schema в фиксированном порядке с сохранением
различия omitted folderId и explicit null; после JSONB читать/канонизировать снова.
Если receipt отсутствует, вызвать metadata InTransaction, вставить request/hash и
result в тот же commit. Result `{artifactId,title,folderId}` описывает **применённую
операцию**, не гарантирует текущее состояние работы. Ответ
`{operation:'metadata',key,applied:result,replayed:boolean}`; при replay старый
result возвращается без mutation даже после следующего rename/trash. Для текущего
состояния агент вызывает get; никакого share URL или preview запуска в receipt.
Scope/expiry/revoke recheck выполняется до любого replay. Generic polka_status
остаётся capture/revise status, не расширять его чужими management receipts.

Все mutations передают `{id:verified.accountId,tenant:verified.tenantId,
connectionId:verified.connectionId}`. Сохраняется tenant→connection→service locks,
не держать worker/S3 I/O ради metadata. Общий audit уже пишет actor_kind/connection;
повтор успешной операции не пишет второй audit. Перед вызовом проверяются текущие
DB scopes, даже если tools/list был получен до revoke. Management tool hints:
readOnlyHint false; trash destructiveHint true (отзывает доступ), restore и
metadata false; hints не заменяют авторизацию.

Следующая свободная migration меняет только named scopes CHECK (max6 и allowlist
с manage) и operation CHECK. Без UPDATE scopes существующих connections. Catalog
миграций обновляется вместе с migration. `polka_context` добавляет management
capability, readOnly учитывает manage. Tool visibility зависит от scope; resource
`polka://guides/management-v1` объясняет CAS, receipt vs current state, trash quota
и неизменность старых ссылок. Token issue UI явно показывает manage и не выбирает
его автоматически. Старый локальный z.enum scopes в AgentConnections обновить.

Разрешённые файлы backend Sol: новая migration, packages/migrations.ts,
packages/contracts/index.ts, apps/server/agent-management.ts, mcp-server.ts,
service-auth.ts только при необходимости типа scope, tests/agent-management.test.ts,
tests/mcp-transport.test.ts, migrations.test.ts и точечное подключение tests в
package.json. `scripts/restore-drill.ts` — только синхронизация schema catalog/
проверяемой generation с новой migration, без расширения restore сценария.
Общие metadata/trash services менять только для необходимого reuse,
не копировать их реализации. UI scopeOptions/schema в AgentConnections.tsx и
guide copy — отдельный согласованный Luna пакет; app/main/health не затрагивать.

Acceptance: tools/list видимость read/manage отдельно; read-only старый token
не меняет данные после migration; metadata atomic receipt/replay/changed input/
cross-connection; no nested transaction; title/folder CAS и foreign folder;
lifecycle exact retry/ABA и старые links/grants closed после restore; revoke,
expiry, disabled account перед service call и replay дают отказ без mutations;
agent audit identity; list/get/folders не возвращают share secrets; active/trash
pagination одинаковых timestamps с microseconds и state mismatch. Проверить
оригиналы/версии/quota неизменными и старые web tests. После SDK/service tests
отдельно native CLI с read+manage выполняет get→rename/move→trash→list trash→restore
без web действия. Это не закрывает всё ещё отдельную приёмку второго клиента.
