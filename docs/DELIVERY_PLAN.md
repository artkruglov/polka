# План реализации Полки

Одна очередь нового продукта. На 13 сентября 2026 готов только документальный старт репозитория; все приёмки приложения ниже открыты. Старые T/M из Lanka — источники опыта, не статусы Полки. Ответственные — роли будущей работы, не выдуманная нанятая команда. Даты обещаем после первого законченного среза и оценки фактического темпа.

## Выпуски и условия перехода

| Этап | Результат | Условие перехода |
|---|---|---|
| M0 Основа и дорогие риски | Независимые app/API/DB/storage; три профиля viewer; право и ownership; исходные fixtures | Чистый запуск без Lanka; обычное чтение не выделяет Chromium; никто не читает чужой tenant; upload→immutable version контракт доказан |
| M1 Полка, папки и ссылки | Надёжная загрузка/возврат, папки, metadata search, быстрая ссылка, revoke/restore | Реальные разные аккаунты, обрыв загрузки, повтор, перезапуск сервера, доступ после отзыва и backup/restore; заявлены лимиты/скорость |
| M2 Полезный HTML-результат | A: поддержанный пакет; B: красивые данные/правка; recipient/copy | Автор самостоятельно делает работу, получатель видит нужную версию; HTML interaction не имитируется; mobile/a11y/стоимость приняты |
| M3 Совместная работа и агент | Комментарий → реальный агент → proposal → человек принимает | Проверены scope/replay/cancel/needs_input и конфликт с ручной правкой; каждый заявленный adapter принят отдельно |
| M4 Корпоративный пилот | Внутренняя поставка, SSO/роли/политики, offboarding, audit, templates, approvals | Оператор и выбранная команда проходят сценарии на разрешённых данных; нет обязательного внешнего шага; RPO/RTO/egress и поддержка записаны |
| M5 Расширение по использованию | Следующий период/аудитории, подборки/сигналы, источники/адаптеры, масштаб | Есть повторяемая задача и доказательство пользы; не добавляем всё ради количества функций |

Публичный первый выпуск — принятые M1+M2 и эксплуатационный допуск. Внутренний пилот может идти отдельным маршрутом, как только пройдены необходимые foundation/корпоративные gates, без внешнего личного хранения. M3/M4 не обязательны для публичного сценария «принести готовый HTML», но обязательны для соответствующих обещаний.

## Задачи с зависимостями и приёмкой

### P01. Независимый bootstrap
F01; разработка. Создать минимальные frontend/API/test/build/config, собственные миграции. Переносить только нужные модули с source hash/license/test. Зависимости: нет.
Готово: новый checkout запускается без Lanka, legacy imports запрещены автоматической проверкой; нет скрытой зависимости от старого runtimeRoot/DB/локального агента. README содержит проверенную команду, а не будущую.

### P02. Tenant, workspace, artifact и folder
F02/F06; backend. Разделить personal/organization security boundary, createdBy и owning tenant, default workspace, версии и folder tree. Зависимость: P01.
Готово: FK/queries не связывают чужие tenants; папка не образует цикл, перенос проверяет права; уход автора не означает удаление организации. Конкурентные изменения дерева имеют версионную проверку.

### P03. Identity и права
F03/F13; backend + product. Реальный личный вход, server session, membership, effective roles и capabilities; interface корпоративного IdP. Зависимость: P02.
Готово: два аккаунта изолированы, logout/revoke/account switch действуют, expired code/повтор ограничены; no arbitrary tenant in payload. Полноценный SSO/SCIM включать только с реальной интеграцией P23.

### P04. BlobStore и immutable ArtifactStore
F04; backend. Выбрать поддержанный storage profile, checksum/version pin, DB receipt, outbox и orphan reconciliation. Зависимость: P02/P03.
Готово: bytes/hash не меняются после receipt, staging grant не перезаписывает final blob, падение между storage и DB не теряет согласованность. Пройден тест concrete S3 backend, не только mock.

### P05. Надёжная загрузка
F05; full stack. Begin/parts/resume/finalize/abort, reservations, body/zip/format limits, diagnostics и progress. Зависимость: P04.
Готово: реальные обрывы/повторы/finalize race/expiry, quota и checksum mismatch, очистка parts; duplicate request возвращает один artifact. Превышение не выдаётся за успех.

