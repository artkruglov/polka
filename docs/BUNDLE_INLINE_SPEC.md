# Производное для живого просмотра пакета

20.09.2026. Следующий шаг [BUNDLE_SPEC](BUNDLE_SPEC.md). Оригинальные файлы и их export не меняются. Сборщик подключён к локальному HTTP/viewer через отдельное производное; один recipient-сценарий проверен в браузере (см. протокол ниже).

## Чистый сборщик

`buildInlineBundle(manifest, Map<path, Buffer>)` сверяет канонический manifest, размеры/hash/UTF-8, затем создаёт воспроизводимые bytes без сети и выполнения JS. Выход: ok, html, sha256, size, sourceManifestSha256, builderVersion=bundle-inline-v2, runtimeProfile=bundle-inline-experimental-v1, consumedPaths. Либо structured unsupported с причиной/path.

Для оригинального team-report поддержаны синхронный classic script, локальная CSS и инертная SVG-картинка. HTML разбирается [parse5](https://parse5.js.org/), CSS — [PostCSS](https://postcss.org/api/), корректность XML проверяет [saxes](https://github.com/lddubeau/saxes). Результат ограничен8MiB.

Неподдержанные ресурсы, modules/async/defer, CSS imports/resource functions/escape forms, выход за корень и повреждённые bytes дают отказ. Stylesheet link с дополнительными атрибутами пока отклоняется, чтобы не менять их смысл при замене на style. SVG ограничен простыми инертными элементами/атрибутами. Это ограничение первого builder, не запрет сохранять богатый оригинал.

Сборщик не доказывает эквивалентность произвольного JS: currentScript, вычисляемые URL, provider API и storage могут зависеть от исходной среды. CSP и авторизация остаются отдельной защитой. Пока5 unit cases проходят, включая determinism/original hashes и3 исправленных false-ready из ревью Astra. Автономное поведение team-report проверено через настоящий локальный viewer.

## Контракт интеграции и приёмка

1. Отдельная запись производного: revision_id, source manifest hash, builder version, runtime profile, собственные hash/size/object key/version. Уникальность revision+source hash+builder version обеспечивает retry. Не переписывать revision_files или оригинальный manifest.
2. Builder читает только pinned original resources из service layer. Учесть отдельный лимит/расход хранения производных и cleanup неудачных build; сохранить unsupported outcome без ложного ready.
3. Live issuance/read разрешает bundle только при наличии соответствующего принятого производного, повторно проверяя session/share/tenant/expiry/revoke и локальный флаг. Текущий blanket bundle gate не удалять раньше интеграционных проверок. Hosted runtime по-прежнему выключен.
4. Проверить загруженный team-report: CSS+эмблема,12/8 →9/11 →12/8, width390, оригинальный export unchanged; ошибки/builder disable/tenant/revoke. Сборка в unit test не закрывает этот сценарий.
5. После local evidence отдельно решать hosted isolation и совместимость следующего корпуса; importer/MCP используют тот же оригинальный capture service.

## Реализовано локально

Миграция008 хранит immutable derivative отдельно от оригинала. POST/GET `/api/revisions/:id/build-inline` управляют подготовкой и состоянием. Worker ограничен временем/памятью, одновременно допускаются два build; отдельная квота производных. Grants фиксируют конкретное производное и повторно проверяют исходный доступ. GC и retry учитывают S3-success/DB-rollback. HTML/SVG имеют ограничения глубины и числа узлов.

58 default и 3 runtime integration tests прошли. Отдельный HTTP smoke: четыре оригинальных файла сохранены и экспортированы побайтно, build/status ready, ссылка создана. Это ещё не подтверждение браузерного взаимодействия или hosted isolation. Подробности — [протокол](reviews/2026-09-20-bundle-runtime/README.md).
