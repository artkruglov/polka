# Приёмка: агент управляет работами без веба

Проверка из [#47](https://github.com/artkruglov/polka/issues/47). `tests/agent-management.test.ts` проверяет сервер, а эта приёмка — инструменты такими, какими их видит настоящий клиент: описания, форму аргументов, ошибки. Настоящий Claude Code или Codex с правами `context`, `read` и `manage` получает задачу обычными словами:

1. переименовать работу и перенести её в папку;
2. убрать её в корзину;
3. найти её в корзине;
4. вернуть из корзины;
5. показать название, папку и состояние.

В вебе ничего не делается. Затем скрипт проверяет на сервере результат и журнал.

## Как повторить

Нужна локальная Полка ([local-development](../en/local-development.md)) и вход в `claude` или `codex`.

```bash
npm run dev                     # в другом терминале
npx tsx --env-file=.env scripts/agent-manage-acceptance.ts --agent claude
npx tsx --env-file=.env scripts/agent-manage-acceptance.ts --agent codex --model gpt-5.6-luna
```

Скрипт работает только с `APP_ORIGIN` на `127.0.0.1` или `localhost`. Он создаёт одноразовый аккаунт `manage-accept-…` и две работы: нужную и «Не трогать». Ещё он создаёт папку «Принято» и выдаёт агенту токен на 30 минут. Работы сохраняются через отдельный токен с правом `capture`, у самого агента этого права нет. В конце токен отзывается, а скрипт печатает JSON:

- `checks`: работа переименована, лежит в папке и не в корзине; в журнале от этого токена есть `artifact.trashed`, а за ним `artifact.restored`; работа «Не трогать» не изменилась;
- `toolCalls`: инструменты Полки в порядке вызова;
- `toolErrors`: сколько вызовов вернули ошибку;
- `answer`: последний ответ агента;
- `cliErrors`: ошибки самого CLI, если агент не вызвал ни одного инструмента.

Код выхода — 0, если все проверки прошли.

`--model` передаёт модель в CLI. Без него берётся модель по умолчанию из настроек CLI. Codex со входом через ChatGPT отказывает некоторым моделям (`… is not supported when using Codex with a ChatGPT account`), это видно в `cliErrors`.

## Codex спрашивает перед корзиной

`polka_trash` и `polka_restore` помечены как разрушительные (`destructiveHint`), и Codex перед ними спрашивает человека. В `codex exec` спросить некого, и агент останавливается: «Polka запросил подтверждение, но оно недоступно в текущем режиме». Поэтому скрипт одобряет для Codex только эти два инструмента — как сделал бы человек в интерактивном CLI:

```bash
-c 'mcp_servers.polka.tools.polka_trash.approval_mode="approve"'
-c 'mcp_servers.polka.tools.polka_restore.approval_mode="approve"'
```

Шире он ничего не одобряет: без песочницы и без `--dangerously-bypass-approvals-and-sandbox`. Claude Code в `-p` получает `--allowedTools mcp__polka`.

## Записанный прогон — 09.10.2026

Локальная Полка, ветка `main` после 0.13.0.

| Агент | Итог | Время | Вызовы инструментов Полки | Журнал |
|---|---|---|---|---|
| Claude Code 2.1.296, модель по умолчанию | все проверки, 0 ошибок | 25 с | `list` → `list_folders` → `update_artifact` (название и папка одним вызовом) → `get_artifact` → `trash` → `list` (корзина) → `restore` → `get_artifact` | `metadata_updated`, `trashed`, `restored` |
| Codex CLI 0.153.4, `gpt-5.6-luna` | все проверки, 0 ошибок | 57 с | `context` → `list` → `list_folders` → `update_artifact` (название) → `get_artifact` → `move` (папка) → `get_artifact` → `trash` → `list` → `restore` → `get_artifact` | `metadata_updated`, `moved`, `trashed`, `restored` |

Без одобрения `polka_trash` Codex выполнил первый шаг и остановился на втором, как описано выше. Это поведение клиента, а не ошибка Полки. Для тех, кто запускает Codex без человека, оно описано в [connect-agents](../connect-agents.md#claude-code-и-codex-без-плагина).
