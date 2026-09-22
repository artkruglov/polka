> Актуализация 21.09.2026: текущая цель и порядок работ — [IMPLEMENTATION_GOAL](IMPLEMENTATION_GOAL.md). URL-import остаётся демо; начата слоистая миграция фронтенда. Старые отметки ниже не означают завершённую пользовательскую приёмку.

# Состояние проекта

Обновлено 21 сентября 2026. **Локальный рабочий срез + прототип; облачного MVP ещё нет.** Верхняя сводка отражает текущее состояние; записи ниже сохраняют историю этапов и их доказательства.

| Реализовано и проверено локально | Открытая приёмка / отсутствует |
|---|---|
| Operator accounts + email-code registration, tenant-scoped DB/S3 | SMTP delivery не проверена; local mail только для .test |
| Single-file и multi-file bundle capture/export, SHA-256, idempotency receipts, quota | URL source capture не подтверждён; ZIP import отсутствует |
| Immutable versions, CAS, личные папки/поиск, rename/move, корзина и восстановление | MCP management проверен на сервере и частично в native-клиенте; revoke schema16 принят локально; SQL18/ACL, реальный локальный S3 purge и полный backup→purge→restore приняты изолированно; рабочая БД16, удаление выключено |
| Scoped token auth, Streamable HTTP MCP, context/list/capture/status/revise/prepare/share/revoke | UI-issued context token→Codex→seen→revoke принят21.09; второй native клиент и UI-issued capture не приняты. OAuth 2.1 коннектор для Claude.ai/ChatGPT и `polka_publish` реализованы 22.09 и проверены интеграционными тестами; ручная приёмка с настоящими клиентами открыта ([MCP_CONNECTOR](MCP_CONNECTOR.md)) |
| Codex CLI→helper→MCP→готовый preview→share→recipient | Claude Code остановился на provider 429; hosted цепочка не проверена |
| Unlisted link, TTL, revoke, pinned grants; static HTML, TXT, изображения | Team membership/SSO/offboarding отсутствуют |
| Отдельный local viewer, bundle inline derivative, интерактивные примеры; controlled staging config/HTTP и synthetic HTTPS proxy14/14 приняты локально: [193+9 тестов](reviews/2026-09-21-viewer-staging/README.md) | Hosted viewer, полный browser/egress acceptance остаются открыты |
| Synthetic restore: exact version remap, новый login/export/share, отказ старому доступу, staged cleanup | Schema18: backup→реальное удаление→restore с очисткой до запуска принят локально. Штатный CLI/startup gate и read-only MinIO identity приняты отдельно локально; реальные cloud backups, provider migration, RPO/RTO не проверены |
| Лендинг/reader, настоящий локальный каталог schema15 с 12 интерактивными материалами «Редакции Полки» | Hosted-публикации не приняты; moderation/social API отсутствуют, demo likes/bookmarks не являются пользовательской активностью |

Dockerfile с закреплённым base digest существует; сборка образа и container runtime smoke не приняты из-за registry. Readiness принят локально; Compose base, SMTP overlay и рецепт DB permissions подготовлены, но запуск контейнеров, доставка письма и облачный rollback ещё не приняты. Актуальные детали: [CLI capture](reviews/2026-09-20-cli-capture/README.md), [restore](reviews/2026-09-21-restore-drill/README.md), [container](reviews/2026-09-20-container/README.md).

## Выполнено в текущем проходе B0

- Просмотрены продуктовые документы, маршруты UI/API, schema, viewer, tests и deployment.
- 22 старых top-level документа перенесены в docs/archive/2026-09-20, сохранены root README/GOAL; история и evidence не удалены.
- Созданы актуальные PRODUCT, REQUIREMENTS, UX, ARCHITECTURE, ROADMAP, LAUNCH, CONTENT, DECISIONS, LOCAL_DEVELOPMENT и карта docs/README.
- ONBOARDING_SPEC описывает signup/start/MCP wizard; реализация экранов и оставшиеся ограничения отражены ниже в B1.
- Подготовлен отдельный research/COLD_START_PROMPT.md, исследование ещё не запускалось.
- Удалён устаревший запрет слова «артефакт» из проверок; ограничения неподтверждённых обещаний и security-тесты не ослаблены.
- Повторная проверка: **31/31 тестов, tsc, vite build — pass**. Протокол тестов: [tests.txt](reviews/2026-09-20-mvp-audit/tests.txt).

В предыдущем прерванном проходе тесты не прошли при выключенном Docker и на устаревшем запрете слова. После запуска локальных DB/S3 и обновления согласованного теста полный прогон зелёный. Это не нагрузочное тестирование и не новая полная UX/security-приёмка.

