# Подключить агента

Полка принимает работы из четырёх мест: чат-приложений (коннектор), CLI-агентов (MCP по токену), скриптов (HTTP API) и из рук самого пользователя (файл или вставка кода). На каждом пути действуют одни и те же лимиты и правила показа.

В примерах используется адрес `https://polochka.app`. На своей установке подставьте свой `APP_ORIGIN`.

## Быстрый старт: один раз на человека

Работу на Полку сохраняет агент. Сохранения по ссылке на артефакт Claude или ChatGPT нет ([FAQ](faq.md#почему-нельзя-вставить-ссылку-на-артефакт-claude-или-chatgpt)); файл с компьютера по-прежнему можно загрузить. Та же инструкция — вверху полки для нового пользователя и на странице «Агенты» (`/settings/agents`).

| Где вы работаете | Что сделать один раз | Что приходит |
|---|---|---|
| **Claude** — claude.ai и Claude Desktop | Settings → Connectors → **Add custom connector**, URL `https://polochka.app/mcp` → Add → Connect → «Разрешить» в Полке | MCP-сервер (инструменты Полки) |
| **Claude Code** | `claude plugin marketplace add artkruglov/polka-plugin && claude plugin install polka@polka`, затем в Claude Code `/mcp` → `plugin:polka:polka` → Authenticate | MCP-сервер и все скиллы Полки |
| **Codex** (CLI и приложение) | `codex plugin marketplace add artkruglov/polka-plugin && codex plugin add polka@polka`, затем `codex mcp login polka` | MCP-сервер и все скиллы Полки |
| **Другой MCP-клиент** (Cursor, Gemini CLI, Windsurf…) | Удалённый MCP-сервер `https://polochka.app/mcp` (Streamable HTTP, OAuth) и скилл `npx skills add artkruglov/polka-plugin` | MCP-сервер и скилл `polka` |

Вход везде один: откроется Полка, вы входите в свою полку (или «Начать без регистрации») и нажимаете «Разрешить». Токены и пароли через агента не проходят. Потом в любом чате: «Сохрани это на Полку».

**Для команды.** Разошлите коллегам строку для их клиента из таблицы — больше ничего настраивать не нужно. Плагины обновляются из репозитория: `claude plugin marketplace update polka && claude plugin update polka@polka`; в Codex — `codex plugin marketplace upgrade polka`, затем снова `codex plugin add polka@polka`. Версия плагина совпадает с версией Полки в `package.json` и растёт с релизом. Скиллы плагин берёт из каталога [`skills/`](../skills) целиком, новый скилл приходит с обновлением.

## Плагин Полки для Claude Code и Codex

Плагин ставится из маленького репозитория [artkruglov/polka-plugin](https://github.com/artkruglov/polka-plugin), меньше 100 КБ. Клиент клонирует маркетплейс целиком, и клон всего ядра (десятки мегабайт истории) в облачных сессиях и на медленной сети обрывался (`invalid index-pack output`). Репозиторий плагина собирается из этого командой `node scripts/plugin-repo.mjs <папка>` после каждого изменения манифестов или скиллов и при релизе. Правки вносятся здесь, а не там. Старый адрес `artkruglov/polka` тоже остаётся маркетплейсом, для уже установленных плагинов.

Файлы плагина, в обоих репозиториях одинаковые:

| Файл | Для чего |
|---|---|
| [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) | Маркетплейс `polka` с одним плагином `polka` (корень репозитория) для Claude Code |
| [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json), [`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json) | То же для Codex |
| [`.mcp.json`](../.mcp.json) | Удалённый HTTP MCP-сервер `polka` → `https://polochka.app/mcp`; OAuth при первом подключении |
| [`skills/*/SKILL.md`](../skills) | Скиллы; оба клиента находят их по каталогу, список в манифестах не перечисляется |

Установка из `artkruglov/polka-plugin` проверена 27.09.2026 в пустых профилях: клон за секунду, `claude plugin install polka@polka` и `codex plugin add polka@polka` проходят. Проверено 25.09.2026 на Claude Code 2.1.282 и Codex CLI 0.153.4 установкой из локальной копии репозитория в пустой профиль (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): `claude plugin validate .` проходит, `claude plugin details polka@polka` показывает скиллы из `skills/` и MCP-сервер `polka`, `claude mcp list` — `plugin:polka:polka: https://polochka.app/mcp (HTTP) - ! Needs authentication`; `codex mcp list` — `polka  https://polochka.app/mcp … enabled  OAuth`. Второй скилл, добавленный в `skills/`, подхватывается без правки манифестов.

Внутри сессии Claude Code те же команды: `/plugin marketplace add artkruglov/polka-plugin`, затем `/plugin install polka@polka` и `/reload-plugins`. Своя установка Полки: плагин смотрит на `polochka.app`; для другого адреса подключите MCP-сервер командой из раздела [ниже](#claude-code-и-codex-без-плагина) и поставьте скилл `npx skills add <ваш APP_ORIGIN>`.

В клоне этого репозитория Claude Code предложит включить проектный сервер из `.mcp.json` — это тот же `polochka.app/mcp`; для разработки можно отказаться.

## Claude.ai и ChatGPT: коннектор

Полка подключается как удалённый MCP-сервер `https://polochka.app/mcp` со входом через OAuth 2.1. Client ID вводить не нужно: приложение регистрируется само (Dynamic Client Registration).

**Claude.ai и Claude Desktop (Pro/Max).** Settings → Connectors → **Add custom connector**. Коннектор, добавленный в одном месте, виден и в другом. Name: `Полка`, URL: `https://polochka.app/mcp`. Нажмите **Connect**, войдите в Полку и разрешите доступ. После этого включите коннектор в чате и попросите: «Сохрани этот артефакт на Полку и дай ссылку».

**Claude Team / Enterprise.** Владелец организации добавляет коннектор в Admin settings → Connectors. Каждый участник подключает его сам и входит в **свою** Полку. Общего токена нет.

**ChatGPT.** Settings → Apps & Connectors → Advanced settings → **Developer mode**. Затем **Create**: Name `Полка`, MCP Server URL `https://polochka.app/mcp`, Authentication **OAuth**. В чате выберите коннектор в меню «+».

Модель вызывает `polka_publish` и возвращает ссылку `https://polochka.app/s#…`. Если ссылка ждёт проверки модератора Полки (первые ссылки нового аккаунта или страница, похожая на фишинг), ответ содержит `moderation: "held"` и `moderationMessage`: модель должна сказать, что получатели увидят работу после проверки, а не выдавать ссылку за готовую. Если на установке включён интерактивный просмотр, Полка сама собирает интерактивную версию. Если сборка не удалась, работа всё равно сохраняется, а модель получает причину.

На странице согласия по умолчанию отмечены все разрешения, которые запросило приложение (решение владельца 25.09.2026: агент должен сразу работать): `context`, `read`, `source:read`, `capture`, `revise`, `share`, `manage` и `sign_in`. Любое можно снять перед «Разрешить». Без `share` работа сохраняется приватно, и ссылки в ответе нет. На полке отдела, где вы читатель, можно дать только чтение. Как устроены протокол, согласие и отзыв, описано в [MCP_CONNECTOR](MCP_CONNECTOR.md).

**В какую полку пойдут работы.** Страница согласия показывает полку и способы входа в неё: «Работы будут сохраняться в полку «…» (почта …, Яндекс ID)». Если полка не та — «Выйти и войти в другую».

**Без регистрации.** Если в браузере не выполнен вход, на странице согласия можно нажать «Начать без регистрации»: откроется временная полка этого браузера, и агент подключится к ней. Она сохраняет работы приватно, но ссылок не выдаёт, пока её не закрепят входом через Яндекс ID, VK ID или по почте — так требует ч. 10 ст. 8 149-ФЗ. Какие адреса почты принимаются, решает установка (`EMAIL_SIGNUP_DOMAINS`): на polochka.app любые, в шаблоне `deploy/hosted` — только российские домены. В ответе `polka_publish` тогда `url: null` и `claimUrl` — адрес, где полку закрепляют. Второй агент в том же браузере попадает в ту же полку. Если способ входа уже открывает другую вашу полку, Полка предложит их объединить. Временную полку, которой 30 дней не пользовались, Полка удаляет. Подробно — [SIGN_IN_PROVIDERS.md](specs/SIGN_IN_PROVIDERS.md), § 8.

**Вернуться в полку из браузера: «Открой мою Полку».** Агент, подключённый через OAuth (Claude.ai, ChatGPT, Claude Code, Codex), по этой просьбе вызывает `polka_open_shelf`.
- Для закреплённой полки он даёт ссылку на её страницу входа (`/signin?shelf=…`): секрета в ней нет, вы входите как обычно.
- Для временной полки он может дать одноразовую ссылку `https://polochka.app/enter#…`, только если при подключении оставлено «Давать ссылку для входа» (scope `sign_in`; на странице согласия отмечено по умолчанию, его можно снять там же или позже на странице подключения). Ссылка действует 5 минут, открывает полку после вашего подтверждения и только для просмотра: закрепить полку или подключить агентов после такого входа нельзя, пока вы не войдёте через Яндекс ID, VK ID или по почте.

## Проще всего: одна фраза агенту

Скажите агенту, который работает на вашем компьютере (Codex, Claude Code):

> Подключи Полку: https://polochka.app/connect

По этой ссылке лежит инструкция для агентов. Агент сам выполнит нужную команду (Claude Code и Codex ставят плагин Полки), откроется Полка: войдите в свою полку (или нажмите «Начать без регистрации») и нажмите «Разрешить». Токены и пароли через агента не проходят.

ChatGPT и Claude.ai в браузере команды не выполняют и, как правило, не могут открыть `/connect`: их песочницы не пускают на незнакомые домены. Там коннектор добавляет сам пользователь (раздел выше); страница `/settings/agents?client=chatgpt` или `?client=claude-ai` показывает эти шаги с кнопками копирования, а `/connect` и `llms.txt` велят агенту пересказать их, а не пытаться что-то загрузить.

## Агенту без подсказок: llms.txt, OpenAPI, скилл

Агент, который видит Полку впервые, находит всё сам — как у [justhtml.sh](https://justhtml.sh/llms.txt):

| Адрес | Что там |
|---|---|
| `/llms.txt` | Текст для агента: что такое Полка, как подключиться (человек входит в браузере, агент не трогает пароль и токен), инструменты MCP со scope — список строится из зарегистрированных инструментов этой установки, HTTP API с примером curl, лимиты, модерация и как показать результат человеку |
| `/openapi.json` | OpenAPI 3.1 HTTP API (`/api/v1/publish`, `/api/v1/status/:id`, `/api/v1/works`, `/api/v1/works/:id`, `/api/v1/events`, `/api/v1/task-token`, CLI), собран из zod-схем маршрутов |
| `/.well-known/agent-skills/index.json` | Индекс [Agent Skills](https://agentskills.io) со скиллами `polka` и `polka-organize` (`/.well-known/agent-skills/<имя>/SKILL.md`, SHA-256 в индексе) |

Все адреса внутри берутся из `APP_ORIGIN` установки. Поставить скилл агенту:

```sh
npx skills add artkruglov/polka-plugin          # из репозитория: skills/polka и skills/polka-organize
npx skills add https://polochka.app      # с установки: /.well-known/agent-skills/index.json
```

Скилл учит: подключиться через `/connect`, сохранить `polka_publish`, выпустить ссылку заново после новой версии, отдать человеку ссылку `…/s#…` с пояснением, что работа приватна, а ссылка без каталога, передать `moderationMessage`, если ссылка ждёт модератора, и никогда не трогать пароли и токены; сохранять в подходящую папку, если владелец ими пользуется.

Скилл `polka-organize` раскладывает полку по папкам по просьбе «разложи полку», «наведи порядок в папках», «структурируй работы»: агент читает всю полку и её папки, предлагает 3–8 папок по проектам и темам (серии вроде «Y360 Radar · W36/W37/W38» — в одну), показывает план таблицей «папка → работы» и только после согласия владельца создаёт папки и переносит работы пачками. Папки владельца сохраняются, работы не удаляются, не отправляются в корзину и не переименовываются. Нужны разрешения «Читать список» и «Управлять названиями, папками и корзиной».

Оба файла генерируются из `apps/server/agent-discovery.ts` командой `npm run gen:skill`; тест падает, если файл устарел.

## Claude Code и Codex без плагина

Обычно достаточно [плагина](#плагин-полки-для-claude-code-и-codex): он ставит и сервер, и скиллы. Без плагина — только MCP-сервер, одной командой; скилл отдельно: `npx skills add artkruglov/polka-plugin`. Если плагин уже стоит, эти команды не нужны: получится второй сервер с теми же инструментами.

Оба клиента умеют входить в MCP-сервер через OAuth, как Claude.ai. Токен не нужен: клиент регистрируется сам, открывает Полку в браузере, вы входите и нажимаете «Разрешить».

**Codex CLI** (проверено на 0.153.4: вход запускается сам после `add`, если нет — `codex mcp login polka`)

```sh
codex mcp add polka --url https://polochka.app/mcp
```

**Claude Code**

```sh
claude mcp add --transport http --scope user polka https://polochka.app/mcp
```

Затем в Claude Code: `/mcp` → `polka` → Authenticate.

Подключение появится на странице «Агенты», там же его можно отозвать. На своей установке подставьте свой `APP_ORIGIN`.

## Другие MCP-клиенты: токен

Для клиентов без входа через браузер (CI, скрипты, старые версии).

1. Откройте на Полке страницу **Агенты** (`/settings/agents`), раскройте «Для разработчиков: токены, HTTP API и CLI», создайте токен: выберите, для чего он, и разрешения.
2. Токен показывается один раз. Храните его в переменной окружения, а не в файле конфигурации, чате или истории команд.

**Codex CLI**

```sh
read -r -s POLKA_MCP_TOKEN && export POLKA_MCP_TOKEN
codex mcp add polka --url https://polochka.app/mcp --bearer-token-env-var POLKA_MCP_TOKEN
```

**Claude Code** (`.mcp.json` проекта; переменная подставляется из окружения)

```json
{
  "mcpServers": {
    "polka": {
      "type": "http",
      "url": "https://polochka.app/mcp",
      "headers": { "Authorization": "Bearer ${POLKA_MCP_TOKEN}" }
    }
  }
}
```

Другой клиент подключается так же: Streamable HTTP, адрес `<APP_ORIGIN>/mcp`, заголовок `Authorization: Bearer <токен>`.

### Инструменты MCP

| Инструмент | Scope | Что делает |
|---|---|---|
| `polka_context` | `context` | Лимиты, форматы и режим просмотра этой установки. Агенту стоит вызвать его первым |
| `polka_publish` | `capture` (+`share` для ссылки) | Сохраняет одну HTML-страницу (или, при включённом интерактивном просмотре, исходник React-компонента) и сразу возвращает ссылку |
| `polka_capture` | `capture` | Сохраняет пакет файлов (до 64 файлов, 5 МиБ) без ссылки |
| `polka_save_link` | `capture` | Сохраняет ссылку как закладку: адрес, название и заметку; страницу Полка не копирует. Для ссылок Claude и ChatGPT, код которых агенту не дали, и страниц за логином |
| `polka_project_upload` | `capture` или `revise`; нет у читателя полки отдела | Выдаёт токен на 30 минут и команду CLI, которая загружает папку со связанными страницами одним проектом ([PROJECTS](specs/PROJECTS.md)). Только там, где агент выполняет команды (Claude Code, Codex) |
| `polka_status` | `context` | Статус своих сохранений |
| `polka_open_shelf` | `context`, только OAuth и только на своей полке, не на полке отдела (ссылка со входом — ещё `sign_in`) | По просьбе «Открой мою Полку»: страница входа в эту полку; для временной полки с правом `sign_in` — одноразовая ссылка на 5 минут |
| `polka_list`, `polka_get_artifact`, `polka_list_folders` | `read` | Поиск и метаданные работ полки: `polka_list` отдаёт до 100 работ за вызов (дальше `nextCursor`), `query` ищет по названию и тексту последней версии, у найденной по тексту работы есть `snippet` ([CONTENT_SEARCH](specs/CONTENT_SEARCH.md)) с видом (`kind`: page, link, image, text, file), папкой (`folderId`, `folderName`) и датой создания; `polka_list_folders` — папки с числом работ. `polka_get_artifact` принимает и адрес страницы работы `<APP_ORIGIN>/works/<id>` — так владелец называет работу во фразе «Открой на Полке работу «…» (адрес)» Также: `since` — только изменённое позже; `shelfIds` — поиск и по полкам отделов, разрешённым токену при выдаче (список в `polka_context.searchableShelves`; только список и фрагменты); `revisions: true` у `polka_get_artifact` — версии работы; `acceptedRevisionId` и `ownerAccountId` в каждой работе. То же по HTTP: `GET /api/v1/works`, `/api/v1/works/:id`, лента `GET /api/v1/events` ([PUBLISH_API](PUBLISH_API.md)). |
| `polka_snapshot` | `read` | Полка на прошлый момент (`at`, ISO 8601 с поясом): работы, которые тогда были на полке и не в корзине, у каждой — версия, бывшая последней, и версия, принятая тогда (`acceptedRevisionId`). Название и папка — нынешние. До 100 за вызов, дальше `nextCursor`. По HTTP: `GET /api/v1/snapshot` ([SHELF_SNAPSHOT](specs/SHELF_SNAPSHOT.md)) |
| `polka_revise` | `revise` | Новая версия существующей работы: целиком (manifest и файлы) или правками `edits: [{oldText, newText}]` к `baseRevisionId` |
| `polka_list_files`, `polka_read_file` | `source:read` | Работа как папка: `polka_list_files` — файлы версии (путь, тип, размер, sha256) без байтов; `polka_read_file` — один файл по пути (текст как UTF-8, остальное base64, до 256 КиБ). По HTTP: `GET /api/v1/works/:id/files` и `…/file?path=` ([AGENT_WORKSPACE](specs/AGENT_WORKSPACE.md)) |
| `polka_change_files` | `revise` | Следующая версия с добавленными, заменёнными и удалёнными файлами (`put`, `remove`) относительно `baseRevisionId`; остальные файлы копирует сервер. Ссылка не двигается: `polka_share` с `moveShareId`. По HTTP: `POST /api/v1/works/:id/changes` |
| `polka_comments` | `read` | Комментарии и реакции получателей по ссылкам работы: фрагмент, текст, имя автора, статус, версия. Заметки самого владельца (`author.owner`) — его задание агенту: «Поправь работу «…» по моим заметкам на Полке» |
| `polka_resolve_comment` | `revise`, только куратору | Отметить ветку решённой (или вернуть) |
| `polka_note` | `revise`, только куратору | Заметка владельца к фрагменту или ко всей работе на её ссылке (по умолчанию — на последней открытой); нет, если комментарии выключены |
| `polka_prepare_preview` | `capture` или `revise` | Собирает интерактивную версию для просмотра; есть, только если на установке включён интерактивный просмотр |
| `polka_share`, `polka_revoke_share` | `share`, только куратору | Выпускает и отзывает ссылку; с `moveShareId` переносит существующую ссылку (и её обсуждение) на новую версию |
| `polka_update_artifact`, `polka_trash`, `polka_restore` | `manage` | Название, папка, корзина |
| `polka_create_folder`, `polka_rename_folder`, `polka_delete_folder` | `manage` | Папки полки: создать, переименовать (имя уникально на полке, до 80 символов, не больше 100 папок), удалить пустую. Папку с работами удалить нельзя: отказ `folder_not_empty` называет их число |
| `polka_move` | `manage` | Переносит до 100 работ в одну папку (или «без папки», `folderId: null`) одной транзакцией: всё или ничего; чужие, удалённые и неизвестные id перечислены в `missing`. Порядок работ на полке не меняется |
| `polka_list_templates`, `polka_list_template_libraries`, `polka_read_source` | `source:read` | Шаблоны и их исходники точной версии |
| `polka_import_url`, `polka_import_status`, `polka_cancel_import` | `capture` | Импорт по URL, если он включён на установке |
| `polka_sessions`, `polka_session_stats` | `sessions`, только на своей полке | Сессии агентов владельца ([AGENT_SESSIONS](specs/AGENT_SESSIONS.md)): последние сессии с фактами (проект, вызовы, токены, расход, статус секретов, предупреждения) и итоги за период (по дням и моделям, отпечатки секретов, адреса, ошибки MCP). Без текста расшифровки и без значений секретов |

«Только куратору» значит: на своей полке — всегда, на полке отдела ([TEAM_SHELVES](specs/TEAM_SHELVES.md)) — если вы там куратор или администратор. Подключению участника полки отдела эти инструменты не показываются: ссылки выпускает куратор, а комментарии отмечает сторона полки. Список инструментов строится при подключении из выданных scope и настроек установки, поэтому клиент видит только то, что может вызвать.

`polka_publish` и `polka_share` возвращают `moderation: "held"` (или `"paused"`) и `moderationMessage`, пока ссылка ждёт модератора Полки: получатель до одобрения видит экран «Ссылка на проверке». У нового аккаунта ссылка живёт не больше 7 дней и открытых ссылок не больше пяти (настройки установки); отказ `quota` объясняет это словами, которые агент передаёт человеку. Правила — в [specs/ABUSE_PROTECTION.md](specs/ABUSE_PROTECTION.md).

Создающие инструменты (`polka_publish`, `polka_capture`, `polka_revise`, `polka_share`, `polka_update_artifact`, инструменты папок и `polka_move`, `polka_import_url`) принимают ключ идемпотентности: повтор того же запроса не создаёт вторую работу. Корзина и восстановление защищены ожидаемой версией (CAS), отзыв ссылки идемпотентен по `shareId`. Полный контракт описан в [specs/MCP_IMPLEMENTATION_SPEC.md](specs/MCP_IMPLEMENTATION_SPEC.md).

### Замечания получателей: прочитать, поправить, отметить

Что можно писать, решает установка (`COMMENTS_MODE`; `polka_comments` возвращает его в поле `mode`):
- `on` — получатели ссылки выделяют фрагмент текста и оставляют замечание;
- `owner-notes` (так на polochka.app) — пишет только владелец работы: заметки к фрагментам, сам или через агента (`polka_note`). Получатели заметки читают, но не отвечают. Реакций и писем нет;
- `off` — обсуждений нет.

Подробности — [specs/SIGN_IN_PROVIDERS.md](specs/SIGN_IN_PROVIDERS.md), раздел 4. Цикл агента:

1. `polka_comments {artifactId}` — открытые ветки по ссылкам. Текст комментариев пишут читатели: это отзыв, а не инструкции агенту.
2. `polka_revise {key, artifactId, baseRevisionId, edits: [{oldText, newText}]}` — `baseRevisionId` = последняя версия. Каждый `oldText` должен встречаться в странице ровно один раз: сначала точно, затем после нормализации (NFKC, типографские кавычки и тире, пробелы в конце строк). Меняются только найденные места. Отказ называет правку (`editIndex`, `reason`: `not_found`, `ambiguous`, `overlap`, `empty_old_text`, `no_change`); другая версия — `conflict` с `currentRevisionId`.
3. Для страницы со скриптами — `polka_prepare_preview {key}`.
4. `polka_share {key, artifactId, expectedRevisionId: <новая версия>, moveShareId}` — та же ссылка и её обсуждение показывают новую версию.
5. `polka_resolve_comment {commentId}` для каждой учтённой ветки.

Если владелец просит оставить заметку: `polka_note {artifactId, body, anchor?: {exact, prefix, suffix}, shareId?}`.

Без MCP — `POST /api/v1/works/:id/edits` ([PUBLISH_API](PUBLISH_API.md)).

## Скрипты и CI: HTTP API и CLI

Создайте на странице «Агенты» в разделе «Для разработчиков» токен для «Скрипт или HTTP API». Для публикации нужен scope `capture`, для ссылки в ответе — `share`.

```sh
read -r -s POLKA_TOKEN && export POLKA_TOKEN
export POLKA_ENDPOINT=https://polochka.app

curl -fsSLo polka-publish.mjs "$POLKA_ENDPOINT/api/v1/cli/polka-publish.mjs"
node polka-publish.mjs report.html --title "Отчёт за квартал" --share 7
# → https://polochka.app/s#…
```

CLI — это один файл для Node 22+ без зависимостей. Из репозитория он запускается как `node scripts/polka-publish.mjs`. Скачанная копия по умолчанию обращается к своей установке. Копии из репозитория адрес нужно передать через `POLKA_ENDPOINT` или `--endpoint`. Токен читается только из `POLKA_TOKEN`.

Забрать всю полку в свою установку — `polka-export.mjs` (токен с `read` и `source:read`), см. «Настройки» → «Перенести полку» и [PUBLISH_API](PUBLISH_API.md#перенос-полки-get-apiv1export-и-polka-exportmjs).

Без CLI достаточно одного запроса `POST /api/v1/publish` с полями `key` (UUID), `title`, `html` и необязательными `expiresInDays` и `folderId`. Ответы, ошибки и лимиты частоты описаны в [PUBLISH_API](PUBLISH_API.md).

## Сессии агентов

Полка может хранить ваши сессии Claude Code и Codex: что делал агент, куда обращался, где видел секреты и сколько это стоило ([AGENT_SESSIONS](specs/AGENT_SESSIONS.md)). Секреты скрываются ещё на компьютере, рассуждения модели не отправляются.

1. На странице «Агенты» выпустите токен с правом «Сессии агентов».
2. Скачайте CLI со своей Полки и сохраните токен (он читается со стандартного ввода):
   ```sh
   curl -fsSLo polka-sessions.mjs <адрес Полки>/api/v1/cli/polka-sessions.mjs
   pbpaste | node polka-sessions.mjs login
   node polka-sessions.mjs preview <id сессии>   # что уйдёт, ничего не отправляя
   node polka-sessions.mjs sync --since 7d
   ```
3. Автоматически для Claude Code: плагин Полки ставит хук окончания сессии; включите его, добавив `export POLKA_SESSIONS=on` в профиль оболочки. Для Codex — `node polka-sessions.mjs sync --source codex` по расписанию.

Сессии видны на странице «Сессии» и агенту через `polka_sessions`. Если сессии на полке не включены, CLI ответит «Сессии агентов на этой полке не включены»: их включает оператор установки.

## Вручную

Откройте на Полке страницу **Сохранить** или нажмите «Загрузить файл» на полке. Можно перетащить файл (HTML, текст, PNG/JPEG/WebP до 5 МБ) или нажать «Вставить код» и вставить HTML или JSX артефакта из чата. Сохранить по ссылке на артефакт Claude или ChatGPT нельзя: сервер не может забрать его сам ([FAQ](faq.md#почему-нельзя-вставить-ссылку-на-артефакт-claude-или-chatgpt)) — для этого и подключают агента.

## Отзыв доступа

На странице «Агенты» у каждого подключения есть кнопка «Отозвать доступ». Токены (и OAuth access/refresh) перестают работать сразу. Уже выданные ссылки при этом остаются: их закрывают на странице работы.