### P06. Полка и папки
F06; frontend + backend. Empty state, list/cards, breadcrumbs, CRUD/move/trash/restore, pagination. Зависимость: P02/P05.
Готово: новая сессия открывает свои работы, права после move пересчитаны; на 10 000 synthetic metadata элементов нет загрузки всех обложек/узлов сразу. Массовые операции добавляются после одиночных транзакций.

### P07. Постоянная ссылка и grants
F03/F07; backend + UX. Resolver, pinned revision, audience/expiry/revoke, download/copy, unfurl policy. Зависимость: P03/P04/P10.
Готово: чужой/отозванный доступ, cache hit, active download и истечение grant имеют измеренный контракт; исходники/чат не раскрываются читателю; share не равен official approval.

### P08. Viewer и дешёвая доставка
F08/F19; platform + UX. Spike в M0, затем implementation трёх профилей. File/raster/PDF/known recipe выдаются подходящим безопасным способом; arbitrary JS — отдельный networkless runtime. Зависимость: P04/P07 для живого end-to-end.
Готово: ordinary viewer без контейнера на читателя; CDN/gateway/Range и cache authorization проверены; незнакомый HTML не получает origin/сеть app; profile limits и стоимость известны. Не продолжать массовый rollout произвольного JS без этого решения.

### P09. Красивый рецепт и собственная правка
F09/F15/F18; frontend + design. Один version-pinned report, guest draft/claim, изменения текста/чисел/источника, CAS и Undo. Зависимость: P03/P04/P08.
Готово: собственный полный отчёт сохраняется/открывается после restart; null/zero/units и длинные данные корректны; изменение черновика при входе/двух вкладках не теряется. Пять прежних entry-тестов — материал для переноса, не новая приёмка.

### P10. Классификация и policy enforcement
F10; backend/platform. В M0 — policy envelope и deny boundaries, до external share — проверка audience; M3 — model/image/provider routes. Зависимости: P02/P03.
Готово: inputs повышают classification, downgrade требует права, client/agent не обходят запрет; внутренние fonts/deps/telemetry не создают скрытый egress. Это policy enforcement, не обещание универсального автоматического DLP.

### P11. Аудит
F11; backend. Actor/delegation/run/target envelope и atomic outbox сразу; admin view/export позднее. Зависимость: P02.
Готово: сохранение/публикация/отзыв/agent mutation имеют правильного actor, replay не удваивает событие; audit/analytics/prompts разделены и не содержат credentials/grant URLs.

### P12. Жизненный цикл и offboarding
F12; backend/operations. Soft delete/restore/GC/references, expiry drafts/uploads, receipt reconciliation; корпоративное владение после отключения. Зависимость: P02/P04/P07.
Готово: удалённое не получает новых grants, а ранее выданные прекращают доступ в пределах принятого TTL/revoke SLA (для строгого профиля — gateway); GC не удаляет живой shared blob; disabled employee не продолжает run, компания сохраняет работу; backup retention/hold не путается с UI-корзиной.

### P13. Настоящий агент в интерфейсе
F13; agent integration. Один разрешённый adapter с events, questions, scopes, budget, cancel/recovery и полезным результатом. Зависимость: P03/P04/P10/P11/P20.
Готово: создать/исправить тестовый материал через реальную модель; потеря связи не запускает повторное платное действие; слабый агент может использовать понятный файл/recipe guide. Другой adapter — отдельная проверка, без обещания «любой».

### P14. Review и утверждение
F14; full stack. Anchored comments, base/current/candidate, content+visual diff, whole candidate accept сначала; independent partial groups позднее. Зависимость: P09/P11.
Готово: ручная правка не теряется от старого proposal; исчезнувший anchor помечен; comment не закрывается от одного ответа агента. M4: required approvals и Publisher enforced, agent denied через UI/API/MCP, новая revision не наследует approve.

### P15. Design packages
F15; design/platform. Curated recipe M2; M4 tenant library, assets/fonts, guide, fixtures и human certification. Зависимости: P08/P09/P10.
Готово: version pin, две различные design systems для corporate certification, long text/data corpus, explicit migration report; certified update не меняет опубликованное.

### P16. Источники и изображения
F16; backend/agent. Recipe data first; затем immutable snapshots, bounded extraction с anchors/status, разрешённые formats/OCR/connectors и image generation. Зависимости: P04/P10/P13 для модели.
Готово: число/asset имеют источник/hash/дату/права, parser/version и частичная ошибка видны; источники не становятся инструкциями, macros не исполняются; publish использует выбранный blob, не regeneration.

