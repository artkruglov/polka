# Реальное подключение MCP-клиента

> **Статус:** реализовано. Подключение по токену на странице «Агенты»; OAuth-коннектор описан в [MCP_CONNECTOR](../MCP_CONNECTOR.md).

20.09.2026. Implementation-ready UI contract для R04/R05; backend уже выдаёт scoped tokens. Не OAuth, не встроенный чат. Исполнитель меняет только web UI/client и стили; backend, migrations, worker и MCP tools этого пакета не касаются.

## Маршруты и экран

Один компонент реального подключения использовать на **`/settings/agents` и `/connections`**. Первый уже стоит в SiteChrome и FirstSave; заменить demo AgentSetup, а не оставлять главный пункт на прототипе. Сохранить существующие deep links `#agent`. На этих экранах убрать AgentDelegationDemo, CompanyBoundary, ReviewDemo, TelegramEntryDemo и общий баннер «ничего не отправляется». Их исходники удалять не требуется. Telegram/review/company не становятся работающими функциями. Заголовок «Подключить агента», пояснение «Клиент сможет выполнять только выбранные действия с вашей Полкой».

Два блока: форма нового подключения и список существующих. Client selector: Codex CLI / Claude Code / Другой MCP-клиент; влияет только на имя по умолчанию и инструкцию. Поля: имя 1–80 символов; TTL 1/7/30 дней, default7; scopes с понятными подписями. `context` включён как базовый scope мастера: сведения о подключении, лимиты и статус собственных сохранений. `capture` включён по умолчанию. `read` — список сохранённых работ; `revise` — новые версии существующих работ; `share` — выдача и отзыв ссылок. Эти три разрешения по умолчанию выключены. Объяснить, что share доступен всему tenant, а не только новым сохранениям; token ограничен действиями, а не одной папкой. Нет выбора компании/модели и свободного поля endpoint.

## Точный HTTP-контракт

Все запросы same-origin с session cookie; web Origin-check остаётся браузерным. В `client.ts` добавить отдельные typed методы для agent connections с custom headers, не менять семантику существующего request для всех вызовов.

| Запрос | Request / response |
|---|---|
| `GET /api/agent-connections` | `AgentConnection[]`: id, name, scopes, audience, status, createdAt, expiresAt, lastSeenAt. Все active плюс до100 завершённых, без token/hash. |
| `POST /api/agent-connections/csrf` | `{}` → `{csrfToken, expiresAt}`. Получать непосредственно перед issue/revoke; хранить только в памяти. |
| `POST /api/agent-connections` | Header `x-polka-csrf`; `{name,scopes,audience,ttlDays}` → `{connection: AgentConnection,token}`. Audience сейчас `new URL('/mcp', location.origin).href`; после ответа показывать именно connection.audience. |
| `POST /api/agent-connections/:id/revoke` | Header `x-polka-csrf`; `{}` → `{ok:true}`. Затем перечитать список; повтор безопасен. |

Секреты не передавать в URL, telemetry, console, localStorage/sessionStorage или скачиваемую инструкцию. Token хранится в локальном React state только до закрытия одноразового блока, ухода со страницы или утраты сессии. Не помещать его в сгенерированную команду настройки. Показывать маскированное поле с отдельным раскрытием и «Скопировать токен»; успешное копирование обозначать только после resolve Clipboard API, при отказе оставить ручное выделение. Текст: «Токен показывается только сейчас. После закрытия получить его повторно нельзя; можно отозвать подключение и создать новое». Кнопка «Закрыть токен» действительно очищает значение, список остаётся.

## Инструкция клиента

Показывать endpoint, выбранные разрешения и дату истечения. Написать, что здесь выдаётся токен для CLI-клиентов, а Claude.ai и ChatGPT подключаются коннектором с адресом /mcp через OAuth ([MCP_CONNECTOR](../MCP_CONNECTOR.md)); такие подключения показываются в том же списке с пометкой «коннектор чата». Дать две отдельные операции копирования: секрет и безопасная конфигурация без его значения. Токен пользователь задаёт в окружении запуска клиента как `POLKA_MCP_TOKEN`; не предлагать вставлять его в чат. Для bash/zsh дать `read -r -s POLKA_MCP_TOKEN`, затем пользователь вставляет token и нажимает Enter, затем выполняет `export POLKA_MCP_TOKEN`. Сам token не попадает в текст команды. Клиент запускается из этого же терминала. Endpoint в shell-команде экранировать, в JSON генерировать через JSON.stringify.

