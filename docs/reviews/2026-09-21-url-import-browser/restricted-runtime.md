# URL import под ограниченной ролью

Команда: `npm run test:url-import-restricted`. Результат:5/5, TypeScript/check:layers проходят.

Создана отдельная случайная база со схемой001–019 и отдельная LOGIN-роль без superuser/createdb/createrole/bypassrls. Неизменённый deploy/runtime-grants.sql применён через psql как владелец схемы. Тесты подключались непосредственно новой runtime-ролью (current_user=session_user).

Проверено: запрет CREATE TABLE, изменения schema_migrations и TRUNCATE url_import_jobs; сохранение HTML/CSS/JS в S3 и последующая сборка без повторного получения исходника; HTTP-аутентификация, идемпотентность и отмена; сохранение receipt при ошибке preview; настоящий MCP transport и изоляция подключений.

Тестовые версии объектов удаляются штатным after-hook. Runner после удаления проверил отсутствие своей базы и роли: databaseAndRoleRemoved=true. Рабочая база не мигрировалась. Облачная сеть, браузер во всех сценариях и production-развёртывание этим тестом не проверены.

При проверке найден отдельный оставшийся операционный разрыв: purge/restore grants и общий runtime-grants test всё ещё рассчитаны на18 миграций. До обновления полного deployment нужно отдельно согласовать их с19 и повторить общую изолированную приёмку; данный тест принимает только import runtime.
