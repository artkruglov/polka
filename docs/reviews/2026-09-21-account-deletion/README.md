# R17: локальная приёмка первого среза

Полное удаление аккаунта не принято. Проверяется только запрос, отзыв доступа и защита от запоздалых операций; purge файлов/metadata/backup ledger отсутствует, UI выключен.

## Конфигурация и review

Luna: 5 subprocess config tests прошли; окружение синтетическое, без DB/S3, ожидание ограничено. Root исправил TypeScript overload для необязательного текста assert; общий `npm run check` прошёл. Sol затем проверил config + migrations: 7/7.

Astra потребовала IP rate-limit до записи capability bucket и ограничение/release worker barrier. Root дополнительно перенёс требования finally на ошибочный CSRF и потребовал завершения child через close перед очисткой. Sol подготовил отдельный runner; root исключил раннюю очистку при post-spawn child error.

## Первый фактический запуск

Команда из корня проекта:

```sh
node --env-file=.env --import tsx scripts/test-account-deletion-isolated.ts --confirm-synthetic
```

Root session24072: exit1. Отдельная schema16 создалась; интеграционный тест дошёл до confirm, где получил HTTP500 / PostgreSQL42P08 вместо202. Никаких доказательств успешного отзыва этим запуском нет. Sol исправляет SQL inference timestamp. Cleanup проверил отсутствие созданных синтетических DB/bucket: `syntheticResidueRemoved:true`. `workingResourcesUsed:false`, `productionPurgeProven:false`. Рабочая schema15 не мигрировалась.

Дополнительно Sol обнаружил гонку /api/resolve: кандидат получен до tenant lock; нужен повторный active-owner check после ожидания lock и до INSERT grant. Исправление и повторная проверка в работе.


## Исправление и повторная проверка

Sol добавил явный timestamptz cast в UPDATE receipt и active-owner recheck после tenant lock в /api/resolve. Добавлены проверки неверного CSRF, невозможности снять marker, исходных bytes/share соседнего владельца и гонки resolve с ожидающим lock.

Root session8906: exit0, интеграционный сценарий1/1. Затем root ограничил наблюдение pg_stat_activity текущей тестовой БД, чтобы чужое ожидание lock не давало ложного результата. Финальная session8993: exit0,1/1; [машиночитаемый результат](synthetic-result.json). Cleanup снова подтвердил отсутствие временных ресурсов. Код проверяет фактические ответы и bytes, а не только флаги итогового отчёта.

Это локальное доказательство первого revoke slice на синтетических ресурсах. Runtime-role grants ещё не испытаны; full purge/ledger/backups и hosted-приёмка не выполнены. Рабочая схема остаётся15, эксперимент удаления выключен.

Astra завершила точечное ревью после финального запуска: cast, active-owner recheck, IP limiter, worker barrier и child-close cleanup приняты без новых блокеров. Это закрывает review первого локального среза, но не full R17 и не рабочую миграцию.


## Локальная интеграция после приёмки

После Astra acceptance и изолированных тестов root проверил рабочую schema15/default-off, затем выполнил `npm run db:migrate`: exit0, schema16. Запросы удаления не выполнялись. Старый процесс76794 остановлен, новый62631 запущен с `ACCOUNT_DELETION_ENABLED=false` и прежним local viewer. `/readyz`200, `/api/editorial`200/12 материалов.

`npm test` session30062:145/145, exit0. Это регрессия локального приложения после миграции; не проверка реальных SMTP/hosted domains/runtime grants. Исторические указания schema15 выше описывают состояние до этого шага.
