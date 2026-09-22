# Живой просмотр: контракт первого эксперимента

B2, 20.09.2026. Профиль `inline-live-experimental-v1` проверяет взаимодействия на **сохранённых версиях**, а не на React-макетах. Это промежуточный эксперимент: R06 и выпуск hosted не приняты.

## Границы

HTML_LIVE_ENABLED выключен по умолчанию. В первом срезе включение возможно только на loopback с разными hostname приложения и viewer (127.0.0.1 и localhost) и разными портами. Разные порты одного hostname не отделяют cookies. Hosted включение отклоняется конфигурацией до отдельной приёмки. Для будущего hosted нужен отдельный registrable domain/upstream.

Viewer — отдельный Fastify listener, не маршрут SPA. HTML выдаётся браузеру только с Sec-Fetch-Dest: iframe и Sec-Fetch-Mode: navigate; при отсутствии metadata — отказ. Это поддерживает родительскую frame-src policy, но не заменяет авторизацию: небраузерный клиент может подделать заголовки. Только чтение конкретной версии по короткому capability, без session plugin, CORS, публичного bucket и app API. Основной Origin-check не ослабляется.

## Контракты

- POST /api/revisions/:id/live-view: owner session, tenant, HTML; возвращает url/expiresAt/profile.
- POST /api/view/live-view: существующий Bearer recipient grant; revision берётся из него, а не из входа пользователя.
- GET viewer-origin/document/:capability: проверка срока, действующей сессии владельца или исходного recipient grant/share, затем чтение pinned object_key/object_version.
- viewer_grants: hash случайного 32-byte token, revision, ровно одно основание — owner session или share + source grant; срок максимум 60 секунд и не больше исходного grant.
- Logout/disabled account/revoke/expiry запрещают следующие чтения. Уже загруженные bytes нельзя отозвать из браузера; изменение версии ссылки не переключает старый iframe.

В документ не передаются session, исходный share token, ключи или полномочия API. Сам короткий URL виден документу и имеет лишь право чтения одной версии. Логи/proxy не должны записывать capability URL.

## UI и политика документа

Только явный запуск на странице HTML, не в карточке. (22.09.2026: владелец принял автозапуск интерактивной версии; изоляция прежняя. На странице HTML интерактивная версия открывается сразу, в карточке по-прежнему нет; см. [HOSTED_VIEWER_DELTA](HOSTED_VIEWER_DELTA.md).) Видимая пометка локального эксперимента; остановка удаляет iframe, повтор получает новый capability. Статичный просмотр и скачивание остаются. htmlRuntime не становится true до полной приёмки; отдельный liveExperimental сообщает только о доступности эксперимента.

Iframe: sandbox="allow-scripts", no-referrer. CSP документа: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img/font/media-src data:; connect/frame/worker/object-src 'none'; base-uri/form-action 'none'; frame-ancestors APP_ORIGIN. Никаких allow-same-origin, popups, forms или top navigation. Дополнительно no-store/nosniff/noindex. CSP приложения разрешает frame-src конкретного viewer-origin только при включении эксперимента.

## Что этот срез НЕ доказывает

CSP fetch restrictions не равны запрету любой навигации: script может менять адрес собственного frame. Нельзя считать ошибку DNS у .invalid доказательством блокировки egress. iframe также не гарантирует отдельный процесс и остановку бесконечного JS. Поэтому не называть профиль networkless, не публиковать произвольные пользовательские приложения в hosted на основании одного allow-scripts.

Основание: [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [HTML sandbox](https://html.spec.whatwg.org/multipage/browsers.html), [CSP](https://www.w3.org/TR/CSP/). До hosted требуется отдельный эксперимент с self-navigation и решение о способе исполнения/сетевой изоляции; если ограничения меняют обещание продукта, это отражается в DECISIONS. Локальный эксперимент не заменяет конечный безопасный live viewer.

## Приёмка эксперимента

1. Из существующего upload сохранить отчёт/калькулятор/график/слайды/planner; получить live URL через авторизованный endpoint; проверить ожидаемые действия.
2. Чужой tenant, отсутствующая сессия, не-HTML, случайный token, logout, истечение, revoke — отказ без bytes. URL recipient не переживает source grant.
3. Прямой viewer URL не открывает app API/SPA и не ставит cookies; неверная конфигурация не запускается.
4. Браузер: 390/1440, остановка/повтор, неправильный URL, expiry; denied parent DOM/storage, fetch/image/script/form/popups/top-navigation; отдельно self-navigation.
5. Записать ограничения и результаты отдельно от зелёных HTTP/manifest тестов. B2 остаётся открытым до runtime/bundle/source приёмки.

Наблюдение 20.09: в сохранённом observable-probes HTML браузер показал SecurityError для parent DOM/localStorage, popup denied и securitypolicyviolation для connect-src, script-src-elem и img-src. Это частичная браузерная проверка конкретных API; form/self-navigation и полная модель egress остаются отдельными проверками.