- Проверены 41 локальная ссылка в 15 действующих документах: битых нет. [Протокол](reviews/2026-09-20-mvp-audit/doc-links.json). B0 завершён.

## Прогресс B1

Созданы /signup, /start и /settings/agents. Реализован email-code backend с локальным тестовым ящиком и SMTP adapter; старые аккаунты сохранены. **34/34 теста проходят; TypeScript и build повторно проверены — pass**. [Доказательства и ограничения](reviews/2026-09-20-onboarding/REVIEW.md). B1 остаётся в работе до SMTP/user-приёмки. MCP wizard — demo, реального MCP ещё нет.

## Следующее

B1: восстановление экрана кода по browser-bound cookie и очистка использованных/просроченных кодов реализованы и проверены интеграционным тестом. Очистка вызывается командой maintenance; периодический запуск в облаке ещё нужно настроить. Остаются настоящая SMTP-доставка и пользовательская приёмка. Независимый следующий шаг — B2: корпус HTML и проверка изолированного просмотра. Публичная ссылка /mcp или dummy credentials не должны появляться раньше работающей авторизации. Домен/SMTP/облачный проект и расходы ещё не выбраны; UI и локальный mail adapter можно проектировать независимо.

## Известные долги

LegacyLanding/PublicGallery остаются неактивным кодом; документация архивирована, но код не удалён без dependency review. Старые формы /connections и другие демо могут содержать прежние правила доступа, которые заменены в DECISIONS. B1 должен привести эти входы в соответствие новой модели; не считать весь UI уже согласованным. Registry/CI/production deployment и проверенный российский hosting отсутствуют.

## Повторная ревизия и B2

Возвращены явные требования R17–R20: экспорт/удаление, обнаружение/индексация, адресное приглашение и Telegram. Уточнено делегирование агентам вместо архивных blanket deny. [Результаты](reviews/2026-09-20-requirements-revision/REVIEW.md).

B2 начат: 20 оригинальных HTML-fixtures пяти типов, manifest и ожидаемые действия. Live runtime и URL adapter ещё отсутствуют; взаимодействия не приняты в браузере. Последняя проверка: **35/35 тестов, TypeScript — pass**. Предыдущая проверка сборки остаётся актуальной: production-код в этом проходе не менялся.

## Запуск работы с моделями

Цель создана заново и active. Luna реализовала 8 отрицательных HTML-fixtures, Astra проверила план исполнения; замечания учтены. Ведущий проверил и интегрировал тесты: **37/37, TypeScript pass**. [Протокол](reviews/2026-09-20-model-workflow/REVIEW.md). Runtime ещё не принят; следующий шаг — контракт viewer и локальный spike.

## B2: первый живой просмотр сохранённого HTML

Реализован отдельный loopback viewer и короткие owner/recipient права на версию. Explicit launch/stop/refresh в UI, hosted запуск запрещён, флаг по умолчанию выключен. В браузере проверены калькулятор 3×100=300 и график 30→60; остальной корпус/egress/mobile ещё не приняты. 38 default + 5 enabled tests, TypeScript/build pass. [Ревью и доказательства](reviews/2026-09-20-live-viewer/REVIEW.md). B2 остаётся в работе; URL-import/MCP не реализованы.

## B2: manifest и продолжение runtime-проверки

Новые одиночные HTML revisions сохраняют канонический manifest/hash; миграция 006 применена. Добавлен iframe-only Fetch Metadata gate. Проверены ещё слайды и планировщик; отрицательный браузерный probe дал частичные подтверждения CSP. Счётчик egress не принят: положительный контроль блокирует сама браузерная среда. 47 обычных + 6 live tests, TypeScript/build pass; [подробности](reviews/2026-09-20-manifest-runtime/REVIEW.md).

Следующий пакет — multi-file application service по [BUNDLE_SPEC](BUNDLE_SPEC.md), затем адаптер источника и MCP. Это текущий приоритет вместо исторических «следующих шагов» выше. Полный live runtime, мобильная/межбраузерная приёмка и облако ещё не готовы.

## Получатель: исправление переходов по ссылкам

Смена hash теперь загружает новый артефакт и сбрасывает прежние preview/жалобу; устаревшие ответы игнорируются. Проверены переходы между материалами, ошибка и восстановление, планировщик на ширине 390px, статичный отчёт. [Приёмка](reviews/2026-09-20-recipient-navigation/REVIEW.md). Это не закрывает весь mobile/runtime scope.

## B2: multi-file capture реализован локально

