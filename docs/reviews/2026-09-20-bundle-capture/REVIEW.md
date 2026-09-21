# Пакет файлов: локальный capture и export

20.09.2026. Astra — контракт и статическое ревью; Sol — backend/миграция/tests; Luna — Preview/download; ведущий — live gate, оригинальный corpus, реальный HTTP smoke и интеграция.

## Что работает

Новая /api/bundle-uploads цепочка begin → put files → finalize, статус и отмена. Одна immutable revision, manifest/hash и pinned resources. Общие single/bundle квоты и ключи повторов; CAS защищает текущую версию. Миграция 007 применена локально; прежний dev остановлен до неё и затем запущен снова.

Владелец получает полный JSON-пакет через /api/revisions/:id/export. Все оригиналы остаются неизменны. revision.size/hash — entrypoint, totalSize — весь пакет. UI использует export для «Скачать весь пакет»; отдельный /bytes по-прежнему означает entrypoint. Архив ZIP и пользовательский импорт такого export пока не реализованы.

Maintenance удаляет ожидаемые незавершённые blobs, включая запись в S3 до DB rollback, и защищает committed resources. Single endpoints отклоняют bundle IDs. Пакет пока не запускается и не публикуется: источник runtime в manifest не даёт разрешения исполнения.

## Доказательства

- Sol: 57/57 default tests (5 bundle capture cases и5 pure builder cases с несколькими сценариями); Astra: статическое ревью, блокеров не найдено.
- Ведущий: 7/7 live tests, включая owner/recipient issuance и повторное чтение уже выданного capability после смены synthetic storage metadata.
- Отдельный HTTP smoke на настоящем 127.0.0.1:4390, synthetic account, оригинальный team-report: 4 файла, 2880 bytes, export побайтно совпал, retry вернул тот же receipt. [Receipt/hashes](http-smoke.json). Первый smoke ошибочно сравнивал порядок JSON-ключей; исправлен на сравнение структуры, повтор прошёл. Это не баг продукта.
- Браузерная проверка owner bundle UI пока не выполнена; UI проверен чтением веток Preview/download и сборкой после завершения параллельных изменений.

## Ещё не принято

Автономный просмотр пакета и сборщик производного, hosted isolation, URL capture, MCP/auth двух клиентов, SMTP/пилот и облачная поставка. B2 не закрыт. Pure builder реализован отдельно, прошёл5 unit cases и не меняет доступность runtime. Astra нашла3 false-ready, Luna исправила их и добавила regression cases; отдельная повторная проверка фиксируется ниже. Итоговые TypeScript/build также прошли.

## Повторная проверка Astra

Три контрпримера теперь возвращают ok:false. Оригинальный team-report собирается в2926 bytes, consumedPaths включает4 файла, повтор даёт тот же hash. Pure builder принят в проверенном объёме; это не приёмка браузерной интеграции.
