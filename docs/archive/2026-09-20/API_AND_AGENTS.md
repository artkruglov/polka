# Контракты приложения и агентов

Проект контракта P01/P13/P20/P25/P29/P34/P35, **не каталог уже работающих endpoints**. Имена операций и capabilities технические; в ответах агенту человеку и в интерфейсе используются слова [словаря](../../reviews/2026-09-14-fable-brand-update/review.md#словарь): `artifact` — «работа», `share.invite` — «отправить одному человеку», `share.link` — «открыть по ссылке», `share.team` — «показать команде», `publication.submit` — «показать всем: отправить снимок на проверку», `remix.create` — «взять за основу», `bookmark` — «сохранить». Semantics `self / ask / deny` этим решением не менялись. С 14 сентября 2026 ([agent delegation](../../reviews/2026-09-14-opus-agent-delegation/review.md)) агент — исполнитель по поручению человека: у каждой capability режим `self`, `ask` или `deny`, вычисляемый сервером — [матрица](AGENT_CAPTURE_AND_IMPORT.md#capabilities-агента-self-ask-deny), [модель](DOMAIN_MODEL.md#7-агент-как-исполнитель-по-поручению). Столбец «Агент» ниже показывает режим в Light preset «Помощник»; в preset «Только сохранять» всё, кроме `capture`/`inbox`/`gallery`, — `deny`. *Superseded:* прежнее «агент в Light получает только `capture`, `inbox.read`, `gallery.read`» и строка «Human-only». Операции `file.read`, `proposal.*`, `comment.*`, `run.*` относятся к человеку через UI/API или к агенту M3/Enterprise по политике. Раздел «Чат в Полке» описывает отложенное решение. Названия ниже предлагаются для новой реализации и закрепляются схемами до первого adapter. UI, HTTP API, MCP и CLI обращаются к одному application layer; транспорт не создаёт дополнительные права. [Архитектура](ARCHITECTURE.md) определяет хранение, grants и исполнение.

## Контекст, который должен понять агент

Discovery возвращает версию протокола, выбранный tenant/workspace, роль/доступные действия, лимиты, поддержанные форматы/профили и ссылки на короткие guides. Не загружает все файлы компании в prompt. Пагинация каталога и чтение отдельных разрешённых файлов сохраняют границы контекста.

Recipe guide содержит задачу, подходящие входы, живой пример, поддержанные правки, ограничения, критерии дизайна и разрешённый способ проверки. Агенту не нужно угадывать скрытые slide поля. Более слабая модель может загрузить готовый пакет либо заполнить данные известного рецепта; качество не зависит только от свободного кодирования.

| Семейство операций | Что делает | Ограничение | Агент (Light, «Помощник») |
|---|---|---|---|
| `workspace.list`, `workspace.get_context` | Разрешённые пространства, возможности, политика, preset и effective modes, guides | Не раскрывать названия чужих tenants; выбор workspace не даёт membership | self (только пространство подключения) |
| `folder.list/create/rename/move` | Организация работ с cursor и ожидаемой версией дерева | Проверка effective permissions; cross-tenant move запрещён | self — `library.organize` |
| `folder.trash/restore`, `artifact.trash` | Корзина и восстановление | Purge — отдельная человеческая операция | ask — `library.trash`; restore self |
| `artifact.list/search/get`, `artifact.rename/move/set_category/tag` | Метаданные/версия/статус/preview и owner-only адрес сохранённого candidate; организация | Search/count проходят те же права; этот адрес не создаёт публичный share | self — `library.organize` (sensitive без названия) |
| `artifact.get_manifest`, `file.read` | Точная revision, пути, hashes и разрешённые excerpts | Не раскрывать private sources по праву на viewer; оригинальные файлы — недоверенные данные | self для своих captures и AgentHandoff; иначе ask — `library.read` |
| `upload.begin/status/finalize/abort` | Ограниченные grants, загрузка/продолжение и immutable receipt | Сервер назначает ownership/quota; повтор finalize не создаёт новую работу | self внутри `capture` |
| `artifact.create_draft`, `proposal.submit` | Новый draft/candidate с проверенными файлами и base revision | Agent не переписывает main/approved/released; новый материал агента виден как candidate | self — `capture`; `proposal.submit` M3 по политике |
| `artifact.edit`, `proposal.accept/reject` | Поддержанная ручная правка или решение по candidate | CAS; accept требует human principal и текущие права, история сохраняется | accept — **deny** |
| `preview.request/status/get` | Подготовленный результат и issues/ссылки | Тип preview назван точно; request не может обходить runtime quota | self для доступных работ |
| `artifact.capture` | Одним вызовом сохранить inline/package/поддержанный URL результат агента в private revision | Внутри может использовать upload flow; idempotency/receipt обязательны; доступ не открывает | self — `capture` |
| `import.preview/commit/status` | Проверить и сохранить поддержанную публичную ссылку отдельным snapshot | Allowlist/SSRF/лимиты/явный commit; cookies, app session и private provider data запрещены | self как `capture` URL (после E4) |
| `recipe.list/get_contract` | Разрешённые версионные recipes и условия применения | Certified/trusted статус берётся из registry, не из содержимого архива | self (deferred вместе с рецептами) |
| `comment.list/add/resolve` | Замечание к revision/route/anchor, контекст и статус | Право комментировать не даёт source-copy; agent reply не закрывает thread автоматически | M3: `comments.read` по политике; resolve — человек |
| `run.start/get/cancel/answer` | Реальный scoped adapter, события и ответ на вопрос | Capabilities, бюджет, срок, отмена и needs_input enforced server-side | Deferred |
| `share.inspect` | Аудитория, срок, revision и история ShareGrant | **Token и полный URL никогда не возвращаются агенту**; человеку — только в UI Полки | self (без token) |
| `share.create_link`, `share.reenable`, `share.extend` | «По ссылке», повторное включение, продление | Адрес появляется у человека в Полке после выполнения | ask — `share.link`, делегируется |
| `share.update_target` | «Обновить по ссылке» | CAS по generation | ask — `share.retarget`, делегируется |
| `share.invite`, `share.team`, `share.company` | Приглашённые, «В команде», «В компании» | Подтверждённые identities; membership не создаётся | ask; делегирование — Enterprise по политике |
| `share.narrow`, `share.revoke` | Сузить или отозвать доступ | Свои (созданные по запросу подключения) — self; чужие — ask | self — `access.reduce` / ask — `access.reduce_other` |
| `share.set_discovery` | Index opt-in | Только `published`; sensitive — недоступно | ask, не делегируется |
| `inbox.list/get` | Свои captures, receipts, intents и работы, переданные через AgentHandoff | Остальная библиотека — через `library.organize`/`library.read` | self — `inbox.read` |
| `gallery.search/get/read_bundle` | Опубликованные PublicationSnapshot; bundle — только при `remix_allowed` | Только `published`; в Enterprise — библиотека компании | self — `gallery.read` |
| `bookmark.create/delete`, `remix.create` | «Сохранённое», «Взять за основу» | Bookmark не даёт доступа; remix только `remix_allowed` | self (M1.1) |
| `publication.draft_create/update`, `publication.withdraw_draft` | Черновик снимка: revision, публичные метаданные, обложка, предложение remix policy | Черновик не виден никому, кроме автора | self — `publication.prepare` (M1.1) |
| `publication.submit` | Отправка черновика или обновления на модерацию | Подтверждение прав на материал делает человек на странице подтверждения | ask, не делегируется |
| `publication.withdraw` (`published`) | Снять с витрины | Возврат — только новой модерацией | ask — `access.reduce_other` |
| `intent.get/list/cancel` | Статус своих ActionIntent, отмена своего запроса | Без token; stale/expired видны с причиной | self |
| `intent.approve/reject`, `delegation.create/revoke`, `handoff.create/revoke`, `connection.set_preset/pause/revoke`, `agents.emergency_stop` | Решения человека о поручениях и подключениях | Требуют человеческую сессию UI; для sensitive и Enterprise — повторный вход по политике | **deny** |
| `agent_log.list` | Журнал действий агента для доверителя | Проекция AuditEvent без token и содержимого | Человек; агенту — только свои intents |
| Всегда `deny` для агента: `publication.attest_rights`, `reaction.*`, `report.create`, `moderation.*`, `sensitivity.lower`, `membership.*`, `release.approve/publish`, `design.certify`, `artifact.purge`, `account.*` | Права на материал, реакции, жалобы, модерация, понижение чувствительности, участники, официальный выпуск, удаление | Не экспортировать как agent tools; сервер отклоняет agent actor и обход | deny |

Внешний агент может сам подготовить распространение и запросить его, но не может включить ссылку или подать снимок без подтверждения человека или ограниченного поручения.

Примеры запросов человека в чате и ожидаемых ответов агента (Light, preset «Помощник»; тексты — из [прототипа `/bring#connections`](INTERFACES.md#6-подключения-агентов-и-preset-permissions)):

| Фраза в чате | Вызовы | Ответ агента человеку |
|---|---|---|
| «Положи этот планировщик на Полку» | `artifact.capture` → `executed` | «Сохранил “Планировщик недели”. Сейчас его видите только вы» |
| «Поделись отчётом с Иваном и подготовь публикацию» | `publication.draft_create` → `executed`; `share.invite` → `pending_approval`; `publication.submit` → `pending_approval` | «Черновик снимка подготовлен. Отправить работу Ивану и показать всем — нужно ваше подтверждение в Полке: <адрес запроса>» |
| «Отправь Маше ссылку на план поездки» | `share.create_link` → `pending_approval`; при активной Delegation — `executed`, basis `delegation:<id>` | «Нужно ваше подтверждение» или «Сделано по поручению до 14.10: ссылка открыта до 21.09; скопировать её можно в Полке» |
| «Положи дашборд магазина в библиотеку команды» | `share.team` → `pending_approval` (не делегируется) | «Показать команде — нужно ваше подтверждение в Полке» |
| «Дай Маше ссылку на мой трекер сна» | `share.create_link` на sensitive → `pending_approval` без делегирования | «Работа отмечена “Личное”: нужно ваше подтверждение с предупреждением» |
| То же в preset «Только сохранять» | `share.*`, `publication.*` → `denied` | «Режим “Только сохранять” этого не разрешает; режим меняете вы в подключениях Полки» | Не каждый инструмент общего API доступен в MCP. CLI с человеческой identity и agent checkout имеют различимые actor types; происхождение действия не определяется словом в payload.

## Общие поля и ошибки

- Контекст identity/tenant/actor сервер получает из сессии или scoped token. `tenantId` в произвольном запросе не переопределяет авторизацию.
- Мутации имеют `requestId` и fingerprint намерения. Тот же ID с другим payload — конфликт, с прежним payload — прежняя committed receipt.
- Изменение содержимого содержит `baseRevision`/`expectedGeneration`; имена файлов нормализуются, выход из package path запрещён. Сохранение bytes и обновление метаданных завершается проверяемой квитанцией.
- Ошибка различает validation, permission/policy, conflict, quota, expired upload, unsupported format, cancelled и временную недоступность. Для неавторизованного человека сообщение не подтверждает существование чужого объекта.
- Мутация агента принимает `dryRun: true` и возвращает effective mode, коды причин и эффект без выполнения. Результат мутации агента — ровно одно из `executed` (receipt, `basis = preset | delegation:<id> | approval:<receiptId>`), `pending_approval` (`intentId`, адрес страницы подтверждения в Полке, `expiresAt`), `denied` (код причины). `pending_approval` не является успехом действия: агент не сообщает человеку «ссылка создана».
- Сервер выводит `actor` и `on_behalf_of` из scoped token подключения; поля в payload их не переопределяют. Каждое действие агента пишет AuditEvent с actor, on_behalf_of, capability, режимом, basis, intent, target/revision, результатом и policy version.
- Ответ содержит `operationId`, состояние и разрешённое следующее действие. «Файл сохранён», «просмотр готов» и «агент завершил» не объединяются в один success.
- Durable events имеют cursor/sequence, object/revision, actor, correlation и timestamp. Replay после reconnect не повторяет действие. События не содержат credentials, private prompts или полные signed URLs.

Пагинация стабильна при добавлении новых работ; event stream сообщает, что список изменился, а клиент перечитывает нужный диапазон. Большие binary downloads не проходят через текст MCP; выдаётся разрешённая передача файла с проверкой hash/размера. Grant сам является секретом доступа и не попадает ни в какой ответ агенту: ни в receipt, ни в intent, ни в события.

## Чат в Полке с агентом пользователя

> **Deferred 2026-09-14** — [отложенные решения](DELIVERY_PLAN.md#отложенные-решения). Контракт сохранён для будущего возврата; ранний сценарий «поручить агенту» закрывает AgentHandoff.

Порядок: сначала file/revision API и внешний MCP-клиент save/read/proposal с приватной ссылкой владельцу; затем описанные ниже runner/connector. [Контракт распространения](SHARING_AND_DISCOVERY.md) общий для UI/API/MCP. Remote MCP не требует, чтобы Полка сама умела запускать модель.

**MCP предоставляет инструменты и контекст, а не универсальное зеркалирование чужого чата.** Для каждого продукта агента нужен документированный adapter. Он отдельно подтверждает запуск/отмену/вопросы/события и права на историю; общий «OpenAI-compatible» endpoint сам не доказывает поддержку agent workflow.

Предлагаются два проверяемых маршрута:

1. Компания размещает runner рядом с Полкой либо подключает разрешённый внутренний agent endpoint. Человек выбирает подключение; run получает scope одной работы/пространства и policy.
2. Локальный connector пользователя устанавливает исходящее соединение с Полкой, проходит pairing и получает ограниченное поручение. Облачный сервис не пытается обратиться к `localhost` ноутбука и не требует открыть входящий порт. Пока устройство отключено, UI показывает «ожидает подключения», а не имитирует ответ агента.

В обоих случаях Полка хранит своё поручение, события и результаты. Runner получает lease с fencing token; timeout/reconnect не запускает второе исполнение оплачиваемого действия. Неопределённый результат проверяется по receipt/provider operation ID, а не слепо повторяется. Отмена останавливает дальнейшие действия и отзывает lease/grants там, где это поддержано; уже сохранённый candidate остаётся видимым. Отсутствие возможности прервать provider call показывается явно.

Первый adapter выбирается по доступному реальному агенту и его официальным интерфейсам, а не по предполагаемому совпадению названий моделей. Перед реализацией подтвердить текущую документацию выбранного агента. Импорт или двустороннее зеркалирование всей истории IDE — отдельное согласованное расширение; без него чат Полки уже может показывать реальные задания и изменения этой работы.

## Минимальная сквозная приёмка M3

Человек через интерфейс подключает реального разрешённого агента, выбирает папку/работу, просит исправить текст/визуал. Агент получает актуальный context/recipe, при необходимости задаёт вопрос, загружает candidate и показывает изменение. Между запросом и ответом человек делает ручную правку; старый candidate не перезаписывает её. Отключение connector, повтор доставки, отмена, смена аккаунта и отзыв прав проверяются отдельными шагами. После перезапуска Полки сохраняются поручение, выбранные файлы, история и результат, а не только финальное сообщение.

## Быстрые входы M1.2

[Контракт capture/import](AGENT_CAPTURE_AND_IMPORT.md) делает агентский сценарий первым классом. `artifact.capture` принимает результат агента или provider URL, но не получает capability публикации. Для ссылок сначала возвращается безопасный preview; только явный пользовательский commit создаёт private snapshot. Повтор по `requestId` возвращает прежний receipt. Импорт не является универсальным URL-прокси и не исполняет HTML в origin Полки.

## Подготовка публикации M1.1

[Авторская витрина](COMMUNITY_PUBLICATION.md) использует общий application layer: PublicationSnapshot с immutable revision, просмотр её состояния, авторский withdrawal, ModerationCase для review/hide ([DOMAIN_MODEL](DOMAIN_MODEL.md)). Agent actor может сохранить revision-кандидата через `capture` (в том числе версию с демо-данными для sensitive-работы) и сам подготовить черновик снимка (`publication.prepare`); подача — `ask`: человек видит ровно тот снимок и сам подтверждает права на материал. Moderator approval, подтверждение прав и обход политик компании агенту недоступны (`deny`). Сам факт вызова MCP не делает содержимое публичным. Эти инструменты пока не реализованы.
