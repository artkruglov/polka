# Подключить агента

Полка принимает работы из четырёх мест: чат-приложений (коннектор), CLI-агентов (MCP по токену), скриптов (HTTP API) и из рук самого пользователя (файл или вставка кода). На каждом пути действуют одни и те же лимиты и правила показа.

В примерах используется адрес `https://polochka.app`. На своей установке подставьте свой `APP_ORIGIN`.

## Claude.ai и ChatGPT: коннектор

Полка подключается как удалённый MCP-сервер `https://polochka.app/mcp` со входом через OAuth 2.1. Client ID вводить не нужно: приложение регистрируется само (Dynamic Client Registration).

**Claude.ai (Pro/Max).** Settings → Connectors → **Add custom connector**. Name: `Полка`, URL: `https://polochka.app/mcp`. Нажмите **Connect**, войдите в Полку и разрешите доступ. После этого включите коннектор в чате и попросите: «Сохрани этот артефакт на Полку и дай ссылку».

**Claude Team / Enterprise.** Владелец организации добавляет коннектор в Admin settings → Connectors. Каждый участник подключает его сам и входит в **свою** Полку. Общего токена нет.

**ChatGPT.** Settings → Apps & Connectors → Advanced settings → **Developer mode**. Затем **Create**: Name `Полка`, MCP Server URL `https://polochka.app/mcp`, Authentication **OAuth**. В чате выберите коннектор в меню «+».

Модель вызывает `polka_publish` и возвращает ссылку `https://polochka.app/s#…`. Если на установке включён интерактивный просмотр, Полка сама собирает интерактивную версию. Если сборка не удалась, работа всё равно сохраняется, а модель получает причину.

По умолчанию разрешены `context`, `capture`, `read` и `share`. Без `share` работа сохраняется приватно, и ссылки в ответе нет. Как устроены протокол, согласие и отзыв, описано в [MCP_CONNECTOR](MCP_CONNECTOR.md).

## Claude Code, Codex и другие MCP-клиенты: токен

1. Откройте на Полке страницу **Агенты** (`/settings/agents`), создайте подключение, выберите клиента и разрешения.
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
| `polka_status` | `context` | Статус своих сохранений |
| `polka_list`, `polka_get_artifact`, `polka_list_folders` | `read` | Поиск и метаданные работ полки |
| `polka_revise` | `revise` | Новая версия существующей работы |
| `polka_prepare_preview` | `capture` или `revise` | Собирает интерактивную версию для просмотра |
| `polka_share`, `polka_revoke_share` | `share` | Выпускает и отзывает ссылку |
| `polka_update_artifact`, `polka_trash`, `polka_restore` | `manage` | Название, папка, корзина |
| `polka_list_templates`, `polka_list_template_libraries`, `polka_read_source` | `source:read` | Шаблоны и их исходники точной версии |
| `polka_import_url`, `polka_import_status`, `polka_cancel_import` | `capture` | Импорт по URL, если он включён на установке |

Все изменяющие инструменты принимают ключ идемпотентности: повтор того же запроса не создаёт вторую работу. Полный контракт описан в [specs/MCP_IMPLEMENTATION_SPEC.md](specs/MCP_IMPLEMENTATION_SPEC.md).

## Скрипты и CI: HTTP API и CLI

Создайте на странице «Агенты» подключение с клиентом «HTTP API / скрипт». Для публикации нужен scope `capture`, для ссылки в ответе — `share`.

```sh
read -r -s POLKA_TOKEN && export POLKA_TOKEN
export POLKA_ENDPOINT=https://polochka.app

curl -fsSLo polka-publish.mjs "$POLKA_ENDPOINT/api/v1/cli/polka-publish.mjs"
node polka-publish.mjs report.html --title "Отчёт за квартал" --share 7
# → https://polochka.app/s#…
```

CLI — это один файл для Node 22+ без зависимостей. Из репозитория он запускается как `node scripts/polka-publish.mjs`. Скачанная копия по умолчанию обращается к своей установке. Копии из репозитория адрес нужно передать через `POLKA_ENDPOINT` или `--endpoint`. Токен читается только из `POLKA_TOKEN`.

Без CLI достаточно одного запроса `POST /api/v1/publish` с полями `key` (UUID), `title`, `html` и необязательными `expiresInDays` и `folderId`. Ответы, ошибки и лимиты частоты описаны в [PUBLISH_API](PUBLISH_API.md).

## Вручную

Откройте на Полке страницу **Сохранить**. Можно перетащить файл (HTML, текст, PNG/JPEG/WebP до 5 МБ) или нажать «Вставить код» и вставить HTML или JSX артефакта из чата. Если вставить ссылку на артефакт Claude или ChatGPT, Полка объяснит, почему не может забрать его сама, и предложит скачать файл ([FAQ](faq.md#почему-нельзя-вставить-ссылку-на-артефакт-claude-или-chatgpt)).

## Отзыв доступа

На странице «Агенты» у каждого подключения есть кнопка «Отозвать доступ». Токены (и OAuth access/refresh) перестают работать сразу. Уже выданные ссылки при этом остаются: их закрывают на странице работы.
