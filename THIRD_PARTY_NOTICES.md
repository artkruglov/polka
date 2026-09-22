# Сторонние компоненты

Полка распространяется по [Apache-2.0](LICENSE). Ниже перечислены сторонние компоненты, которые входят в поставку, и их лицензии. Тексты лицензий лежат в пакетах в `node_modules/<пакет>/` после `npm ci`.

## Библиотеки, которые попадают в страницы пользователей

Runtime `react-runtime-v1` встраивает эти библиотеки в производные интерактивных страниц, поэтому их код доходит до получателя. Список с версиями задан в `packages/contracts/runtime.ts`.

| Библиотека | Версия | Лицензия | Где используется |
|---|---|---|---|
| react | 19.3.0 | MIT | Runtime и интерфейс Полки |
| react-dom | 19.3.0 | MIT | Runtime и интерфейс Полки |
| lucide-react | 1.45.0 | ISC | Runtime и иконки интерфейса |
| recharts | 3.10.1 | MIT | Runtime |
| lodash | 4.18.1 | MIT | Runtime |
| d3 | 7.9.0 | ISC | Runtime |
| three | 0.186.0 | MIT | Runtime |
| papaparse | 5.7.0 | MIT | Runtime |
| mathjs | 15.2.0 | Apache-2.0 | Runtime (уведомление приведено в [NOTICE](NOTICE)) |
| chart.js | 4.5.1 | MIT | Runtime |
| tailwindcss | 4.3.3 | MIT | Генерация CSS для классов Tailwind в runtime-страницах |

Вместе с ними в страницы попадают их транзитивные зависимости. Среди них `victory-vendor` (MIT AND ISC, содержит модули d3 для recharts), `robust-predicates` (Unlicense), `delaunator` и `internmap` (ISC), а также зависимости mathjs (`complex.js`, `fraction.js`, `decimal.js` и другие, MIT). Все они входят в сводку ниже.

## Шрифт

IBM Plex Sans (`apps/web/public/fonts/`), © 2017 IBM Corp., Reserved Font Name "Plex". Распространяется по SIL Open Font License 1.1: [OFL-IBMPlexSans.txt](apps/web/public/fonts/OFL-IBMPlexSans.txt).

## Production-зависимости

Сводка создана командой `npx --yes license-checker-rseidelsohn@4 --production` 22.09.2026 для зависимостей из `package.json` (сама Полка в список не входит). CI проверяет, что новые зависимости используют разрешённые лицензии.

| Лицензия | Пакетов |
|---|---|
| MIT | 136 |
| ISC | 41 |
| Apache-2.0 | 25 |
| BSD-3-Clause | 7 |
| BlueOak-1.0.0 | 5 |
| BSD-2-Clause | 1 |
| MIT-0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| MIT AND ISC | 1 |

<details>
<summary>Полный список пакетов</summary>

