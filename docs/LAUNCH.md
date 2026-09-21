# Облачная beta и open-source поставка

Актуальная передача на выпуск (21.09.2026): [CLAUDE_RELEASE_HANDOFF.md](CLAUDE_RELEASE_HANDOFF.md). Текущая схема — 26; исторические ссылки на schema18/20 ниже не использовать как команду нового развёртывания.

План, не описание уже выполненного развёртывания. Провайдер hosted ещё выбирается; Yandex Cloud — кандидат при требовании хранения в России. Доступность app/viewer и MCP нужно проверить из целевых сетей до выбора. Конкретные домены, cloud project, смета, SMTP и оператор ещё должны быть определены. Сейчас приложение работает локально.

## Конфигурация первого staging

Контейнер app/API на VM, отдельный ограниченный worker, Managed PostgreSQL в приватной сети, private Object Storage с versioning, TLS reverse proxy, отдельный домен viewer без app cookies. Секреты через secret manager или эквивалентный deployment secret store. No public bucket, no public DB. Dockerfile с закреплённым base digest уже существует; сборка образа и runtime smoke ещё не приняты из-за registry. В репозитории есть self-host base compose candidate: он предполагает заранее подготовленные внешние DB/S3 и immutable `POLKA_IMAGE`, выполняет `migrate → storage-check → app → maintenance`; restore overlay добавляет отдельный one-shot restore barrier для закрытой восстановленной цели. Эти compose-файлы не запускались и не являются принятой production-поставкой. Отдельный viewer staging candidate рассчитан на существующие loopback Node listeners и не совпадает автоматически с base container topology; HTTPS/browser/egress acceptance ещё открыта. До релиза нужны production compose, health/readiness, проверенный release image digest, migration job, реальные backup и rollback scripts. Synthetic restore drill не заменяет эксплуатационный backup/restore.

Внешние входные для staging: два независимых домена app/viewer и DNS/TLS, проект и регион Yandex Cloud, оператор и согласованный бюджет, SMTP sender с доступом к настройкам домена, обычный доступ к registry. Hosted viewer следует [HOSTED_VIEWER_DELTA](HOSTED_VIEWER_DELTA.md); сетевую приёмку проводить с работающим положительным контролем egress, не считать нулевой счётчик в ограниченной тестовой среде доказательством.

Один API instance допустим для ограниченного staging; перед широкой beta нагрузочный тест определяет необходимость двух реплик. Не декларировать HA на одной VM. Очередь в Postgres достаточна сначала; задания допускают retry/idempotency. Chromium, если нужен для preview, запускается только в worker с лимитами CPU/RAM/time/egress.

