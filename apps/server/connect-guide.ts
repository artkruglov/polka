/**
 * GET /connect: instructions an AI agent reads when its user says
 * "Connect Полка: <origin>/connect". Plain text, so any agent can fetch it; a
 * browser gets connectPage() below. The agent runs one command; everything
 * else (account, consent) happens in the user's browser over OAuth, so no
 * token or password passes through the agent or the chat.
 */

import { escapeHtml } from "../../packages/contracts/html.ts";

/** The skill package `npx skills add …` installs (skills/polka/SKILL.md). */
export const SKILL_REPO = "artkruglov/polka-plugin";
export const SKILL_INSTALL = `npx skills add ${SKILL_REPO}`;
/**
 * The same repository is a plugin marketplace for Claude Code and Codex: one
 * install adds the MCP server and every skill under skills/. The web app
 * shows the same commands (apps/web/src/entities/onboarding/agent-setup.ts).
 */
export const CLAUDE_PLUGIN_INSTALL = `claude plugin marketplace add ${SKILL_REPO} && claude plugin install polka@polka`;
export const CODEX_PLUGIN_INSTALL = `codex plugin marketplace add ${SKILL_REPO} && codex plugin add polka@polka`;
/** The one server the plugin connects to: its .mcp.json names this address. */
export const PLUGIN_MCP_URL = "https://polochka.app/mcp";

/**
 * The commands for this installation. The plugin and the skills in
 * artkruglov/polka-plugin belong to polochka.app: anywhere else they would
 * connect people to the public cloud, so an agent adds this origin's MCP
 * server directly and takes the skills this server serves
 * (/.well-known/agent-skills, which `npx skills add <origin>` reads). The web
 * app builds the same (apps/web/src/entities/onboarding/agent-commands.ts);
 * a test keeps them equal.
 */