**MIT** (136): `@babel/runtime@7.29.7`, `@esbuild/darwin-arm64@0.28.2`, `@fastify/accept-negotiator@2.1.0`, `@fastify/ajv-compiler@4.0.6`, `@fastify/cookie@11.1.2`, `@fastify/error@4.2.0`, `@fastify/fast-json-stringify-compiler@5.1.0`, `@fastify/forwarded@3.0.2`, `@fastify/merge-json-schemas@0.2.1`, `@fastify/proxy-addr@5.1.0`, `@fastify/send@4.1.1`, `@fastify/static@10.1.3`, `@hono/node-server@1.19.17`, `@kurkle/color@0.3.4`, `@lukeed/ms@2.0.2`, `@modelcontextprotocol/core@2.0.0`, `@modelcontextprotocol/fastify@2.0.0`, `@modelcontextprotocol/node@2.0.0`, `@modelcontextprotocol/server@2.0.0`, `@pinojs/redact@0.4.0`, `@reduxjs/toolkit@2.12.0`, `@standard-schema/spec@1.1.0`, `@standard-schema/utils@0.3.0`, `@types/d3-array@3.2.2`, `@types/d3-color@3.1.3`, `@types/d3-ease@3.0.2`, `@types/d3-interpolate@3.0.4`, `@types/d3-path@3.1.1`, `@types/d3-scale@4.0.9`, `@types/d3-shape@3.2.0`, `@types/d3-time@3.0.4`, `@types/d3-timer@3.0.2`, `@types/react@19.3.0`, `@types/use-sync-external-store@0.0.6`, `abstract-logging@2.0.1`, `acorn@8.18.0`, `ajv-formats@3.0.1`, `ajv@8.20.0`, `atomic-sleep@1.0.0`, `avvio@9.3.0`, `balanced-match@4.0.4`, `bowser@2.14.1`, `brace-expansion@5.0.9`, `chart.js@4.5.1`, `clsx@2.1.1`, `commander@7.2.0`, `complex.js@2.4.3`, `content-disposition@2.0.1`, `cookie@1.1.1`, `cookie@2.0.1`, `csstype@3.2.3`, `decimal.js-light@2.5.1`, `decimal.js@10.6.0`, `depd@2.0.0`, `dequal@2.0.3`, `es-toolkit@1.52.0`, `esbuild@0.28.2`, `escape-html@1.0.3`, `escape-latex@1.2.0`, `eventemitter3@5.0.4`, `fast-decode-uri-component@1.0.1`, `fast-deep-equal@3.1.3`, `fast-json-stringify@7.0.1`, `fast-querystring@1.1.2`, `fastify-plugin@6.0.0`, `fastify@5.12.4`, `find-my-way@9.9.0`, `fraction.js@5.3.4`, `hono@4.13.8`, `http-errors@2.0.1`, `iconv-lite@0.6.3`, `immer@11.1.18`, `ipaddr.js@2.5.0`, `javascript-natural-sort@0.7.1`, `json-schema-ref-resolver@3.0.0`, `json-schema-traverse@1.0.0`, `lodash@4.18.1`, `mime@3.0.0`, `nanoid@3.3.19`, `on-exit-leak-free@2.1.2`, `papaparse@5.7.0`, `parse5@8.0.1`, `pg-cloudflare@1.4.0`, `pg-connection-string@2.14.0`, `pg-pool@3.14.0`, `pg-protocol@1.16.0`, `pg-types@2.2.0`, `pg@8.23.0`, `pgpass@1.0.5`, `pino-abstract-transport@3.0.0`, `pino-std-serializers@7.1.0`, `pino@10.3.1`, `postcss@8.5.28`, `postgres-array@2.0.0`, `postgres-bytea@1.0.1`, `postgres-date@1.0.7`, `postgres-interval@1.2.0`, `process-warning@4.0.1`, `process-warning@5.1.0`, `quick-format-unescaped@4.0.4`, `react-dom@19.3.0`, `react-is@19.3.0`, `react-redux@9.3.0`, `react@19.3.0`, `real-require@0.2.0`, `real-require@1.0.0`, `recharts@3.10.1`, `redux-thunk@3.1.0`, `redux@5.0.1`, `require-from-string@2.0.2`, `reselect@5.2.0`, `ret@0.5.0`, `reusify@1.1.0`, `rfdc@1.4.1`, `safe-regex2@5.1.1`, `safe-stable-stringify@2.5.0`, `safer-buffer@2.1.2`, `scheduler@0.28.0`, `seedrandom@3.0.5`, `set-cookie-parser@2.7.2`, `sonic-boom@4.2.1`, `statuses@2.0.2`, `tailwindcss@4.3.3`, `thread-stream@4.2.0`, `three@0.186.0`, `tiny-emitter@2.1.0`, `tiny-invariant@1.3.3`, `tldts-core@7.4.13`, `tldts@7.4.13`, `toad-cache@3.7.4`, `toidentifier@1.0.1`, `typed-function@4.2.2`, `use-sync-external-store@1.7.0`, `xmlchars@2.2.0`, `xtend@4.0.2`, `zod@4.6.4`