Миграция007, begin/put/finalize/status/abort, полный JSON export, общая quota/idempotency и cleanup реализованы. Отдельный реальный HTTP smoke вернул точные4 файла исходного отчёта; 52 default +7 live tests проходят. [Доказательства](reviews/2026-09-20-bundle-capture/REVIEW.md). Bundle остаётся без просмотра до приёмки производного; следующий код — сборщик и его интеграция. URL эксперимент получил оболочку Claude, исходники ещё не получены: [исследование](research/CLAUDE_IMPORT_EXPERIMENT.md).

## B2: чистый сборщик производного

Добавлен детерминированный сборщик локальных CSS/classic JS/изображений. После ревью исправлены3 ложных ready (необработанный ресурс, malformed SVG, потеря атрибутов stylesheet). Итог57 default +7 live tests, TypeScript/build pass. [Контракт следующей интеграции](BUNDLE_INLINE_SPEC.md). В viewer сборщик ещё не подключён; полного интерактивного bundle-сценария пока нет.

## Текущий приоритет: bundle runtime → MCP

Локальная интеграция производного реализована: migration008, ограниченный worker, отдельная квота, retry/cleanup и pinned viewer. Sol проверил **58 default + 3 runtime integration tests**; независимый HTTP smoke получил ready и точный экспорт всех четырёх оригиналов. Astra проверила backend и нашла recovery-дефект UI: pending после прерывания не позволял повторить POST. Luna добавила resume POST; TypeScript/build проходят, дополнительно 7/7 live tests прошли у ведущего. Реальная браузерная приёмка bundle остаётся следующим действием. Hosted runtime и импорт не приняты.

