# Manifest и пакет файлов v1

> **Статус:** реализовано. Manifest и multi-file capture работают; сборка производной для просмотра — [BUNDLE_INLINE_SPEC](../BUNDLE_INLINE_SPEC.md).

Контракт для общего пути файла, MCP и URL-import. Это не DeckDoc: содержимое остаётся произвольным HTML/CSS/JS и ресурсами. [ARCHITECTURE](../architecture.md), [ROADMAP](../roadmap.md).

## Уже реализовано

`packages/contracts/bundle.ts`: строгий JSON manifest с version, entrypoint, runtime, files, provenance, dependencies. Канонизация задаёт порядок ключей и сортирует files по ASCII path. Хеш — SHA-256 UTF-8 JSON.stringify(canonicalizeManifest(manifest)); JSONB при чтении нужно канонизировать снова, порядок ключей базы не является исходным сериализованным JSON.

- 1–64 файла, каждый до MAX_BYTES, суммарно 1–MAX_BYTES (сейчас 5 MiB).
- Относительные ASCII POSIX paths, максимум 200 символов и 8 сегментов, без traversal, URL/percent/query/fragment/backslash и case collisions. Entrypoint — ровно один существующий ненулевой text/html файл.
- SHA-256 — 64 lowercase hex. MIME — существующие типы плюс CSS/JS/JSON/SVG/WOFF2; разрешение хранения не означает разрешение выполнения.
- Provenance: kind file/mcp/url, HTTPS sourceUrl без credentials/query/fragment или null, корректное время с timezone, attribution и license. Значение unknown допустимо, авторство не выдумывается. Даже допустимый path URL может содержать секрет: adapter должен отдельно редактировать sourceUrl.
- Dependencies: self-contained с пустым unresolved, incomplete с непустым, либо unknown. Заявление источника не считается проверкой полноты.

Новые одиночные HTML-загрузки уже сохраняют manifest/hash в той же транзакции, что revision и receipt. Entrypoint называется index.html; bytes и исходный filename не меняются. Исходный файл не становится автономным от переименования: dependencies остаётся unknown. Static/limited HTML получают static-sandbox-v1, unsupported — preserved-only-v1. Live запуск остаётся отдельным экспериментом.

Миграция 006 добавляет nullable manifest/manifest_sha256; старые записи не переписываются. Non-HTML остаётся без manifest. Новый HTML receipt содержит manifestSha256; повтор finalize/begin возвращает прежний receipt и не меняет capturedAt/hash. DTO версии передаёт manifest и manifestSha256, null для старых данных.

## Реализовано локально: multi-file capture

1. beginBundle(actor, key/title/target/baseRevision/folder/manifest): transport body ≤64 KiB; канонизация, quota reservation под tenant lock; сервер возвращает канонический порядок files и uploadId. Индексы последующих запросов относятся именно к этому порядку.
2. putBundleFile(actor, uploadId, index, bytes): server-generated storage key, проверка размера/hash/UTF-8 для текста, immutable blob version и повтор без замены содержимого. Не доверять MIME для исполнения.
3. finalizeBundle: все файлы присутствуют; account/tenant/quota/CAS перепроверены; одна revision и receipt на пакет. Обрыв не создаёт половину пакета. Cleanup учитывает все staged blobs.
4. revision сохраняет entrypoint hash отдельно от manifest hash, суммарный размер и immutable object versions ресурсов. Нельзя создавать отдельную revision каждого файла существующим finalizeUpload.
5. Export возвращает пакет и manifest; viewer принимает только реально поддержанный профиль. Пока multi-file runtime не принят, сохранённый пакет получает фактический preserved-only режим; это не закрывает конечную задачу автономного просмотра.

ZIP — возможный транспорт позднее, а не обязательная архитектура. Его добавление потребует ограничений распаковки/traversal/symlinks. Внешние CDN/модули, fetch и server-side приложения не начинают работать от одного добавления manifest. Bundler/importer должны сохранить ресурсы и согласованно изменить ссылки либо явно сообщить неполноту.

## Принятый контракт интеграции 

- Общая uploads с kind single/bundle, единым ключом идемпотентности и лимитом восьми pending. request.size для пакета вычисляется сервером, поэтому резерв квоты включает оба транспорта.
- upload_files хранит staged object versions; revision_files — закреплённые ресурсы. revision.size/sha256/object_key/object_version продолжают описывать entrypoint. total_size — весь пакет и расход квоты, storage_kind отличает транспорт.
- begin/put/finalize на /api/bundle-uploads; status сообщает полученные индексы, abort сохраняет tombstone. Single и bundle endpoints отклоняют чужой kind.
- /api/revisions/:id/export возвращает владельцу attachment JSON с manifest/hash и base64 bytes всех файлов. /bytes остаётся только entrypoint; UI не должен называть его полным пакетом.
- До runtime-приёмки bundle не выдаёт share/live capability. Повторное чтение live также проверяет storage_kind, а не полагается только на выдачу.
- Cleanup перечисляет все ожидаемые server-generated keys, включая файл после S3 success/DB rollback; защищает revisions/revision_files и не помечает неполный проход завершённым.

## Следующий пакет разработки

Begin/put/finalize, status/abort, полный JSON export и cleanup реализованы и проверены локально. Доказательства. Следующий шаг — воспроизводимое inline-производное для живого просмотра закреплённого bundle, затем importer/MCP. Хранение пакета не означает runtime-приёмку.
