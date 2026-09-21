# Изолированная приёмка runtime-role schema16

Root session35988, exit0:

```sh
node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic
```

Astra проверила разделение ролей, exact recipe, assertions и cleanup. До запуска Sol исправил lifecycle: remote psql имеет собственный deadline25s/TERM +5s/KILL, PG statement/connect/lock bounds; host bound40s. Закрытие Docker CLI само по себе не считается доказательством завершения remote process при transport fault. PG close и чтение sentinel ограничены по времени.

Созданы отдельные случайные schema-owner/runtime LOGIN и синтетические DB/bucket. Миграции выполнялись как schema owner, неизменённый deploy/runtime-grants.sql применён через psql. Приложение подключалось непосредственно как runtime (current_user=session_user), без SET ROLE обхода.

Проверки3/3: реальная непривилегированная identity; SQLSTATE42501 для изменения schema_migrations, DDL/TRUNCATE/SET ROLE/DELETE protected receipts/direct function execution и future default ACL; разрешённые app DML/audit sequence, marker trigger и sessions→CSRF cascade.

Затем полный revoke slice1/1 прошёл под той же runtime ролью: plan/confirm/retry/status, закрытие session/agent/share/grant/viewer/export, worker после CPU, сохранность соседних bytes/share, resolve lock race. Это первый revoke slice, не full purge.

Очистка проверила отсутствие созданных DB/bucket и обеих ролей. Рабочие grants/роли/данные не менялись. Production image/startup, purge worker role и облачное окружение не принимались.