[MCP_IMPLEMENTATION_SPEC](MCP_IMPLEMENTATION_SPEC.md) подготовлена; сервер ещё не реализован. [Актуальная очередь и модели](MODEL_WORKFLOW.md#текущая-очередь-после-повторного-запуска) заменяют устаревшие «следующие шаги» исторических записей выше. Цель active, работа продолжается без сброса результата.

## B2: браузерная проверка bundle и начало B3

Реальный recipient выявил две ошибки: UI скрывал запуск bundle у получателя, а parse5 экранировал JS из-за отсутствующего parentNode. Обе исправлены; builder повышен до v2. Свежая копия отчёта переключает12/8 →9/11 →12/8, CSS/SVG видны; на390px нет горизонтального переполнения. Отзыв share закрывает следующий просмотр. [Протокол](reviews/2026-09-20-bundle-runtime/README.md). Это один локальный сценарий, hosted/импорт остаются открыты.

Начата foundation-реализация MCP auth (Sol): миграция009 применена, endpoints/service actor и тесты в работе. Transport/tools и два клиента ещё не готовы.

## B3: токены подключения реализованы локально

Owner HTTP endpoints выдают CSRF и одноразово показываемый scoped token, возвращают безопасный список и отзывают подключение. Есть TTL, audience, tenant binding и transactional recheck. Astra обнаружила скрытие старого активного токена после100 отозванных; список исправлен: все активные плюс100 записей истории. Независимый HTTP smoke подтвердил выдачу/список/отзыв и no-store. MCP transport/tools, UI реального подключения и два клиента остаются следующими задачами; этот срез не означает готовый MCP.

Token foundation: **4/4 auth tests**, **58/58 default**, TypeScript и diff-check проходят. [Доказательства](reviews/2026-09-20-mcp-token-foundation/README.md). После исправления сериализации root повторил runtime suite: **3/3**.

## B3: подготовка payload и transport в работе

`prepare-capture.ts` формирует manifest/hash/base64 из явно выбранных файлов, не отправляя их. Две проверки прошли (точные bytes и отклонение escape/duplicates/symlinks), CLI собрал четырёхфайловый team-report. Добавлена инструкция LOCAL_DEVELOPMENT. Официальный MCP SDK v2 установлен с закреплёнными версиями; Sol реализует readonly transport. Наличие зависимости не означает готовый endpoint или приёмку клиентов.

## B3: общий capture service для агента

Шесть upload-функций вынесены в общие транзакционные тела; прежний web flow сохранён. Миграции010/011 привязывают загрузку и аудит к подключению. Сервис capture/revise/status проверен на настоящих DB/S3; статус доступен по исходному key после потери ответа. 60 default и отдельный capture integration проходят, TypeScript/diff-check тоже. [Протокол](reviews/2026-09-20-agent-capture/README.md). MCP tools пока не подключены; transport проверяет Sol.

## B3: MCP сохраняет пакеты по HTTP

Transport и tools context/list/capture/revise/status подключены к общему сервису. SDK integration: 3/3, включая JSON больше5MiB при исходных4MiB, повтор, версии, статус по key, чужое подключение и отзыв. Лимит8MiB применяется только к MCP. Проверка настоящих CLI начата; share/build через MCP и onboarding ещё не готовы.

Текущие проверки после wiring: **61/61 default, 3/3 MCP, 4/4 service-auth**, TypeScript/diff-check проходят. [HTTP MCP evidence](reviews/2026-09-20-mcp-readonly/README.md). Реальный Codex инициализировал подключение; до получения receipt сохранение через CLI не считается принятым.

## B3: реальные CLI выявили ограничение workflow

Codex native context работает, но Luna исказила большой файловый payload: сервер отклонил дубли до сохранения. За180сек receipt не получен. Claude остановлен provider API429 (лимит аккаунта), до модели. Оба тестовых токена отозваны. [Протокол](reviews/2026-09-20-cli-capture/README.md). Следующий путь: CLI вызывает локальный MCP helper для точной отправки immutable request; bytes не переписывает модель. Luna реализует helper. Два клиента ещё не приняты.

## B3: Codex сохраняет оригиналы; share/revoke прошли ревью

Реальный Codex с Luna выполнил context → локальный MCP helper → native status saved. Независимый экспорт побайтово совпал со всеми4 исходными файлами. [CLI evidence](reviews/2026-09-20-cli-capture/README.md). Это один принятый клиентский путь; Claude account limit и приёмка второго клиента остаются открыты.

Sol вынес web и MCP share/revoke в общий service. Migration012 применена, receipt повторов привязан к connection/request; закрытая ссылка не возрождается. Astra проверила scope/revocation/CAS и приняла пакет без blockers. Sol: **4/4 MCP, 61/61 default, 3/3 runtime, 4/4 auth**, check/diff-check green. Реальный CLI-прогон выше был на предыдущем сервере и не доказывает новый share flow.

Следующий пакет Sol: явный `polka_prepare_preview`, использующий существующий bounded worker и повторную проверку подключения перед ready. Luna: узкие regression tests helper. После этого — сквозная приёмка capture → prepare → share → recipient, затем настоящий onboarding подключений. Облачная beta ещё не готова.

## Следующий пользовательский срез: настоящее подключение

Astra подготовила [MCP_ONBOARDING_SPEC](MCP_ONBOARDING_SPEC.md) для обоих маршрутов /settings/agents и /connections. Он использует существующие owner endpoints: одноразовый scoped token, инструкции CLI, список и отзыв. `seen` означает полученный запрос, а не завершённое сохранение. UI ещё не реализован.

Luna добавила Dockerfile/.dockerignore; frontend build прошёл, Docker build пока остановился на загрузке base metadata. Контейнер и runtime smoke не приняты. Подробности — [container evidence](reviews/2026-09-20-container/README.md). Это отдельная подготовка self-host, не готовая cloud-поставка.

## B3: первый сквозной реальный клиент принят локально

Preview implementation прошла Astra review и проверки Sol:63 default,4 MCP,3 runtime,4 auth; check/diff-check green. Root перезапустил локальный сервер и проверил **реальный Codex/Luna → capture helper → native prepare → native share → browser recipient**. Отчёт переключает12/8 →9/11; export всех4 файлов точный; owner revoke закрывает следующий просмотр. [Протокол](reviews/2026-09-20-cli-capture/README.md). Вход в исходный сервис для просмотра не использовался.

Luna реализует реальный MCP onboarding по принятому контракту. Пока нельзя объявлять два клиента, hosted runtime или облачную beta готовыми.

## B3: экран подключения работает с сервером

/settings/agents и /connections заменены одним реальным flow выдачи/list/revoke. Root через браузер проверил context-only token TTL1 → закрыть → reload без токена → отзыв.390px без горизонтального overflow; исправлен конфликт global label CSS. Astra error-flow замечания (4xx ambiguity и non-JSON401) устранены Luna, добавлены regression tests. [Протокол и ещё не проверенные состояния](reviews/2026-09-20-mcp-onboarding/README.md).

Self-host image пока не собран: Sol подтвердил зависание registry metadata и неполный localbasecontent. Процессов build не осталось, системные настройки не менялись. [Container evidence](reviews/2026-09-20-container/README.md). Подготовлен [hosted viewer delta](HOSTED_VIEWER_DELTA.md); настоящее HTTPS/egress/browser acceptance не проведено.

## R09: организация артефактов и точная пагинация

Название/папку можно менять через owner UI и PATCH с tenant/metadataCAS проверкой. В браузере выполнены rename → move → конфликт двух вкладок → reload snapshot без потериdraft → явный retry → «Без папки» → reload. Версия осталасьv1. Web cursor теперь сохраняет microseconds,26записей в одной миллисекунде проходят без пропусков. **Общий npm test68/68**. [Приёмка](reviews/2026-09-20-artifact-organization/README.md). Trash остаётся открытым.

Редакционный аудит выявил12 кандидатов; Luna создала два автономных оригинала fractions/city-observation (5вопросов/6слайдов). Они ещё ждут capture/runtime/browser приёмки и не включены в каталог. [Аудит](reviews/2026-09-20-editorial/README.md).

[RESTORE_DRILL_SPEC](RESTORE_DRILL_SPEC.md) подготовлен и исправлен по Astra review; настоящее восстановление ещё не выполнялось. Включает remap versionIDs и обязательное закрытие старых shares/agents/sessions до открытия восстановленной копии.

## 21.09.2026: продолжение цели и текущая приёмка

Цель остаётся active. Astra проверяет контракты и готовые изменения, Luna выполняет ограниченные UI/docs задачи, Sol — restore-интеграцию. Старые записи выше описывают состояние на момент проверки; текущая очередь обновляется в MODEL_WORKFLOW.

Два редакционных артефакта прошли capture → prepare → recipient browser: пять вопросов fractions и шесть слайдов city. [Протокол](reviews/2026-09-21-editorial-runtime/README.md). После проверки уточнена формулировка первого вопроса fractions; окончательная версия требует повторного capture перед каталогом. Это не завершает коллекцию из 12–20 материалов.

Новый развёрнутый просмотр проверен на city: переход к шагу 2 → «Развернуть» → Escape на кнопке родительской страницы сохраняет шаг 2; overflow body восстанавливается. Astra обнаружила доступность скрытого фона клавиатурой; исправление передано Luna, поэтому пакет пока не принят. Escape из изолированного iframe не доходит до родителя; кнопка «Свернуть» должна оставаться доступной.

Sol сообщил об успешном синтетическом restore на отдельных loopback DB/buckets с очисткой только созданных ресурсов. Финальный протокол и независимое ревью ещё ожидаются; производственное восстановление не объявляется проверенным.

Продолжение приёмки: [restore evidence](reviews/2026-09-21-restore-drill/README.md) записан. Astra нашла обход loopback через PostgreSQL URL query `host`; guard теперь отвергает query/fragment до writes, root подтвердил 3/3 guard tests. Они добавлены в default suite. Полный synthetic contract ещё требует нового owner login/export/share, receipt replay и maintenance; Sol продолжает этот пакет.

Luna исправила keyboard background escape через `inert`. Root проверил в браузере: фоновые ссылки недоступны, iframe остаётся активным, Shift+Tab не уходит в скрытый фон, шаг 2 сохраняется при expand/collapse, stop убирает iframe и восстанавливает inert/overflow. На 390px горизонтального overflow нет, но toolbar и отступы требуют небольшой мобильной правки; передано Luna. Динамические portals и восстановление заранее существовавшего inert пока подтверждены кодом, а не отдельным browser сценарием.

Мобильная правка принята локально: expanded iframe занимает все 390px, кнопки toolbar имеют высоту 44px и раздельные области нажатия, screenshot проверен. [Детальная приёмка](reviews/2026-09-21-editorial-runtime/README.md#развёрнутый-просмотр). Restore URL guard принят Astra; Sol выполняет следующий пакет полного synthetic сценария по согласованному контракту.

Fractions recapture завершён: `polka_revise` создал v2, prepare вернул ready, owner bundle export побайтно совпал с исправленным index.html. Browser подтвердил новую формулировку и ответ 1/4 с объяснением. Старая тестовая ссылка v1 отозвана, новый share указывает на v2, временное agent connection закрыто. [Окончательный receipt](reviews/2026-09-21-editorial-runtime/fractions-final.json). R10 пока два проверенных материала; Luna делает ещё два содержательных примера, каталог не объявлен готовым.

Astra подготовила [контракт корзины](TRASH_SPEC.md): хранение версий, отзыв ссылок/grants, worker/upload races и CAS. Реализация ещё не начата. Для cloud этапа запрошены доступные домены и проект Яндекс Облака; конфигурация/расходы пока не утверждены.

## 21.09: restore принят локально; следующие пакеты

Sol завершил расширенный synthetic restore, Astra приняла после точных assertions (только ожидаемый 401, полный multiset object references). Новый owner login, byte-exact download/export, новая ссылка, отказ старым токенам/receipts, target-only staging cleanup и сохранность source проверены. [Протокол](reviews/2026-09-21-restore-drill/README.md). Cloud RPO/RTO/реальные backups не проверены. Sol начал backend корзины по TRASH_SPEC; UI и MCP manage ещё впереди.

MCP capture/prepare/share выполнены для week-allocation и data-literacy. [Receipts](reviews/2026-09-21-editorial-runtime/batch2.json). Data-literacy локально работает: три вкладки, выброс30→среднее8.4/медиана3, выброс5→3.4/3, reset18→6/3; mobile parent/iframe390 без горизонтального overflow, screenshot проверен. Week-allocation правильно сообщает168/under/over/invalid, но v1 не скрывает ложную диаграмму при ошибке: приёмка отклонена, Luna исправляет; текущая копия не готова к каталогу.

Week-allocation исправлен и сохранён MCP revise как v2: [receipt](reviews/2026-09-21-editorial-runtime/week-final.json), точный export совпал с source, ready preview. Root повторил browser cases:165/175/negative/step0.1/empty — диаграмма теперь действительно скрыта; reset168 возвращает её. Ссылка v1 отозвана, выдана v2; временное подключение отозвано. Функциональная локальная приёмка v2 пройдена; мобильная визуальная проверка этого материала и включение в каталог ещё впереди.

Мобильная визуальная проверка week-allocation v2 завершена: фактический viewport390×844, parent/iframe main без горизонтального overflow, поля читаются. Каталог всё ещё не опубликован.

Luna подключила TrashPanel и route /trash к App; typecheck/build прошли. Backend lifecycle интеграция Sol и browser/race приёмка ещё выполняются, функция целиком не принята. Также создан injected health coordinator (`apps/server/health.ts`): single-flight, deadline, abort/shutdown и защита от late success; 5 pure tests проходят и добавлены в default suite (включая stop до запуска adapters и deadline при задержке event loop). Это пока не готовые /healthz и /readyz: real adapters/routes/compose остаются по [SELF_HOST_BASE_SPEC](SELF_HOST_BASE_SPEC.md), модуль на ревью Astra.

Health coordinator принят Astra. Luna создала real health adapters (6 fake tests, ещё на ревью), root реализовал storage bootstrap и проверил на локальном MinIO. [Протокол и границы](reviews/2026-09-21-self-host-base/README.md). Endpoints/compose не подключены. UI корзины исправлен по ревью (stale refresh, TXT title, trash action); Sol сообщает suites green и проверяет restore уже на schema13 до финальной backend приёмки.


## 21.09.2026 — корзина и readiness: завершён локальный пакет

[Корзина](reviews/2026-09-21-trash/README.md) прошла scoped review Astra и реальный browser путь. Оригинал совпадает побайтово, v1 сохранена, прежняя ссылка не оживает после restore. Backend tests и schema13 synthetic restore зелёные. R17 account deletion и MCP manage остаются открыты.

[Self-host base](reviews/2026-09-21-self-host-base/README.md): общий catalog schema1–13, bounded read-only adapters, /healthz и /readyz интегрированы и приняты. 17 focused tests; real local readiness24ms и HTTP200 после restart. Поставка/maintenance/cloud isolation/production restore ещё не приняты.


## 21.09.2026 — ещё два editorial, bootstrap repeat

Batch3 принят локально: packing-checklist и contrast-explorer прошли MCP capture/prepare/share, desktop/mobile390 interactions и точный export. Итого6, целевые12–20 и каталог ещё впереди. Полные evidence — editorial-runtime/README и batch3-export.json.

Отдельная команда storage:bootstrap-local успешно прошла реальный повтор на локальном MinIO. Scheduler/childadapter ещё не подключены к guarded maintenance; периодическая уборка не объявляется работающей. MCP management в реализации Sol по обновлённому контракту.


## 21.09.2026 — MCP manage: focused green, review pending

Migration014 additive scopes/metadata operation применена через DB-only migrate; существующие tokens не получаютmanage автоматически. Sol focused service3/3 и officialSDK MCP5/5 прошли; static Astra review ещё идёт. Рабочий процесс пока загружен со старым catalog13: readiness временно failclosed на schema14 до controlled restart принятой сборки. Это ожидаемый version mismatch, не провал DB. Новые MCPtools в работающем dev ещё не включены.

MCP update: Astra scoped acceptance получена. Legacy cursor unknownstate теперь400, targetedmanagement3/3 послеfix. Controlledrestart выполнен соschema14, /readyz снова200 ready. Нативный CLI manage и UIявнаявыдачаscope остаются отдельной приёмкой.


## 21.09.2026 — native CLI management: partial

[Протокол](reviews/2026-09-21-mcp-management/README.md): CodexLuna nativecontext/get/folders/update/replay passed. Trash tool rejected by CLI approval policy never before server, life0; restore не выполнялся. Temporarytoken revoked. Не закрывает полный nativeCLI lifecycle или UI-issuedtoken activation. UImanage checkbox explicit/offdefault проверен отдельно.


## 21.09.2026 — batch4 complete locally

Meal-plan иsorting-explainer прошли runtime/mobile390/export; теперь8 локально принятых editorial. Подробности/хэши вeditorial-runtime/README иbatch4-export.json. Подготовка строгого каталога и guardedmaintenance идёт отдельно; сохранённые unlisted testshares не публикуются автоматически.


## 21.09.2026 — подготовка каталога

content/editorial/candidates.json содержит8 непубличных кандидатов: title/topic/task/action, Редакция Полки/Apache2, sourcepath+точныйhash, evidencepath. Хэши и наличие evidence проверены. Это не публикации и не binding тестовых shares; recipientURLs/tokens отсутствуют. Pure schema на исправлении после Astra review: manifest equality/singleHTML semantics/commitnullable/publicDTO separation. Каталог в UI ещё не подключён.


## 21.09.2026 — catalogue schema и maintenance runner

Исправленная strict editorial schema принята Astra,6/6 tests и включена вdefault. Stored metadata не содержитrecipientURL/date, serverresponse отдельный; hashes/source/manifest/runtimebindings согласованы. Это ещё не каталогвБД/UI.

Runner/child/filter интеграция принята;14 focused tests суммарно (child5/scheduler6/filter3), включая реальный benignNode child с TERM и фильтрациейлогов. ActualGC/daemon notrun; Sol заканчивает отдельный пакет.

## 21.09.2026 — коллекция и эксплуатация

12 редакционных материалов прошли локальную приёмку capture/интерактив/mobile/export ([evidence](reviews/2026-09-21-editorial-runtime/README.md)); матрицаv2 исправляет пояснение весов, её mobile table прокручивается внутри. Это подготовленная коллекция, ещё не подключённая к реальному каталогу. EditorialCatalog/CSS прошли scoped Astra review; API integration и браузерная проверка витрины впереди.

GC после двух исправлений Astra принят статически; Sol выполнил изолированный schema14 restore:7/7 версий, committed refs/quota сохранены, временные ресурсы удалены. Production restore этим не доказан. В package добавлены maintenance:watch и guard/GC тесты в штатный test; daemon на рабочих данных не запускался.

## 21.09.2026 — витрина: текущая интеграция

/discover переведён на server DTO, static fake community больше не обслуживает этот route. Backend schema15/service ещё в реализации; текущий процесс schema14 показывает честную ошибку каталога. Frontend validation 5 tests, invalid detail slug проверен в браузере; карточки проходят дополнительное safe URL review. [Протокол](reviews/2026-09-21-editorial-catalog/README.md). Новый [контракт удаления аккаунта](ACCOUNT_DELETION_SPEC.md) описывает следующий пакет R17; код удаления ещё не реализован, backup retention/erasure остаются внешними условиями приёмки.

Catalog acceptance: readonly preflight12/12 owner/source/manifest/derivative bindings прошёл. Frontend client5/5/build green. Astra остановила server acceptance до исправления cross-tenant slug replacement, audit provenance/canonical hash и fixture cleanup. Schema15 рабочейDB не применена; локальных публикаций пока нет.

## 21.09.2026 — реальный каталог принят локально

Schema15 применена, новый dev process /readyz200. 12 материалов опубликованы явно через operatorCLI, с отдельными catalog shares, точными принятыми revisions/provenance. Старые testshares отозваны. API12/list/detail и browsercard→recipient→live проверены, mobile390 безoverflow. Сервер3/3 focusedtests, frontend5/5/build, staticAstrareview. [Протокол](reviews/2026-09-21-editorial-catalog/README.md). Каталог доступен на http://127.0.0.1:4390/discover; links7дней, автообновления нет. Hosted/импорт/secondnativeclient/SMTP/R17/пилот остаются открыты.

## 21.09.2026 — следующий пакет R17 и упаковка

Согласуется первый backend slice account deletion: explicit local experiment/default-off, durable plan/status, немедленный revoke и active-owner gates. Purge/metadata erasure/backup ledger в этом slice не реализуются и не объявляются завершёнными; UI удаления до этих возможностей не включается. Sol ждёт уточнения контракта Astra.

Docker runtime дополнен12 content/editorial originals/provenance README и LICENSE для operator publish source verification. Исходные hashes/наличие файлов проверены; registry build ещё не принят. Luna готовит compose.base candidate для заранее подготовленных external DB/S3; он не заменяет hosted viewer.


## 21.09.2026 — возобновление и ревизия сводок

Luna проверила согласованность документов; верхние сводки README/STATUS/ROADMAP обновлены по принятому каталогу и корзине. Исторические промежуточные записи выше сохраняются как журнал, а не текущие ограничения.

Первый срез R17 реализован Sol и проходит статическое ревью Astra. Migration016 не применена к рабочей базе; удаление рабочих аккаунтов не выполнялось. Испытания готовятся в отдельной синтетической базе и bucket. Полное удаление файлов, metadata и backup erasure остаётся незавершённым; пользовательский UI удаления не включаем.

SMTP overlay проверен только на уровне конфигурации. Файлы deploy/base.env и deploy/smtp.env исключены из Git и Docker build context. Astra обновила DB grants recipe под точную schema001–016: новые таблицы получают SELECT/INSERT/UPDATE без DELETE и прямого EXECUTE. Применение и проверка runtime role ещё впереди. Никаких облачных ресурсов, отправки писем или выполнения grants этим проходом не было.


R17 config: Luna добавила 5 изолированных subprocess-проверок без подключения к DB/S3. Подтверждены default-off, разрешённая локальная конфигурация, отказ remote HTTP/HTTPS loopback/HOST mismatch и отсутствие/некорректность policy. После root review убрано наследование окружения и ограничено ожидание subprocess. 5/5 прошли у Luna, тест включён в штатный набор. Это не приёмка удаления данных или нового DB schema.


## 21.09.2026 — R17: первый интеграционный срез проверен

Изолированная schema16 прошла сценарий отзыва доступа: старые сессии/агенты/ссылки закрываются, поздний worker не публикует результат, исходные bytes и прежняя ссылка соседнего владельца сохраняются. Первый запуск выявил SQL42P08; Sol исправил cast и гонку resolve после tenant lock. Финальный запуск1/1, созданные DB/bucket удалены и отсутствие проверено. [Протокол](reviews/2026-09-21-account-deletion/README.md). Рабочая schema15 не менялась. Полное удаление данных/backups и отдельная runtime-role приёмка остаются открыты; UI удаления выключен.


## 21.09.2026 — локальная schema16 интегрирована

После Astra review и isolated test миграция применена к локальному приложению. Dev перезапущен с выключенным удалением аккаунта; readiness200, каталог12. Штатный набор145/145 прошёл. Запросы удаления рабочих аккаунтов не выполнялись. Дальше — отдельные runtime-role grants tests; облачный выпуск и full R17 остаются открыты.

## 21.09.2026 — runtime-role принята изолированно

Exact runtime-grants.sql schema16 проверен с отдельными реальными owner/runtime LOGIN. Permissions3/3 и revoke app flow1/1 прошли; prohibited administrative operations дают42501, app DML/trigger/cascade работают. Созданные роли/DB/bucket очищены, отсутствие проверено. [Протокол](reviews/2026-09-21-runtime-grants/README.md). Рабочие grants и production роль не изменялись. Следующий R17 пакет — purge/ledger/restore; Luna реализует pure ledger contract отдельно.


## 21.09.2026 — формат журнала удаления

Luna реализовала pure ledger v1: строгие revoke/purged записи, canonical bytes/SHA-256/key, проверка последовательности и конфликтующих идентификаторов. Astra приняла модуль после исправлений UUID, duplicate-key regression и валидации публичного key helper. 5/5 focused tests и TypeScript прошли у Luna; тест включён в штатный набор. Сохранение во внешнем journal bucket, atomic retry/412, полнота listing и применение к restore пока не реализованы. Pure validation не доказывает durability.


## 21.09.2026 — адаптер журнала принят по injected transport контракту

Luna добавила conditional append/replay и чтение всех страниц; Astra приняла после namespace-before-I/O, единого abort и exact normalized transport errors. 5/5 focused tests и check прошли у Luna; тест включён в default. Реальный S3 transport/permissions/version/delete-marker semantics и внешний durable journal ещё не приняты.

Уточнение inventory R17: login_limits хранит SHA-256 ключей, а не plaintext email/name. Terminal cleanup связанных хешей должна быть привязана к заблокированному целевому account; произвольные caller-provided hashes не допускаются.
