# Внешняя проверка в Yandex Cloud Functions

[`scripts/ci/uptime.mjs`](../../scripts/ci/uptime.mjs) по таймеру, вне VM установки, с письмом оператору. Так она работает для polochka.app с 28.09.2026. Если облако другое, подойдёт cron на любой машине вне VM ([deploy/hosted](../hosted/README.md#мониторинг)).

Каждые 5 минут функция запускает те же проверки: приложение, домен просмотра, сертификаты и `/api/ops/status`. Письмо уходит, когда набор упавших проверок меняется: «Полка polochka.app: не проходит — app health, operator status» и «все проверки снова проходят». Прошлый результат хранится в маленьком бакете, потому что функция между запусками ничего не помнит. Письмо не ушло — состояние не записывается, и следующий запуск отправит его снова.

## Что создать (папка установки)

| Ресурс | Зачем |
|---|---|
| Сервисный аккаунт `polka-uptime` | Без ролей в папке |
| Бакет `polka-uptime-state` (1 МБ) | Прошлый результат; ACL — полный доступ только `polka-uptime` |
| Статический ключ `polka-uptime` | Для бакета |
| Секрет Lockbox `polka-uptime` | `OPS_STATUS_TOKEN`, `SMTP_USER`, `SMTP_PASS` (ключ Postbox с правом только на отправку), `S3_KEY_ID`, `S3_SECRET`; `polka-uptime` — `lockbox.payloadViewer` на этот секрет |
| Функция `polka-uptime` | Node 22, `index.handler`, 256 МБ, таймаут 540 с, сервисный аккаунт `polka-uptime`. Архив: `index.js`, `package.json` отсюда и `uptime.mjs` из `scripts/ci/` |
| Триггер `polka-uptime-5m` | Таймер `*/5 * ? * * *`; `polka-uptime` — `functions.functionInvoker` на функцию |

Переменные функции: `APP_ORIGIN`, `VIEWER_ORIGIN`, `ALERT_TO`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `STATE_BUCKET`, `UPTIME_PAUSE_MS` (10000); секреты — из Lockbox.

## Обновление и проверка

После изменения `uptime.mjs` или `index.js` — новая версия функции тем же архивом. Проверить доставку: версия с несуществующим `APP_ORIGIN` → вызов (письмо «не проходит») → версия с настоящим адресом → вызов (письмо «снова проходят»). Первый вызов сразу после новой версии может попасть на прежнюю.

```sh
yc serverless function invoke --folder-id <папка> --name polka-uptime   # {"failing":[],"alerted":false}
yc serverless function logs --folder-id <папка> --name polka-uptime --since 1h
```
