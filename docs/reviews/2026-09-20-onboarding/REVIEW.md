# B1: первый рабочий срез

Реализованы /signup, /start, /settings/agents, вход по одноразовому коду и создание tenant, SMTP/local delivery adapters, миграция без изменения старых accounts. Обычный login/password остаётся. Signup возвращает к safeNext; проверены backslash/control-character redirects. Гостевой file-save ведёт в signup и обратно на файл (его нужно выбрать повторно).

OTP: 10 минут, 5 попыток на challenge, лимиты email/IP в общей DB, HMAC хеша с серверным ключом, browser-bound cookie, consumed state в транзакции; advisory lock на identity при одновременных challenges. Сессия HttpOnly/SameSite, старый session token сбрасывается после успешного входа. Отдельные rate keys для password и email. Коды не возвращаются API и не логируются.

Local mail допускает только loopback APP_ORIGIN/HOST и .test email; сообщение лежит в .local/mail с правами 0600. email_verified_at остаётся NULL. SMTP использует Nodemailer, требует TLS, настроенный host/from, ограниченные таймауты; реальные доставка/домен/письма пока не проверены. По умолчанию MAIL_MODE=disabled, на текущей локальной установке явно local. Сгенерированные тестовые аккаунты не представляются реальными пользователями.

34 теста проходят; полный протокол — [tests.txt](tests.txt). Интеграция проверяет реальную DB: browser binding, once-only, stable account/tenant при повторном входе, сохранение файла новой identity, expiry, попытки, local domain restriction. Браузером проверены страницы signup и настройки агентов; полный SMTP/user-mobile сценарий не пройден.

Восстановление challenge реализовано через GET /api/auth/email/current: только связанный браузер получает email/срок/cooldown, без кода. Интеграционный тест проверяет отсутствие доступа без cookie. Maintenance удаляет использованные/истёкшие challenges и local outbox, сохраняя активные. Планировщик maintenance в production ещё не настроен.

B1 не закрыт: SMTP-доставка и проверка с 5 новыми пользователями не приняты; браузерная приёмка восстановления после reload ещё нужна; нет привязки email к прежнему operator account через UI. Мастер MCP — явный прототип, не реальная интеграция B3.

При сверке документации повторно прошли npm run check и npm run build. [Протокол сборки](build.txt). Тестовый протокол сохранён из последнего успешного прогона; тесты ради изменения markdown повторно не запускались.


## Browser reload — 21.09.2026

Root через Codex in-app browser открыл `/signup?next=%2Fbring`, запросил код для собственного синтетического адреса в example.test и перезагрузил страницу. Сохранились тот же challenge, форма «Введите код», disabled resend с продолжающимся cooldown (60→56с) и next=/bring. Локальная доставка явно обозначена как тестовая. Код не вводился, аккаунт не создавался, существующая сессия не заменялась; тестовая вкладка закрыта. Challenge/mail истекают штатно. Это подтверждает восстановление ожидающего кода в браузере, не SMTP-доставку или полный вход нового пользователя.