export function agentCommands(origin: string) {
  const mcp = `${origin}/mcp`;
  const plugin = mcp === PLUGIN_MCP_URL;
  return {
    plugin,
    claude: plugin ? CLAUDE_PLUGIN_INSTALL : `claude mcp add --transport http --scope user polka ${mcp}`,
    codex: plugin ? CODEX_PLUGIN_INSTALL : `codex mcp add polka --url ${mcp}`,
    skills: plugin ? SKILL_INSTALL : `npx skills add ${origin}`,
    /** The server's name in Claude Code's /mcp list. */
    claudeServer: plugin ? "plugin:polka:polka" : "polka",
  };
}

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
  const commands = agentCommands(origin);
  const terminalRu = commands.plugin
    ? `- Codex: \`${CODEX_PLUGIN_INSTALL}\` (плагин: MCP-сервер и скиллы Полки), затем \`codex mcp login polka\` — вход откроется в браузере. Без плагина: \`codex mcp add polka --url ${mcp}\`.
- Claude Code: \`${CLAUDE_PLUGIN_INSTALL}\` (плагин: MCP-сервер и скиллы Полки), затем попроси пользователя ввести \`/reload-plugins\` (или перезапустить Claude Code), потом \`/mcp\`, выбрать \`plugin:polka:polka\` и нажать Authenticate. Без плагина: \`claude mcp add --transport http --scope user polka ${mcp}\`.
- Если плагин не ставится (ошибка git вроде \`invalid index-pack output\`, нет доступа к GitHub, песочница или фильтр разрешений его не пускает), не останавливайся и не проси пользователя чинить git: сразу выполни команду «Без плагина» для своего клиента. Ей не нужен GitHub, она подключает тот же сервер; скиллы необязательны. В Claude Code пользователь затем вводит \`/mcp\`, выбирает \`polka\` и нажимает Authenticate.`
    : `- Codex: \`${commands.codex}\` — вход откроется в браузере (если нет, \`codex mcp login polka\`).
- Claude Code: \`${commands.claude}\`, затем попроси пользователя ввести \`/mcp\`, выбрать \`polka\` и нажать Authenticate.
- Не ставь плагин Полки (\`polka@polka\` из ${SKILL_REPO}) и скиллы из этого репозитория: они подключают публичное облако Полки, а не эту установку.`;
  const terminalEn = commands.plugin
    ? `- Codex: \`${CODEX_PLUGIN_INSTALL}\` (the plugin: MCP server and Полка skills), then \`codex mcp login polka\`; the sign-in opens in the browser. Without the plugin: \`codex mcp add polka --url ${mcp}\`.
- Claude Code: \`${CLAUDE_PLUGIN_INSTALL}\` (the plugin: MCP server and Полка skills), then ask the user to type \`/reload-plugins\` (or restart Claude Code), then \`/mcp\`, choose \`plugin:polka:polka\` and press Authenticate. Without the plugin: \`claude mcp add --transport http --scope user polka ${mcp}\`.
- If the plugin does not install (a git clone error such as \`invalid index-pack output\`, no network to GitHub, a sandbox or permission filter that refuses it), do not stop and do not ask the user to fix git: run the "Without the plugin" command for your client right away. It needs nothing from GitHub and connects the same server; the skills are optional. In Claude Code the user then types \`/mcp\`, chooses \`polka\` and presses Authenticate.`
    : `- Codex: \`${commands.codex}\`; the sign-in opens in the browser (if not, \`codex mcp login polka\`).
- Claude Code: \`${commands.claude}\`, then ask the user to type \`/mcp\`, choose \`polka\` and press Authenticate.
- Do not install the Полка plugin (\`polka@polka\` from ${SKILL_REPO}) or the skills from that repository: they connect the public Полка cloud, not this installation.`;
  const skillRu = commands.plugin
    ? `Скиллы Полки — агент будет знать, как сохранять, делиться и править. Плагин для Claude Code и Codex (команды выше) ставит их сам; для других агентов: \`${SKILL_INSTALL}\` (или по адресу ${skills}).`
    : `Скиллы Полки — агент будет знать, как сохранять, делиться и править. Их отдаёт эта установка, ставятся отдельно и по желанию: \`${commands.skills}\` (или по адресу ${skills}).`;
  const skillEn = commands.plugin
    ? `The Полка skills teach the agent how to save, share and revise. The Claude Code and Codex plugin (commands above) installs them; for other agents: \`${SKILL_INSTALL}\` (or ${skills}).`
    : `The Полка skills teach the agent how to save, share and revise. This installation serves them; install them separately if you like: \`${commands.skills}\` (or ${skills}).`;
  return `# Подключить Полку

Полка хранит страницы, отчёты и прототипы, которые вы делаете с агентом, и даёт на них ссылку. MCP-сервер: ${mcp}. Вход через OAuth в браузере, токен не нужен.

## Агенту: выполни это сам

Пользователь попросил подключить Полку. Определи, какой ты клиент, выполни одну команду из списка и скажи пользователю, что сделать в браузере. Больше ничего не устанавливай и не спрашивай токен.

${terminalRu}
- Другой MCP-клиент с OAuth: добавь удалённый Streamable HTTP-сервер ${mcp} с авторизацией OAuth.
- Claude.ai или ChatGPT в браузере (терминала нет, эту страницу ты, скорее всего, не смог загрузить): команды не выполнить, коннектор добавляет сам пользователь. Перескажи ему шаги, ничего не запрашивай:
  - Claude.ai и Claude Desktop: Settings → Connectors → Add custom connector, URL ${mcp} → Add → Connect. Затем в чате «+» → Connectors → включить «Полка». Пошагово с кнопками копирования: ${origin}/settings/agents?client=claude-ai
  - ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode → Create, MCP Server URL ${mcp}, Authentication: OAuth. Затем в чате «+» → включить коннектор «Полка». Пошагово: ${origin}/settings/agents?client=chatgpt

Скажи пользователю: «Откроется Полка. Войдите в свою полку или нажмите «Начать без регистрации», затем «Разрешить».»

Когда Полка подключена, сохраняй работу инструментом \`polka_publish\`: он вернёт ссылку ${origin}/s#…, которую можно отправить кому угодно. Если полка временная (без регистрации), ссылки не будет: передай пользователю \`claimUrl\` — там полку закрепляют через Яндекс ID или почту.

Сразу после подключения один раз скажи пользователю: «Если понадобится открыть полку в браузере — скажите мне «Открой мою Полку»». На эту просьбу вызови \`polka_open_shelf\` и отдай ссылку как есть (страница входа в полку или, для временной полки, одноразовая ссылка), сам её не открывай.

## Скилл для Claude Code и Codex

${skillRu}

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

${terminalEn}
- Another MCP client with OAuth: add the remote Streamable HTTP server ${mcp} with OAuth authorization.
- Claude.ai or ChatGPT in the browser (no terminal; you most likely could not even fetch this page): you cannot run commands, the user adds the connector themselves. Tell them the steps, ask for nothing:
  - Claude.ai and Claude Desktop: Settings → Connectors → Add custom connector, URL ${mcp} → Add → Connect. Then in the chat "+" → Connectors → enable "Полка". Step by step with copy buttons: ${origin}/settings/agents?client=claude-ai
  - ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode → Create, MCP Server URL ${mcp}, Authentication: OAuth. Then in the chat "+" → enable the "Полка" connector. Step by step: ${origin}/settings/agents?client=chatgpt

Tell the user: "Полка will open. Sign in to your shelf or press «Начать без регистрации» (start without signing up), then Allow."

Once connected, save work with the \`polka_publish\` tool: it returns a link ${origin}/s#… you can send to anyone. On a provisional shelf (no sign-up yet) there is no link: give the user \`claimUrl\`, where they claim the shelf with Яндекс ID or email.

Right after connecting, tell the user once: «Если понадобится открыть полку в браузере — скажите мне «Открой мою Полку»» (if you need to open the shelf in a browser, tell me "Open my Polka"). When they ask, call \`polka_open_shelf\` and hand over the link exactly as returned; never open it yourself.

## Skill for Claude Code and Codex

${skillEn}

## First session: collect the best past work

After connecting, offer the user to collect their best past work. In a terminal agent (Claude Code, Codex) the task is:

"${harvestPrompts.terminal}"

In a web chat (Claude.ai, ChatGPT): "${harvestPrompts.chat}"

Full agent reference (tools, HTTP API, limits): ${origin}/llms.txt.
${sourceUrl ? `\nSource code of this installation (AGPL-3.0): ${sourceUrl}\n` : ""}`;
}

