/**
 * GET /connect: instructions an AI agent reads when its user says
 * "Connect Полка: <origin>/connect". Plain text, so any agent can fetch it and
 * a person can read it in a browser. The agent runs one command; everything
 * else (account, consent) happens in the user's browser over OAuth, so no
 * token or password passes through the agent or the chat.
 */
export function connectGuide(origin: string) {
  const mcp = `${origin}/mcp`;
  return `# Подключить Полку

Полка хранит страницы, отчёты и прототипы, которые вы делаете с агентом, и даёт на них ссылку. MCP-сервер: ${mcp}. Вход через OAuth в браузере, токен не нужен.

## Агенту: выполни это сам

Пользователь попросил подключить Полку. Определи, какой ты клиент, выполни одну команду из списка и скажи пользователю, что сделать в браузере. Больше ничего не устанавливай и не спрашивай токен.

- Codex CLI: \`codex mcp add polka --url ${mcp}\` — вход в браузере откроется сам. Если не открылся: \`codex mcp login polka\`.
- Claude Code: \`claude mcp add --transport http --scope user polka ${mcp}\`, затем попроси пользователя ввести \`/mcp\`, выбрать \`polka\` и нажать Authenticate.
- Другой MCP-клиент с OAuth: добавь удалённый Streamable HTTP-сервер ${mcp} с авторизацией OAuth.
- Claude.ai или ChatGPT (терминала нет): попроси пользователя добавить коннектор ${mcp}. Claude.ai: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps & Connectors → Developer mode → Create, Authentication: OAuth.

Скажи пользователю: «Откроется Полка. Войдите или создайте полку по почте — придёт код из восьми цифр — и нажмите «Разрешить».»

Когда Полка подключена, сохраняй работу инструментом \`polka_publish\`: он вернёт ссылку ${origin}/s#…, которую можно отправить кому угодно.

---

# Connect Полка

Полка keeps the pages, reports and prototypes you make with an agent and gives you a link to them. MCP server: ${mcp}. Sign-in is OAuth in the browser; no token is needed.

## For the agent: do this yourself

Your user asked to connect Полка. Work out which client you are, run the one matching command and tell the user what to do in the browser. Install nothing else and do not ask for a token.

- Codex CLI: \`codex mcp add polka --url ${mcp}\`; the browser sign-in opens by itself. If it does not: \`codex mcp login polka\`.
- Claude Code: \`claude mcp add --transport http --scope user polka ${mcp}\`, then ask the user to type \`/mcp\`, choose \`polka\` and press Authenticate.
- Another MCP client with OAuth: add the remote Streamable HTTP server ${mcp} with OAuth authorization.
- Claude.ai or ChatGPT (no terminal): ask the user to add the connector ${mcp}. Claude.ai: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps & Connectors → Developer mode → Create, Authentication: OAuth.

Tell the user: "Полка will open. Sign in or create a shelf with your email (you get an eight-digit code) and press Allow."

Once connected, save work with the \`polka_publish\` tool: it returns a link ${origin}/s#… you can send to anyone.
`;
}