**ISC** (41): `d3-array@3.2.4`, `d3-axis@3.0.0`, `d3-brush@3.0.0`, `d3-chord@3.0.1`, `d3-color@3.1.0`, `d3-contour@4.0.2`, `d3-delaunay@6.0.4`, `d3-dispatch@3.0.1`, `d3-drag@3.0.0`, `d3-dsv@3.0.1`, `d3-fetch@3.0.1`, `d3-force@3.0.0`, `d3-format@3.1.2`, `d3-geo@3.1.1`, `d3-hierarchy@3.1.2`, `d3-interpolate@3.0.1`, `d3-path@3.1.0`, `d3-polygon@3.0.1`, `d3-quadtree@3.0.1`, `d3-random@3.0.1`, `d3-scale-chromatic@3.1.0`, `d3-scale@4.0.2`, `d3-selection@3.0.0`, `d3-shape@3.2.0`, `d3-time-format@4.1.0`, `d3-time@3.1.0`, `d3-timer@3.0.1`, `d3-transition@3.0.1`, `d3-zoom@3.0.0`, `d3@7.9.0`, `delaunator@5.1.0`, `fastq@1.20.3`, `inherits@2.0.4`, `internmap@2.0.3`, `lucide-react@1.45.0`, `pg-int8@1.0.1`, `picocolors@1.1.1`, `saxes@6.0.0`, `semver@7.8.5`, `setprototypeof@1.2.0`, `split2@4.2.0`

**Apache-2.0** (25): `@aws-sdk/checksums@3.1001.0`, `@aws-sdk/client-s3@3.1131.0`, `@aws-sdk/core@3.978.0`, `@aws-sdk/credential-provider-env@3.972.71`, `@aws-sdk/credential-provider-http@3.972.73`, `@aws-sdk/credential-provider-ini@3.973.16`, `@aws-sdk/credential-provider-login@3.972.78`, `@aws-sdk/credential-provider-node@3.972.83`, `@aws-sdk/credential-provider-process@3.972.71`, `@aws-sdk/credential-provider-sso@3.973.15`, `@aws-sdk/credential-provider-web-identity@3.972.77`, `@aws-sdk/middleware-sdk-s3@3.972.76`, `@aws-sdk/nested-clients@3.997.45`, `@aws-sdk/signature-v4-multi-region@3.996.46`, `@aws-sdk/token-providers@3.1129.0`, `@aws-sdk/types@3.974.5`, `@aws-sdk/xml-builder@3.972.40`, `@aws/lambda-invoke-store@0.3.0`, `@smithy/core@3.34.1`, `@smithy/credential-provider-imds@4.5.2`, `@smithy/fetch-http-handler@5.8.0`, `@smithy/node-http-handler@4.12.1`, `@smithy/signature-v4@5.7.3`, `@smithy/types@4.18.0`, `mathjs@15.2.0`

**BSD-3-Clause** (7): `d3-ease@3.0.1`, `fast-uri@3.1.7`, `fast-uri@4.1.4`, `light-my-request@6.6.0`, `rw@1.3.3`, `secure-json-parse@4.1.0`, `source-map-js@1.2.1`

**BlueOak-1.0.0** (5): `glob@13.0.6`, `lru-cache@11.5.2`, `minimatch@10.2.6`, `minipass@7.1.3`, `path-scurry@2.0.2`

**BSD-2-Clause** (1): `entities@8.1.0`

**MIT-0** (1): `nodemailer@10.0.10`

**Unlicense** (1): `robust-predicates@3.0.3`

**0BSD** (1): `tslib@2.8.1`

**MIT AND ISC** (1): `victory-vendor@37.3.6`

</details>

Чтобы обновить сводку, выполните `npx --yes license-checker-rseidelsohn@4 --production --summary` после изменения зависимостей.
