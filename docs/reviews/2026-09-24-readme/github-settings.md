# Настройки репозитория artkruglov/polka

Подготовлено 24.09.2026 для мейнтейнера; сами настройки не менялись. Команды — для `gh` с правами администратора репозитория.

## Описание (About)

У GitHub одно поле описания, до 350 символов. Основной вариант — русский с английским хвостом, чтобы репозиторий находился и по-английски (236 символов):

> Полка — сохраняйте отчёты, страницы и прототипы из Claude, ChatGPT, Claude Code и Codex и делитесь ими по ссылке. / A shelf for AI-made HTML artifacts: your agent saves work over MCP, recipients open it by link. AGPL-3.0, self-hostable.

Только по-русски (169 символов):

> Полка — сохраняйте отчёты, страницы и прототипы из Claude, ChatGPT, Claude Code и Codex и делитесь ими по ссылке. MCP-коннектор, точные версии, своя установка. AGPL-3.0.

Только по-английски (177 символов):

> Полка (Polka): a shelf for reports, pages and prototypes made with Claude, ChatGPT, Claude Code or Codex. Your agent saves over MCP, recipients open a link. AGPL-3.0, self-host.

## Сайт

https://polochka.app

## Темы (topics), 15

`ai-agents`, `mcp`, `mcp-server`, `claude`, `chatgpt`, `codex`, `llm`, `html`, `artifacts`, `sharing`, `self-hosted`, `typescript`, `fastify`, `react`, `russian`

## Команды

```bash
gh repo edit artkruglov/polka \
  --description "Полка — сохраняйте отчёты, страницы и прототипы из Claude, ChatGPT, Claude Code и Codex и делитесь ими по ссылке. / A shelf for AI-made HTML artifacts: your agent saves work over MCP, recipients open it by link. AGPL-3.0, self-hostable." \
  --homepage "https://polochka.app"

gh repo edit artkruglov/polka \
  --add-topic ai-agents,mcp,mcp-server,claude,chatgpt,codex,llm,html,artifacts,sharing,self-hosted,typescript,fastify,react,russian

# SECURITY.md и CODE_OF_CONDUCT.md отправляют к приватным отчётам:
# убедитесь, что они включены (повторный вызов ничего не ломает).
gh api -X PUT repos/artkruglov/polka/private-vulnerability-reporting

# Проверка
gh repo view artkruglov/polka --json description,homepageUrl,repositoryTopics
gh api repos/artkruglov/polka/private-vulnerability-reporting
```

По желанию: `--enable-wiki=false` (документация живёт в `docs/`), `--enable-discussions` — только если кто-то будет отвечать там; сейчас вопросы идут через [SUPPORT.md](../../../SUPPORT.md).

## Картинка для соцсетей (social preview)

Файл: [`docs/assets/social-preview.png`](../../assets/social-preview.png), 1280×640, 118 КБ (исходник — `social-preview.svg`, перерисовка — `node scripts/render-readme-assets.mjs social`).

Ни `gh`, ни REST API загрузить её не умеют. Вручную: **Settings → General → Social preview → Edit → Upload an image…**, выбрать файл. Проверка: ссылка на репозиторий в Telegram или Slack показывает эту карточку (кэш мессенджеров может держать старую до суток).
