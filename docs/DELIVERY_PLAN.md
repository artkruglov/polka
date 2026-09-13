# План реализации Полки

Одна очередь нового продукта. На 13 сентября 2026 готовы документы и кликабельный UX-прототип; все приёмки приложения ниже открыты. Старые T/M из Lanka — источники опыта, не статусы Полки. Ответственные — роли будущей работы, не выдуманная нанятая команда. Даты обещаем после первого законченного среза и оценки фактического темпа.

## Выпуски и условия перехода

| Этап | Результат | Условие перехода |
|---|---|---|
| M0 Основа и дорогие риски | Независимые app/API/DB/storage; три профиля viewer; право и ownership; исходные fixtures | Чистый запуск без Lanka; обычное чтение не выделяет Chromium; никто не читает чужой tenant; upload→immutable version контракт доказан |
| M1 Полка, просмотр и ссылки | Поддержанный HTML/file, папки, поиск, live/pinned link, noindex, revoke/restore. Начало: owner/unlisted; закрытые приглашения отдельным срезом | Принят viewer для заявленного формата, S01–S09; для приглашений S10. Реальные аккаунты, повтор/restart/restore, целевые сети и лимиты |
| M2 Создание и улучшение | B: красивый отчёт из примера, свои данные/правка; разрешённая copy | Автор делает собственный результат; source edit/CAS, guest draft/claim, mobile/a11y и полезная копия приняты |
| M3 Совместная работа и агент | Комментарий → реальный агент → proposal → человек принимает | Проверены scope/replay/cancel/needs_input и конфликт с ручной правкой; каждый заявленный adapter принят отдельно |
| M4 Корпоративный пилот | Внутренняя поставка, SSO/роли/политики, offboarding, audit, templates, approvals | Оператор и выбранная команда проходят сценарии на разрешённых данных; нет обязательного внешнего шага; RPO/RTO/egress и поддержка записаны |
| M5 Расширение по использованию | Следующий период/аудитории, подборки/сигналы, источники/адаптеры, масштаб | Есть повторяемая задача и доказательство пользы; не добавляем всё ради количества функций |

Первый внешний выпуск — принятый ограниченный M1 и эксплуатационный допуск; M2 его не блокирует. Внешняя доступность сервиса не означает индексируемые работы: в M1 материалы не добавляются в каталог, ответы содержат noindex. Индексируемая публичная публикация — S12/M5; лендинг может индексироваться раньше. Внутренний пилот требует соответствующих S11/P23, без обязательной внешней пробы.

Сценарии S01–S12 — в [SHARING_AND_DISCOVERY](SHARING_AND_DISCOVERY.md). [Интерфейс](INTERFACES.md) и [кликабельный прототип](design/polka-interface.html) показывают состояния, а не готовую авторизацию. Из обсуждения Opus приняты упрощение первого среза и явное обновление ссылки; исполнение приватного HTML с сетью не разрешено автоматически.

## Задачи с зависимостями и приёмкой

[Переход от прототипа к продукту](PROTOTYPE_TO_PRODUCT.md) уточняет P01/P07/P08/P18/P23: UI и typed client contract → HTTP adapter и настоящие аккаунты/storage → воспроизводимая поставка. [Редизайн с Opus 5](DESIGN_REVIEW_2026-09-13.md) — проверка D0; он не закрывает M0/M1 и не добавляет отдельную параллельную продуктовую ветку.

### P01. Независимый bootstrap
F01; разработка. Создать минимальные frontend/API/test/build/config, собственные миграции. Переносить только нужные модули с source hash/license/test. Зависимости: нет.
Готово: новый checkout запускается без Lanka, legacy imports запрещены автоматической проверкой; нет скрытой зависимости от старого runtimeRoot/DB/локального агента. README содержит проверенную команду, а не будущую.

### P02. Tenant, workspace, artifact и folder
F02/F06; backend. Разделить personal/organization security boundary, createdBy и owning tenant, default workspace, версии и folder tree. Зависимость: P01.
Готово: FK/queries не связывают чужие tenants; папка не образует цикл, перенос проверяет права; уход автора не означает удаление организации. Конкурентные изменения дерева имеют версионную проверку.

