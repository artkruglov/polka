/**
 * GET /connect: instructions an AI agent reads when its user says
 * "Connect Полка: <origin>/connect". Plain text, so any agent can fetch it and
 * a person can read it in a browser. The agent runs one command; everything
 * else (account, consent) happens in the user's browser over OAuth, so no
 * token or password passes through the agent or the chat.
 */

/** The skill package `npx skills add …` installs (skills/polka/SKILL.md). */
export const SKILL_REPO = "artkruglov/polka";
export const SKILL_INSTALL = `npx skills add ${SKILL_REPO}`;

/**
 * The first task after connecting: the agent finds the person's best past
 * work and saves it. Terminal agents look at this machine; web chats search
 * their own history. The web app shows the same text
 * (apps/web/src/entities/onboarding/agent-setup.ts); a test keeps them equal.
 */
const HARVEST_REST =
  "Найди 3–5 самых интересных работ, которые мы делали: исследования, статьи, презентации, дашборды, прототипы. Пропусти личное (здоровье, финансы, переписка) и материалы работодателя или клиентов. Покажи мне список с одной строкой о каждой. После моего «да» сохрани каждую на Полку отдельной работой (polka_publish; HTML или React как есть), с понятным названием, и пришли ссылки.";
export const harvestPrompts = {
  terminal: `Посмотри наши прошлые сессии и файлы проекта на этом компьютере. ${HARVEST_REST}`,
  chat: `Поищи в наших прошлых чатах (поиск по истории/памяти). ${HARVEST_REST}`,
} as const;

export function connectGuide(origin: string, sourceUrl?: string) {
  const mcp = `${origin}/mcp`;
  const skills = `${origin}/.well-known/agent-skills`;
  return `# Подключить Полку

Полка хранит страницы, отчёты и прототипы, которые вы делаете с агентом, и даёт на них ссылку. MCP-сервер: ${mcp}. Вход через OAuth в браузере, токен не нужен.

## Агенту: выполни это сам

Пользователь попросил подключить Полку. Определи, какой ты клиент, выполни одну команду из списка и скажи пользователю, что сделать в браузере. Больше ничего не устанавливай и не спрашивай токен.

- Codex CLI: \`codex mcp add polka --url ${mcp}\` — вход в браузере откроется сам. Если не открылся: \`codex mcp login polka\`.
- Claude Code: \`claude mcp add --transport http --scope user polka ${mcp}\`, затем попроси пользователя ввести \`/mcp\`, выбрать \`polka\` и нажать Authenticate.
- Другой MCP-клиент с OAuth: добавь удалённый Streamable HTTP-сервер ${mcp} с авторизацией OAuth.
- Claude.ai или ChatGPT в браузере (терминала нет, эту страницу ты, скорее всего, не смог загрузить): команды не выполнить, коннектор добавляет сам пользователь. Перескажи ему шаги, ничего не запрашивай:
  - Claude.ai: Settings → Connectors → Add custom connector, URL ${mcp} → Add → Connect. Затем в чате «+» → Connectors → включить «Полка». Пошагово с кнопками копирования: ${origin}/settings/agents?client=claude-ai
  - ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode → Create, MCP Server URL ${mcp}, Authentication: OAuth. Затем в чате «+» → включить коннектор «Полка». Пошагово: ${origin}/settings/agents?client=chatgpt

Скажи пользователю: «Откроется Полка. Войдите в свою полку или нажмите «Начать без регистрации», затем «Разрешить».»

Когда Полка подключена, сохраняй работу инструментом \`polka_publish\`: он вернёт ссылку ${origin}/s#…, которую можно отправить кому угодно. Если полка временная (без регистрации), ссылки не будет: передай пользователю \`claimUrl\` — там полку закрепляют через Яндекс ID или почту.

Сразу после подключения один раз скажи пользователю: «Если понадобится открыть полку в браузере — скажите мне «Открой мою Полку»». На эту просьбу вызови \`polka_open_shelf\` и отдай ссылку как есть (страница входа в полку или, для временной полки, одноразовая ссылка), сам её не открывай.

## Скилл для Claude Code и Codex

Для Claude Code и Codex есть скилл Полки — агент будет знать, как сохранять, делиться и править: \`${SKILL_INSTALL}\` (или по адресу ${skills}).

## Первая сессия: соберите лучшие работы

Когда Полка подключена, предложи пользователю собрать его лучшие прошлые работы. В терминале (Claude Code, Codex) задание такое:

«${harvestPrompts.terminal}»

В чате (Claude.ai, ChatGPT): «${harvestPrompts.chat}»

Полный справочник для агентов (инструменты, HTTP API, лимиты): ${origin}/llms.txt.
${sourceUrl ? `\nИсходный код этой установки (AGPL-3.0): ${sourceUrl}\n` : ""}
---

# Connect Полка

Полка keeps the pages, reports and prototypes you make with an agent and gives you a link to them. MCP server: ${mcp}. Sign-in is OAuth in the browser; no token is needed.

## For the agent: do this yourself

Your user asked to connect Полка. Work out which client you are, run the one matching command and tell the user what to do in the browser. Install nothing else and do not ask for a token.

- Codex CLI: \`codex mcp add polka --url ${mcp}\`; the browser sign-in opens by itself. If it does not: \`codex mcp login polka\`.
- Claude Code: \`claude mcp add --transport http --scope user polka ${mcp}\`, then ask the user to type \`/mcp\`, choose \`polka\` and press Authenticate.
- Another MCP client with OAuth: add the remote Streamable HTTP server ${mcp} with OAuth authorization.
- Claude.ai or ChatGPT in the browser (no terminal; you most likely could not even fetch this page): you cannot run commands, the user adds the connector themselves. Tell them the steps, ask for nothing:
  - Claude.ai: Settings → Connectors → Add custom connector, URL ${mcp} → Add → Connect. Then in the chat "+" → Connectors → enable "Полка". Step by step with copy buttons: ${origin}/settings/agents?client=claude-ai
  - ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode → Create, MCP Server URL ${mcp}, Authentication: OAuth. Then in the chat "+" → enable the "Полка" connector. Step by step: ${origin}/settings/agents?client=chatgpt

Tell the user: "Полка will open. Sign in to your shelf or press «Начать без регистрации» (start without signing up), then Allow."

Once connected, save work with the \`polka_publish\` tool: it returns a link ${origin}/s#… you can send to anyone. On a provisional shelf (no sign-up yet) there is no link: give the user \`claimUrl\`, where they claim the shelf with Яндекс ID or email.

Right after connecting, tell the user once: «Если понадобится открыть полку в браузере — скажите мне «Открой мою Полку»» (if you need to open the shelf in a browser, tell me "Open my Polka"). When they ask, call \`polka_open_shelf\` and hand over the link exactly as returned; never open it yourself.

## Skill for Claude Code and Codex

The Полка skill teaches the agent how to save, share and revise: \`${SKILL_INSTALL}\` (or ${skills}).

## First session: collect the best past work

After connecting, offer the user to collect their best past work. In a terminal agent (Claude Code, Codex) the task is:

"${harvestPrompts.terminal}"

In a web chat (Claude.ai, ChatGPT): "${harvestPrompts.chat}"

Full agent reference (tools, HTTP API, limits): ${origin}/llms.txt.
${sourceUrl ? `\nSource code of this installation (AGPL-3.0): ${sourceUrl}\n` : ""}`;
}