Yandex Object Storage поддерживает version_id и чтение конкретной версии; это соответствует нашему подходу pinned blobs, но условные записи и adapter необходимо проверить на самом провайдере. [Документация versioning](https://yandex.cloud/en/docs/storage/concepts/versioning).

У Managed PostgreSQL есть backup/recovery механизмы; приёмка Полки всё равно требует восстановления DB совместно с objects, secrets и состоянием revoked links. [Документация backup](https://yandex.cloud/en/docs/managed-postgresql/concepts/backup).

## Ёмкость: рабочие допущения, не измерения

| Сценарий | Входные параметры | Расчёт |
|---|---|---|
| Beta | 1 000 авторов × 10 артефактов × 2 версии × 2 MB | 40 GB blobs; с запасом ×1.5 около 60 GB, backups отдельно |
| Рост | 50 000 зарегистрированных; 10 000 MAU; 1 500 создающих/месяц × 4 новых артефакта × 12 месяцев | 72 000 артефактов/год |
| Версии роста | 72 000 × 2 версии × 1.5 MB | 216 GB; с запасом ×1.5 около 324 GB, backups отдельно |
| Чтение роста | 20 000 просмотров/день × 3 MB × 30 дней | 1.8 TB egress/месяц |
| Короткий viral peak | 50 req/s metadata, 5 saves/s, 100 одновременных viewers | Нагрузочный сценарий; не текущая пропускная способность |

В расчётах десятичные MB/GB, фактические квоты текущего кода — MiB. Общий размер assets/runtime dependencies включать в manifest. Versioning, thumbnails, storage requests, почта и egress входят в смету. Полная формула бюджета: compute + DB/storage/backups + objects + requests/egress + mail + logs; цены получать перед заказом ресурсов, не фиксировать выдуманную сумму.

Targets beta: metadata p95 <500 ms, первый полезный экран <3 s на согласованной мобильной сети для типового 2 MB артефакта; capture receipt <60 s; целевой RPO ≤15 min/RTO ≤2 h подтверждается restore drill. Доступность 99.5% как внутренний SLO beta, не договорная гарантия. Иные профили крупных bundles измеряются отдельно.

## Условия допуска к beta

Для URL-эксперимента нужен реальный опубликованный артефакт с разрешением на копирование и доступным разрешённым способом получить source/resources. В текущих evidence Claude URL дал shell, затем 403; source capture не подтверждён. Локальные fixtures, shared conversation и screenshot не заменяют эту проверку; отказ доступа не обходить. Для второго клиента нужен доступный Claude Code account без блокирующего provider limit. SMTP-доставку и onboarding затем проверяют реальные новые пользователи; пользовательскую приёмку не заменяют агентские симуляции. Ограничение заявленного URL scope требует явного согласования, оно не считается выполнением исходной цели автоматически.

- [ ] Новый автор регистрируется без оператора и сохраняет через два независимых MCP-клиента.
- [ ] URL-adapter проверен или ограниченный scope beta опубликован явно с корректировкой CTA.
- [ ] Live viewer принят на corpus; HTML не получает app secrets и egress.
- [ ] Независимый получатель без исходного аккаунта открывает артефакт на телефоне; проверить несколько целевых сетей РФ.
- [ ] Полный цикл v1 → share → v2 → явное переключение → revoke; отрицательные tenant tests.
- [ ] Production build/tests проходят; миграции и rollback проверены на staging.
- [ ] Restore DB+blobs+keys; отозванная ссылка не оживает после восстановления.
- [ ] Rate limits, quotas, job deadlines, abuse/report triage, назначенный оператор и контакты.
- [ ] Нет секретов/личных fixtures в репозитории; API/расходы/ошибки наблюдаемы без записи содержимого.
- [ ] Выгрузка своих материалов, удаление аккаунта и сроки очистки/backup retention проверены; private/unlisted не утекли в sitemap/OG/каталог.
- [ ] 12–20 законченных редакционных материалов с происхождением и правами.
- [ ] Правдивый лендинг, privacy/terms/retention и реальные условия хранения проверены для выбранной поставки до публичного запуска.
- [ ] Владелец согласовал конкретный домен, инфраструктуру и ежемесячный лимит расходов.

Публичные landing/docs могут индексироваться; private/unlisted и служебные previews — noindex/no-store. Noindex не авторизация. OG/unfurl unlisted по умолчанию не содержит приватных названия/картинки; соцбот не должен раскрыть больше, чем явно разрешил владелец.

## Open source

Один код продукта и доменные контракты для hosted/self-hosted. Apache-2.0 проекта не отменяет лицензий зависимостей. Base deployment: Compose, PostgreSQL, совместимый S3, mail adapter, домены/HTTPS, migrations, backup/restore, upgrade N→N+1, sample env без секретов. Не требовать чужого SaaS для базового хранения. Enterprise SSO, admin policy и offboarding — отдельная приёмка C3, не обещание готовности в beta.

## MCP-совместимость

Текущий локальный MCP использует Streamable HTTP и выданный владельцем scoped bearer token: TTL, audience, revoke и отдельная от web session граница. Это реализованный token-based режим, а не OAuth discovery/redirect/PKCE. Версии SDK закреплены в package-lock; фактическая совместимость фиксируется по каждому native клиенту. Codex CLI 0.153.4 прошёл capture через helper с точными bytes и последующий native status/prepare/share; Claude Code 2.1.278 остановился на provider 429 и ещё не принят. Связанный UI→client flow и облачная приёмка остаются открыты. [Протокол CLI](reviews/2026-09-20-cli-capture/README.md), [контракт MCP](MCP_IMPLEMENTATION_SPEC.md).

OAuth остаётся отдельным будущим режимом, если он нужен выбранным клиентам: тогда отдельно проверяются discovery, redirect/PKCE, scopes и отзыв по актуальной официальной спецификации. Наличие bearer token не доказывает эти возможности и не должно рекламироваться как OAuth-совместимость; существующий session Origin-check не отключается.

## URL-импорт: включение пока не принято

По умолчанию `URL_IMPORT_ENABLED=false`. Для отдельной тестовой установки подготовлены очередь миграции019, HTTP/MCP gateway и UI. `npm run test:url-import-runtime` проверяет реальное сохранение/сборку на временной локальной базе без миграции рабочей. Требуется PostgreSQL CREATEDB только для этого тестового runner; production runtime это право не получает.

Локальный импорт под ограниченной ролью проверяется `npm run test:url-import-restricted` (5/5). Runtime/purge/restore recipes согласованы со schema20. Полная локальная проверка на отдельной базе прошла:14/14, включая удаление подготовленных URL-исходников при purge. Команда: `node --env-file=.env --import tsx scripts/test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=20`. Это не облачная эксплуатационная приёмка.

Перед включением в рабочей установке: миграции001–020, актуальные runtime-grants и проверка ограниченной роли; автоматическая сборка/recovery preview; MCP transport; браузерная приёмка; проверка поддерживаемых публичных источников и исходящей сети в целевом облаке. `previewing` означает сохранённую копию и незавершённую сборку; `ready` выставляется после сборки viewer, `partial` сохраняет копию при ограничениях просмотра. Автоматический шаг и MCP transport проверены на отдельной установке; браузерная приёмка ещё не завершена. Claude/ChatGPT не объявлены поддерживаемыми. Не включать флаг как способ обойти эти критерии.