### P03. Identity и права
F03/F13; backend + product. Реальный личный вход, server session, membership, effective roles и capabilities; interface корпоративного IdP. Зависимость: P02.
Готово: два аккаунта изолированы, logout/revoke/account switch действуют, expired code/повтор ограничены; no arbitrary tenant in payload. Полноценный SSO/SCIM включать только с реальной интеграцией P23.

Следующий закрытый share-срез M1: подтверждённые invited identities, scoped/expiring одноразовый invite, wrong-account/replay/revoke. S02/S10 обязательны до показа работающего режима «Приглашённые».

### P04. BlobStore и immutable ArtifactStore
F04; backend. Выбрать поддержанный storage profile, checksum/version pin, DB receipt, outbox и orphan reconciliation. Зависимость: P02/P03.
Готово: bytes/hash не меняются после receipt, staging grant не перезаписывает final blob, падение между storage и DB не теряет согласованность. Пройден тест concrete S3 backend, не только mock.

### P05. Надёжная загрузка
F05; full stack. Сначала ограниченная одиночная загрузка файла/поддержанного ZIP, кандидат входа «Вставить HTML», reservations, finalize/abort и progress. Лимит и direct/proxy route выбрать на корпусе; multipart/resume — расширение по замерам. Зависимость: P04.
Готово: повтор/обрыв/finalize race/expiry/quota не создают дубликат; exact final bytes проверены по hash и содержимому до read grant. Не обещать продолжение после reload, пока его нет. Для multipart parts/resume/очистка проверяются отдельно.

### P06. Полка и папки
F06; frontend + backend. Empty state, list/cards, breadcrumbs, CRUD/move/trash/restore, pagination. Зависимость: P02/P05.
Готово: новая сессия открывает свои работы, M1 move не меняет аудиторию; на 10 000 synthetic metadata элементов нет загрузки всех обложек/узлов сразу. Наследование ACL и пересчёт при move — отдельная приёмка M4; массовые операции после одиночных транзакций.

### P07. Постоянная ссылка и grants
F03/F07; backend + UX. Resolver, live published pointer/pinned snapshot, audience/expiry/revoke, download/copy, unfurl policy. Аудитория и discovery разделены по SHARING_AND_DISCOVERY. Зависимость: P03/P04 и минимальный audience deny P10; полная классификация M4 не блокирует личный owner/unlisted.
Готово: S01–S08 — delivery paths/боты/noindex/cache/Range/TTL, отсутствие token в логах/referrer, явное update target без смешивания revisions. S10 — приглашения отдельным срезом M1; S11 — company M4; S12 — public index opt-in M5. Исходники/чат не раскрываются читателю.

### P08. Viewer и дешёвая доставка
F08/F19; platform + UX. Эксперимент с тремя профилями в M0, затем реализация принятого набора для заявленных форматов M1; весь набор не блокирует первый выпуск. File/raster/PDF/known recipe выдаются подходящим безопасным способом; arbitrary JS — отдельный networkless runtime. Неподдержанный интерактивный формат обозначается до загрузки. Зависимость: P04/P07 для живого end-to-end.
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
Готово: фактические viewport/шаги/скриншоты; J01/J05/J06 и S09 в M1, J02 в M2. Владелец различает аудиторию/поиск/черновик/версию по ссылке; получатель понимает необходимость входа без утечки названия. Прототип проверяет навигацию/формулировки, backend-права проверяются отдельно.

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
3. Принятый HTML-путь P08 + S01–S09 + P19/P23 → ограниченный сценарий A и реальный получатель; S10 для закрытого обмена. M2 не блокирует первые допущенные пользовательские проверки.
4. P09 + copy P17 → собственный результат B. Проверять отдельно от A.
5. P20: внешний агент сохраняет/читает candidate и получает owner-only адрес. Затем P13/P14: поручение из UI, обсуждение и исправление.
6. S11/P15/P16/расширенный P23 — корпоративный пилот. S12/P22 — явная публичная публикация, индексирование и библиотека после эксплуатационного допуска.

Техническая цель завершается доказательствами пути; установка репозитория, прохождение unit tests и объём документации не означают завершение продукта. Публикация домена, расходы и маркетинговые рассылки выполняются отдельными явно порученными действиями.
