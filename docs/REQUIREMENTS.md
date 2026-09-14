# Требования Полки

Нормативная редакция 14 сентября 2026. Все строки ниже — целевой контракт, не реализованные возможности. M0–M5 и P01–P26 определены в [плане](DELIVERY_PLAN.md). Отобранные исходные требования прослеживаются в [сверке](ORIGINAL_REQUIREMENTS_REVIEW.md) и CSV. Основа нужна до данных пользователей; расширенный корпоративный UI допускается отдельным этапом.

| ID | Контракт и отрицательная проверка | Этап / задача |
|---|---|---|
| F01 | Независимое приложение/репозиторий: отдельные сборка, API, DB migrations и runtime configuration; нет legacy editor/DeckDoc/Scene в зависимостях; перенос кода имеет происхождение | M0 / P01,P24 |
| F02 | Tenant с типом personal/organization — граница данных; workspace и folder внутри него. У artifact есть owning tenant и createdBy, это разные свойства; личный пользователь не настраивает эту иерархию вручную | M0 / P02 |
| F03 | Verified identity, membership и effective permissions проверяются на каждом действии. Read, comment, edit, manage, source-copy, export и release не сливаются. Ссылка внутри компании не даёт членства | M0–M1, enterprise M4 / P03,P07 |
| F04 | Оригинал и ресурсы имеют immutable version/hash; сохраняемый успех означает committed receipt; повтор идемпотентен; версия не указывает на изменяемый staging object | M0–M1 / P04,P05 |
| F05 | Прямая ограниченная загрузка, multipart/resume где поддержано, квоты до выдачи разрешения, checksum/finalize и уборка незавершённого; сеть/повтор не создают дубликат или скрытую потерю | M1 / P05 |
| F06 | Полка/папки: создать, переименовать, переместить, удалить/восстановить, сортировать, найти, открыть. Цикл папок и cross-tenant move запрещены; в M1 папки не меняют аудиторию работы. Корпоративное наследование прав и их пересчёт — отдельный допуск M4 | M1/M4 / P06 |
| F07 | Новая работа owner-only. Живая ссылка переключается на immutable revision только явным «Обновить по ссылке»; pinned/official link остаётся на снимке. Аудитория, индексация, версия и copy/download разделены; noindex не является ACL. Есть expiry/revoke; просмотр pin-ит revision, grants короткоживущие | M1, company M4, moderated public/index opt-in M1.1 / P07 |
| F08 | Профили просмотра различают безопасный документ, доверенный рецепт и произвольный исполняемый пакет. Обычный файл/постер не требует Chromium на читателя; user JS не запускается в origin приложения | Spike M0, M1–M2 / P08 |
| F09 | Поддержанная правка изменяет backing source, новая версия имеет CAS. Конфликт и Undo не перезаписывают чужое; arbitrary DOM не объявляется полностью редактируемым | M2 / P09 |
| F10 | Классификация наследуется от входов, понижение требует права. Server policy определяет external sharing, models/images, зависимости и telemetry. Внутренняя установка не обращается наружу без разрешения | Основа M0, M3–M4 / P10 |
| F11 | Audit event отделён от growth events и private prompt trace. Actor/delegation/run/operation/object/revision/time/result связаны; audit для успеха записывается атомарно либо через outbox той же транзакции | Основа M0, export M4 / P11 |
| F12 | Retention/soft delete/restore/purge, pinned publication и references согласованы; отключение сотрудника отзывает доступ/ключи, но не удаляет работы tenant. Legal hold и granular enterprise retention — отдельное расширение | Модель M0, минимум M1, полный M4 / P12 |
| F13 | Агент — отдельный actor: scoped delegated/service identity, доступные capabilities, budgets/duration/iterations, needs_input, cancel и durable recovery. Необходимый контекст ограничен; модель не считается успешной по одному сообщению чата | Контракт M0, реализация M3 / P13 |
| F14 | Proposal привязан к base revision; main и approved/released не меняются самим агентом. Diff показывает текст/данные/ресурсы и before/after; approval exact revision. Agent не получает approve/publish/certify. Частичная приёмка — только проверяемых независимых групп | M3, официальное согласование M4 / P14 |
| F15 | Design/skill package версионирован и закреплён; certified требует уполномоченного человека, fixtures и evidence. Корпоративная библиотека принадлежит tenant; обновление не меняет старые работы. Arbitrary code не становится trusted от имени шаблона | Recipe M2, Brand Library M4 / P15 |
| F16 | Snapshot, источник, anchor, parser version, дата/единицы, права и provenance ассетов сохраняются. Ноль отличается от null; source text не является инструкцией. Generated image закрепляется hash и не генерируется заново при открытии/публикации | Recipe M2, sources/images M3–M4 / P16 |
| F17 | Производная работа/новый период/другая аудитория хранят origin revision; private sources/права не копируются автоматически; meaningful delta не ограничивается двумя картинками PDF | Модель M1, разрешённая копия M2, расширение M3/M5 / P17 |
| F18 | Понятные сохранение/загрузка/preview, keyboard/focus/contrast, mobile, локальные шрифты, alt text и порядок чтения поддержанного содержимого. RU UI сначала, locale-aware данные и EN-текст не ломают макет; EN UI — отдельный допуск | Каждый этап / P18 |
| F19 | Файловая полоса отделена от API и compute; bounded queues, глобальные квоты, pool limits, cancellation, pagination и нагрузочные профили. SLO измерены в целевой сети; аккаунты не равны одновременным runtime | M0 design, M1/M2 test / P19 |
| F20 | UI/MCP/CLI используют один новый application contract. Discovery объясняет файлы, папки, recipes, scope, версии и доступные действия. Проверены создание/правка/чтение через заявленный адаптер; MCP сам не зеркалирует внешний чат | Контракт M0, M3 / P20 |
| F21 | Внутренний поиск, обложки, кеши и счётчики соблюдают ACL. Публичный каталог/sitemap Полки не содержит private/unlisted работ; поисковикам передаётся noindex. Авторский HTML не переопределяет политику сервиса. Дедупликация не раскрывает чужой файл, invalidation учитывает revoke/offboarding | Metadata/noindex M1, public projection M1.1, расширение M5 / P21 |
| F22 | Сигналы различают автора, реального получателя и бота. Лайк/закладка/копия различны; privacy policy не допускает скрытую слежку. Публичные подборки и рекомендации не открывают закрытые работы | Минимум M1; moderated catalog/bookmark/like M1.1; расширение M5 / P22 |
| F23 | Open source, воспроизводимая установка/обновление/restore, совместимые версии компонентов, минимум 2 профиля cloud/internal. Настоящий SSO/SCIM, компания-владелец и операторские SLA проверяются перед обещанием enterprise-ready | M1 baseline, M4 / P23 |
| F24 | Ссылка/HTML/file original первичны; формат доступного экспорта назван честно. Хранение PPTX не означает редактируемый round-trip; старые работы остаются в Lanka, перенос явный и приватный | M1/M2 / P24 |
| F29 | Командное ревью привязано к immutable revision и якорю: comment/open/resolved, reply, candidate и diff видны только effective audience; ручная правка и proposal не перезаписывают друг друга | M3/M4 / P14,P18 |
| F30 | Корпоративный deployment profile воспроизводим: OIDC/SSO, Postgres, S3/MinIO, egress policy, allowed agent adapters, health/backup/restore и capability discovery задаются конфигурацией; hosted и self-hosted используют один application contract | M4 / P23 |
| F25 | Артефакт разрешённого агента сохраняется одной идемпотентной командой `artifact.capture`: private по умолчанию, immutable receipt/revision, provenance, folder/title hints; actor не может сам включить share/public/release | M1.2 / P25 |
| F26 | Поддержанная публичная ссылка импортируется через preview → явный commit в private snapshot; provider allowlist, SSRF/redirect/size/time/content policy, без cookies/credentials; после receipt читатель открывает Polka snapshot без обращения к провайдеру. Unsupported/private source честно отклоняется или сохраняется как external link | M1.2 / P25,P26 |
| F27 | Быстрые входы не ломают обычный fallback: ручной файл/текст доступен без агента; UI различает fetching/checking/receipt/preview и не обещает сохранение до committed результата | M1/M1.2 / P18,P25 |
| F28 | Origin/provider/version/hash и достоверное авторство сохраняются как provenance без private prompts/secrets; изменённый внешний источник не подменяет immutable revision | M1.2 / P26 |

