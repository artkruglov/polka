# Real CLI attempts — acceptance remains open

Codex CLI0.153.4 / gpt-5.6-luna called native polka_context successfully.
When asked to call capture with the supplied four-file JSON, it produced six
file entries including three index.html entries and altered encoded bytes.
The server rejected it before reservation; status by key correctly found no
operation. The harness stopped the process at180seconds and revoked its token.
No capture receipt was produced. This is a workflow failure, not a passed test.

Claude Code2.1.278 / sonnet stopped with provider API429 account limit before
model execution. The test token was revoked and temporary secret config removed.
Do not treat the SDK client suite as a replacement for this outstanding client.

Next: real CLI invokes a local helper which sends immutable request bytes using
the official MCP client; the model handles paths/key and short receipts only.
Preserve the same request file for retries, including capturedAt. Explicitly
provide the scoped token to that child environment; never mine client configs.
Label this path separately from model-authored native capture JSON.

Raw logs remain local because they contain full payloads and local client metadata.
The sanitized results contain only run identifiers and outcome.

Setup sources: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude MCP](https://code.claude.com/docs/en/mcp). Installed CLI help was also checked.

## Принятый локальный путь Codex через helper

Реальный Codex CLI с Luna выполнил native `polka_context`, запустил `scripts/capture-via-mcp.ts` с путём к подготовленному immutable request, затем получил `saved` через native `polka_status`. Exit0; receipt совпадает. Независимый owner HTTP export подтвердил точные bytes всех4 файлов (2880Б). Модель не читала и не переписывала файловый payload. Токен передавался helper через явно делегированное окружение; тестовое подключение отозвано harness после выполнения; независимый owner endpoint вернул status `revoked`.

Это приёмка **CLI → локальный helper → MCP**, а не доказательство надёжной ручной сериализации bytes моделью. Ограничение предыдущей попытки остаётся. В этом прогоне capture не собирает preview автоматически (`htmlProfile: unsupported` описывает исходный bundle); отдельная MCP-подготовка производного пока разрабатывается. Claude по-прежнему не принят из-за лимита аккаунта.

## Полная локальная цепочка Codex → recipient

На обновлённом сервере с default transport response mode реальный Codex/Luna выполнил context → helper capture → native status → native prepare-preview ready → native share. Browser recipient по выданной ссылке запустил отчёт с локальными CSS/SVG. Клавиатурный Enter переключил период:12/8 →9/11. Координатный click инструмента проверки был отклонён из-за fractional iframe input coordinates; это ограничение текущего browser tool, не доказательство неработающего JS. Внешний вид проверен скриншотом, полной визуальной/мобильной приёмки этот прогон не заменяет.

Owner export после preview совпал побайтово со всеми4 исходниками. Owner revoke вернул200; кнопка recipient «Обновить доступ» показала «Работа по этой ссылке недоступна». Временная вкладка закрыта. Тестовое connection отзывается harness по завершении CLI; revoke connection сам по себе не отменяет ранее выданный share. URL/capability не включены в опубликованный протокол.

Один реальный клиентский локальный путь принят. Второй клиент, hosted isolation, импорт URL и новая onboarding UI приёмка остаются открытыми.
