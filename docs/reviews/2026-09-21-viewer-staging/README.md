# Controlled viewer staging: runtime принят локально

Astra проверил контракт: выдача владельцу, выдача получателю и каждое чтение проверяют allowlist immutable revisions; Host проверяется до DB, forwarded authority не используется. CSP/sandbox и предыдущие проверки доступа сохранены. Исправлена local port80 регрессия: ожидаемый Host использует канонический origin. Режим staging требует отдельные HTTPS registrable domains по PSL, secure cookies, loopback listeners и явный список не более100 revisions. По умолчанию runtime выключен.

Root: штатный набор193/193, live9/9, TypeScript и build прошли. [Результаты и хеши](runtime-result.json). Это локальная приёмка конфигурации и HTTP/service поведения; реальные публичные TLS и browser egress не проверены. UI исправлен: staging называется «Тестовый просмотр»; прежний сервер без liveMode сохраняет legacy local поведение. Sol повторно проверил TypeScript/build после UI-правки; root проверил код. Browser-приёмка этого текста отдельно не выполнялась.

Proxy: root/Astra нашли и исправили unknown HTTPS host routing, capability-path logging и proxy default1MiB body limit. Финальная конфигурация с app8m прошла nginx1.27.5 `-t` на существующем локальном образе без сети; временные сертификаты удалены, listener не запускался, trust store не менялся. [Evidence](nginx-syntax.json).

Следующая приёмка: выбранные оператором домены и TLS → закрытый staging → реальный browser viewer с положительным контролем egress, навигацией, ресурсными подсказками, WebRTC и ограничениями CPU → подтверждение сценария автора/получателя. Рабочая БД не мигрировалась, сервер не перезапускался. Нельзя объявлять hosted runtime или cloud beta готовыми по этим проверкам.


## Реальное TLS/SNI наблюдение

Root запустил исходный proxy в изолированном network-none контейнере с временным SAN-сертификатом и проверкой цепочки через curl `--cacert`. При разных SNI и Host обе пары доходили до другого upstream (502 при намеренно отсутствующих upstreams), хотя должны были отвергаться. Добавлена проверка `$ssl_server_name` в оба HTTPS vhost. После исправления совпадающие пары сохраняют контрольный502, несовпадающие возвращают421; nginx syntax проходит. [До/после и hash](sni-host-result.json). Контейнер удалён, host ports не открывались, trust store не изменялся. Полный тест headers/logs/body с работающими синтетическими upstreams ещё готовится; эта проверка его не заменяет.


## Полный synthetic proxy smoke: 14/14

Root реализовал [повторяемый сценарий](../../../scripts/test-viewer-proxy.py), Astra проверил границы запуска и утверждения теста. Первый запуск [12/14](proxy-first-failure.json) выявил unknown Host после успешного TLS и capability marker в общем error log. Исправлены default TLS return421 и main-context отключение текстовых error logs. Потеря текстовой диагностики явно описана в runbook; безопасные access статусы остаются.

Повторный запуск95254: [14/14](proxy-result.json), включая реальные TLS handshake, cross-SNI/Host, credential stripping, CSP/no-store/nosniff, 2MiB/9MiB body limits, malformed Host, upstream502 и отсутствие marker во всех proxy logs. Контейнер удалён; сеть отсутствует, порты не публиковались, рабочая DB и trust store не менялись. После этого добавлен SIGTERM cleanup handler; прерывание отдельно не тестировалось. Прежние nginx-syntax и SNI evidence относятся к предыдущим hash конфигурации; текущий hash находится в proxy-result.


## Browser positive control: блокер среды

После proxy14/14 root запустил synthetic counter на loopback4392 (session79502, готовность подтверждена). Прямое открытие `/control` в Codex in-app browser снова завершилось `ERR_BLOCKED_BY_CLIENT`. [Факт проверки](browser-control-result.json). Без успешного positive control отрицательные iframe probes не запускались и не засчитывались. Сервер остановлен (exit130); настройки браузера/безопасности не менялись. Для продолжения нужен доступный проверяемому браузеру контролируемый collector и выбранная staging-конфигурация; повтор того же запроса при неизменной среде бесполезен.