## Что уточнено по корпоративному ревью

В первоначальных PRD были tenant hierarchy, Publisher, agent actor/scopes, brand certification, egress/classification, audit, snapshot provenance и immutable release. При упрощении плана они оказались распределены по общим пунктам. F02/F03/F10–F16 возвращают их в явный контракт. Offboarding с сохранением собственности компании — новое практическое уточнение исходной модели, а не найденная дословная US.

Основу F02/F03/F04/F10/F11/F12 нужно закладывать до персонального публичного выпуска. При этом интерфейс не заставляет одиночного автора создавать компанию, получать три согласования или выбирать агента. Один и тот же пользователь может быть автором и публикующим в личном tenant; организация может потребовать разделения обязанностей.

## Разделение распространения и утверждения

Подробный контракт аудитории, индексации, обновления ссылки и проверок S01–S12 — [SHARING_AND_DISCOVERY](SHARING_AND_DISCOVERY.md). Только явно public работа может попасть в каталог и получить разрешение индексирования; «По ссылке» не называется приватным режимом.

«Поделиться» создаёт доступ в пределах policy. «Утвердить/выпустить» — отдельный корпоративный workflow. Ссылка на draft не выдаётся за официальный утверждённый выпуск. Изменение текста, данных, asset или design dependency создаёт новую revision и требует нового approval для неё; старый release остаётся своим неизменяемым снимком.

## Границы обещаний

Фразы «любой агент», «все данные в контуре», «мгновенный отзыв», «полная синхронизация» и «редактор как Figma» допускаются только в доказанном конкретном смысле. Система не является desktop sync client первого выпуска. Статичный preview явно отличается от интерактивного; медленный runtime нельзя скрывать под вечным спиннером.

## Новое уточнение: авторская витрина

[Публикация и модерация M1.1](COMMUNITY_PUBLICATION.md) уточняют F07/F11/F21/F22: только явно поданный и допущенный снимок; черновики и приватные источники исключены; withdrawal/hide отзывают выдачу и каталог; повтор реакции не удваивает счётчик. Нужны оператор, жалобы и ограниченная очередь. Истории J20–J22 добавлены владельцем после исходных PRD; CSV их ретроспективно не подменяет.