### P17. Следующий период, аудитория и копия
F17; full stack. Модель provenance в M1/copy M2; удобный повтор отчёта и audience variant по usage. Для модели нужны P02/P04; для копии M2 — P07/P09 и исходные данные рецепта P16; полный source extraction не блокирует эту копию. Расширенные варианты позднее используют соответствующие готовые части P16.
Готово: новый owner/tenant/default rights, source/data/content delta, старый выпуск неизменен; источники и private context не копируются без права; повтор не создаёт две работы.

### P18. UX и доступность
F18; design/frontend. Сквозная задача всех выпусков: экраны из INTERFACES, критические ошибки, mobile/keyboard, обложки и visual quality. Зависимость: работающий соответствующий срез.
Готово: записаны версия/viewport/шаги/скриншоты и исправления; человек самостоятельно выполняет J01/J02/J05/J06, подтверждает пригодность. Новый скруглённый UI сам не доказывает качество.

### P19. Скорость, стоимость и ёмкость
F19; platform. Reference environment, обычные reads отдельно от uploads/builds/interactive, mixed load/failure/revoke, global quotas и backpressure. Зависимость: P05/P07/P08.
Готово: SLO/профиль/предел записаны, обычный read не стартует compute, вспышка share traffic не блокирует авторов; добавление replica не умножает разрешённую квоту. Измерены cold/warm paths и целевые сети.

### P20. Контекст и действия MCP
F20; backend/agent. Опубликовать версионный contract discovery, каталог/папки, capabilities/recipes, scoped files/versions, uploads/patch/jobs/comments из [API_AND_AGENTS](API_AND_AGENTS.md). Зависимость: P02/P03/P04.
Готово: агент понимает разрешённый профиль и следующий шаг; UI/MCP один application layer; actual endpoint tested. Нет public-publish у agent actor; файловая проекция не обход ACL.

### P21. Поиск и кеши
F21; backend/frontend. Metadata search M1, FTS/vector по потребности; indexed tenant scope, access-version invalidation и stable pagination. Зависимость: P02/P03/P06.
Готово: move/revoke/offboarding не оставляют доступ через search/cache/thumbnail/count; затраты запроса измерены на synthetic large tenant, private title не появляется в autocomplete.

### P22. Полезные сигналы и распространение
F22; product/full stack. Activation/return/recipient с privacy-safe events; позже favorites/collections/reactions и attribution recipes. Зависимости: P07/P11.
Готово: viewer/copy/like не смешиваются, бот не считается полезным получателем, private collection не открывает элементы; настоящая повторная работа отделена от просмотров демо.

### P23. Поставка и корпоративный допуск
F23; operations. Reproducible images/config, backup/restore/upgrade, provider compatibility, logging/help; затем real IdP, admin/audit, egress, offboarding и операторский приёмочный лист. Зависимости: применимые M0–M3 и P12/P19.
Готово: другой оператор ставит на чистую среду без машины автора, восстанавливает данные, измеряет RPO/RTO; фактический внутренний routing и отключённые внешние providers доказаны. Apache/core не закрываются paywall; поддержка оговаривается отдельно.

### P24. Наследие, форматы и release truth
F01/F24; разработка/product. Отбирать старые идеи/fixtures, сохранять авторство/лицензии, переносимый пакет и capability matrix. Зависимости: постоянно.
Готово: никакой legacy bootstrap в новом app; old data не изменены; supported import/export совпадает с проверками; GitHub release/readme не обещают нереализованные функции. Новый repo versioning не выдаёт v0.10.0 Lanka за релиз Полки.

## Порядок ближайшей разработки

1. P01/P02/P03/P04 с минимальными P10/P11; spike P08/P19. Это одна рабочая основа, а не отдельные неделями живущие прототипы.
2. P05/P06/P07 → обычный файл в папке и ссылка, restart/revoke/restore; проверить P12/P18/P21.
3. P09 плюс HTML-путь P08, copy P17 → собственный результат A/B и получатель.
4. P19/P23 и реальные пользователи по LAUNCH. После этого ограниченный внешний выпуск.
5. P13/P14/P20 и выбранный внутренний сценарий; P15/P16/расширенный P23 по корпоративной приёмке.

Техническая цель завершается доказательствами пути; установка репозитория, прохождение unit tests и объём документации не означают завершение продукта. Публикация домена, расходы и маркетинговые рассылки выполняются отдельными явно порученными действиями.
