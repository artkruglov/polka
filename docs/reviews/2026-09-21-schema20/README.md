# Schema20: очередь импорта и удаление аккаунта

Найдена ошибка: tenant сохраняется после anonymization, поэтому его FK ON DELETE CASCADE не очищал owner-задания url_import_jobs. В prepared мог сохраняться HTML, в request — исходный URL.

Миграция020 обновляет terminal_erase_account_metadata: удаляет url_import_jobs только для job.tenant_id в той же защищённой транзакции. Существующие блокировки, проверки попытки и prerequisites сохранены. Runtime/purge/restore recipes теперь требуют schema20.

В purge SQL fixture добавлено prepared-задание без agent connection (для него cascade от подключения не сработает). После terminal erase проверяется отсутствие записи. Полная isolated-role проверка:14/14, чистая временная DB/schema-owner/runtime/purge/restore, локальные S3 buckets; cleanup confirmed. Итог в result.json.

Команда: `node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=20`. Дополнительно: npm test207/207; npm run test:url-import-restricted5/5 на schema20; TypeScript/check:layers прошли.

Рабочая база и сервер не обновлялись; облачный запуск не проверен.