/**
 * A browser asked (a person tapped the link in a chat or a post): the same
 * guide, but under a short human explanation and the phrase to copy. Agents
 * that fetch with a browser-like Accept still find every instruction in the
 * <pre>. Agents that prefer text or markdown get the plain guide (wantsHtml).
 */
export function wantsHtml(accept: string | undefined) {
  if (!accept) return false;
  const types = accept
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { type: type!.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
    });
  const quality = (type: string) => Math.max(0, ...types.filter((t) => t.type === type).map((t) => t.q));
  const html = Math.max(quality("text/html"), quality("application/xhtml+xml"));
  return (
    html > 0 &&
    html >= quality("text/markdown") &&
    html >= quality("text/plain") &&
    types[0]!.type !== "text/markdown" &&
    types[0]!.type !== "text/plain"
  );
}

export function connectPage(origin: string, sourceUrl?: string) {
  const phrase = `Подключи Полку: ${origin}/connect`;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Подключить Полку к агенту</title>
<meta name="description" content="Скопируйте фразу и отправьте её агенту: Claude Code, Codex, Claude или ChatGPT.">
<style>
:root{--bg:#fff;--soft:#f5f7ff;--text:#111827;--muted:#5b6475;--accent:#1f4fff;--line:#e4e7ee}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--soft:#171a21;--text:#eef0f5;--muted:#a3a9b6;--accent:#7d9bff;--line:#2a2f3a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
.logo{font-weight:800;font-size:22px;color:var(--text);text-decoration:none}
h1{font-size:30px;line-height:1.2;margin:28px 0 12px}p{margin:0 0 14px}.muted{color:var(--muted)}
.phrase{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--soft);border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin:18px 0}
.phrase code{flex:1 1 260px;font:600 16px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:12px;padding:10px 16px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
ol{padding-left:22px}li{margin:6px 0}.row{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}
details{margin-top:28px;border-top:1px solid var(--line);padding-top:16px}summary{cursor:pointer;color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border-radius:12px;padding:14px;overflow-x:auto}
a{color:var(--accent)}
</style>
</head>
<body>
<main>
<a class="logo" href="${e(origin)}/">полка</a>
<h1>Подключите Полку к своему агенту</h1>
<p class="muted">Эта ссылка — инструкция для агента. Скопируйте фразу и отправьте её в Claude Code, Codex, Claude или ChatGPT: агент всё настроит сам.</p>
<div class="phrase"><code id="phrase">${e(phrase)}</code><button type="button" id="copy">Скопировать</button></div>
<ol>
<li>Агент выполнит одну команду, и откроется Полка.</li>
<li>Войдите через Яндекс ID или по почте — или нажмите «Начать без регистрации».</li>
<li>Нажмите «Разрешить». Дальше просто скажите агенту «сохрани на Полку» — он пришлёт ссылку.</li>
</ol>
<p class="muted">Claude.ai и ChatGPT в браузере не выполняют команды — коннектор добавляете вы, это пара минут: <a href="${e(origin)}/settings/agents?client=claude-ai">для Claude</a> · <a href="${e(origin)}/settings/agents?client=chatgpt">для ChatGPT</a>.</p>
<div class="row"><a class="btn" href="${e(origin)}/signup">Начать</a><a class="btn ghost" href="${e(origin)}/">Что такое Полка</a></div>
<details><summary>Текст для агента</summary><pre>${e(connectGuide(origin, sourceUrl))}</pre></details>
</main>
<script>
document.getElementById("copy").addEventListener("click", function () {
  var button = this;
  navigator.clipboard.writeText(document.getElementById("phrase").textContent).then(function () {
    button.textContent = "Скопировано";
    setTimeout(function () { button.textContent = "Скопировать"; }, 2000);
  });
});
</script>
</body>
</html>
`;
}
