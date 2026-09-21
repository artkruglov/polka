# Реальный каталог — приёмка в работе

21.09.2026. Это промежуточное evidence; сервер и реальные публикации ещё не приняты.

## Реализовано во frontend

Luna: EditorialPage, editorial-client, EditorialCatalog, route /discover. Старый Explore2026 больше не обслуживает этот route; его демонстрационные данные не выдаются как новые публикации. Компонент прошёл scoped Astra review; fetch integration получил root замечания по корректной обработке malformed ответа/slug. TypeScript и build прошли до этих уточнений.

В текущем dev процессе API ещё отсутствует: браузер /discover показывает «Не удалось загрузить редакционные материалы» и кнопку «Повторить». Никаких fallback-публикаций. Повтор оставляет честное состояние ошибки; настоящий success flow не проверен. Серверный пакет Sol разрабатывается отдельно, working DB ещё schema14.

## Исправление toolbar просмотрщика

Root добавил класс html-preview-toolbar только к работающему LivePreview и flex/gap/44px styles. На viewport390 кнопки «Развернуть»/«Остановить» имеют высоту44px, gap12px; «Обновить доступ» переносится на новую строку. Screenshot просмотрен: подписи больше не слипаются. Реальные клики expand/collapse сохраняют тот же iframe URL, фокус возвращается на «Развернуть». Viewport override снят, тестовая вкладка закрыта. Проверка проведена на сохранённой лаборатории вероятностей; она не подтверждает весь каталог.

## Остаток

Schema15/service/explicit publish + withdraw, pinned bindings и прямой recipient gate; focused backend tests и Astra review; миграция/локальная регистрация отдельно созданных catalog shares; браузер list→open→live→withdraw. Контрольные суммы всех12 candidates и наличие evidence повторно сверены, tokens/URLs в metadata не включены. Облачная приёмка не выполнена.

## Подготовка интеграции

Frontend client получил пять focused tests: malformed DTO/unknown fields/max20, detail404, abort propagation, slug/URL validation. Добавлен в штатный test script. Root проверкой кода нашёл ещё неверную маршрутизацию invalid detail slug в общий каталог; исправление возвращено Luna. Prepared local inputs для12 материалов сопоставлены с точными revision receipts/source hashes; новых shares или публикаций при этой подготовке не создавалось.

Root browser проверил исправление invalid detail slug: /discover/bad--slug показывает «Материал не найден» и ссылку возврата; общий каталог не монтируется. Astra дополнительно нашла отсутствие safeRecipientUrl проверки в карточке (detail уже проверяет); это исправление назначено Luna. До targeted review карточки не считать принятыми.

## Preflight и review до миграции

Read-only preflight сверил12 точных revision IDs с owner текущей synthetic editorial учётной записи, active artifact, source SHA, manifest SHA и принятыми ready derivative IDs/hashes/profile. Все совпали. Подготовлены только локальные inputs; новые share и publication не создавались. После card URL исправления root: editorial-client5/5 и Vite build прошли.

Astra server review выявило блокер: глобальный lookup active slug допускал замену публикации другого tenant при знании её UUID. До изменения working schema Sol должен добавить проверку tenant до revoke/update и отрицательный тест. Также требуются сохраняемый provenance, canonical hash DB manifest и cleanup созданных тестовых публикаций при провале. Серверный пакет не принят, миграция015 не применялась.

## Schema15 локально применена

Astra приняла исправления tenant ownership, immutable persisted request/provenance и canonical DB manifest validation. Root выполнил npm run db:migrate (exit0), затем перезапустил свой dev процесс с live viewer. /readyz200, GET /api/editorial200 {items:[]} — новых публикаций нет. Браузер /discover показывает «Здесь пока нет опубликованных материалов», ошибка прежнего API устранена. Focused DB/live tests ещё ожидают безопасного fixture cleanup; запуск12 публикаций не выполнен.

## Каталог принят локально

Sol focused DB3/3: static pin/retry/audit/tenant/trash/withdraw и настоящий4-file bundle ready/negative hash/profile/live gates/owner disabled/viewer access. Первый run нашёл ошибку array parameter теста; после её исправления3/3. TypeScript, migrations2/2, diff green. Fixture finally отозвал shares/отключил только созданные accounts; доступных тестовых публикаций0. Повторный запуск: npm run test:editorial-catalog (работает с новыми synthetic tenants в настроенной local среде).

Root зарегистрировал12 материалов. Первоначальный MCP share вызов повторно использовал активные тестовые shares: обнаружено по browser URLs. Эти12 initial publications явно withdrawn, старые shares revoked; повторный проход создал новые share IDs и publication UUID. Данные/версии не менялись. [Конечные привязки](local-publications.json) не содержат bearer tokens/URLs. Новые links имеют7-day TTL; нет скрытого продления. Временные MCP connections отозваны finally.

GET list200 возвращает ровно12 принятых slug, все12 details200 и ссылки совпадают. Старый probability test resolve404. Браузер: catalog card→recipient→launch→coin120 даёт63/57. Mobile390×844:12 cards, scrollWidth390, screenshot просмотрен; override снят. Глубокие действия каждого материала ранее проверены на тех же immutable revisions в editorial-runtime evidence. Вкладка /discover оставлена как локальный результат. Облачная публикация/HTTPS/isolation этим не доказаны.