Codex CLI: `codex mcp add polka --url '<ENDPOINT>' --bearer-token-env-var POLKA_MCP_TOKEN`. Переменная должна быть доступна процессу Codex. Для Claude Code показать JSON entry, который нужно объединить с существующим `.mcp.json`, не перезаписать весь файл:

```json
{"mcpServers":{"polka":{"type":"http","url":"<ENDPOINT>","headers":{"Authorization":"Bearer ${POLKA_MCP_TOKEN}"}}}}
```

Claude Code поддерживает env expansion для HTTP headers; это ссылка на переменную, а не место для реального токена. [Первичная документация](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json). Codex CLI flags ранее проверены локальным `mcp add --help`; см. [MCP_IMPLEMENTATION_SPEC](MCP_IMPLEMENTATION_SPEC.md). Для другого клиента: Streamable HTTP endpoint и Authorization Bearer из секрета, без обещания поддержки всех клиентов.

Следующий шаг: «Попросите клиента вызвать polka_context, затем обновите состояние здесь». Кнопка «Обновить состояние» делает только GET списка; ни браузер, ни таймер не выполняют MCP от имени клиента ради seen. Для сохранения файлов инструкция отсылает к серверному guide `polka://guides/capture-v1`: bytes передаёт локальный helper, модель не переписывает base64. Не обещать установленный helper или доступность token env в его дочернем процессе; это проверяется отдельным CLI сценарием.

## Состояния и ошибки

Начальный GET списка определяет auth/loading/error: не использовать null из useAccount как доказательство отсутствия сессии, поскольку этот hook также скрывает сетевые ошибки. 401 → вход с безопасным next на текущий маршрут; 5xx/network → ошибка и повтор без потери полей. Пока identity неизвестна, выдача недоступна.

Список отображает серверные состояния: `issued` → «Токен выдан; запросов пока нет»; `seen` → «Получен запрос с этим токеном» и lastSeenAt; `expired` → «Срок истёк»; `revoked` → «Доступ отозван». **Seen не означает verified, успешное сохранение, определённый клиент или готовый preview.** У issued/seen есть «Отозвать доступ» с busy состоянием; результат подтверждается ответом сервера. Отзыв connection не отзывает уже выданные shares — кратко пояснить рядом с действием. Список можно обновлять вручную; бесконечный polling не нужен.

Один pending issue/revoke одновременно; блокировать повторный submit. При ошибке CSRF сохранить форму и разрешить повтор с новым CSRF. При неизвестном результате issue (network/timeout/некорректный ответ) **не выдавать второй токен автоматически**: обновить список, показать «Подключение могло быть создано, но токен не получен. Проверьте список; ненужную запись можно отозвать». У server issue нет idempotency key. Ответ с token нельзя потерять из-за ошибки последующего refresh списка: сначала сохранить one-time result в state. При 401 и unmount отменить/игнорировать поздние ответы и очистить secret; предыдущий запрос не должен записать token в новую сессию.

## Приёмка

Оба маршрута показывают один реальный flow на desktop и390px. Через настоящую session: issue выбранных scopes/TTL → token один раз → список issued без секрета → реальный MCP запрос вне браузера → refresh показывает seen → revoke → следующий MCP запрос отвергнут. Проверить guest/login return, CSRF expiry, list error, потерянный issue response без авто-дубля, clipboard denial, late response после unmount и повтор revoke. После закрытия/перезагрузки token не восстанавливается; нет token в URL/storage/логах и generated config. Проверить доступность клавиатурой, labels/status announcements, отсутствие горизонтального overflow у endpoint/команд. Этот UI-пакет не объявляет завершённой двухклиентную capture/preview/share приёмку.
