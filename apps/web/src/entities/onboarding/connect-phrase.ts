/**
 * The one phrase a person says to their agent, and the four commands the
 * agent would run. The commands are the same ones GET /connect serves
 * (apps/server/connect-guide.ts); a test keeps them in step.
 */
export const connectPhrase = (origin: string, ref?: string) =>
  `Подключи Полку: ${origin}/connect${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

/**
 * An installation on this computer (127.0.0.1, localhost): claude.ai and
 * ChatGPT connect from their own servers and cannot reach it, so only the
 * paths that run here are offered — Claude Code, Codex, a token.
 */
export function isLoopbackOrigin(origin: string) {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Web chats connect from the provider's servers: only to a public address. */
const WEB_CHATS = new Set(["claude-ai", "chatgpt"]);
export const reachableFrom = (origin: string) => (id: string) =>
  !isLoopbackOrigin(origin) || !WEB_CHATS.has(id);

export type ClientHint = {
  id: "codex" | "claude-code" | "claude-ai" | "chatgpt";
  client: string;
  /** A shell command when there is one; otherwise the path through the app's settings. */
  command: string | null;
  note: string;
};

export function clientHints(origin: string): ClientHint[] {
  const mcp = `${origin}/mcp`;
  return ([
    {
      id: "codex",
      client: "Codex",
      command:
        "codex plugin marketplace add artkruglov/polka-plugin && codex plugin add polka@polka",
      note: "Плагин ставит подключение и скилл. Затем войдите: codex mcp login polka.",
    },
    {
      id: "claude-code",
      client: "Claude Code",
      command:
        "claude plugin marketplace add artkruglov/polka-plugin && claude plugin install polka@polka",
      note: "Плагин ставит подключение и скилл. Затем в Claude Code: /mcp → plugin:polka:polka → Authenticate.",
    },
    {
      id: "claude-ai",
      client: "Claude.ai и Claude Desktop",
      command: null,
      note: `Settings → Connectors → Add custom connector, адрес ${mcp}.`,
    },
    {
      id: "chatgpt",
      client: "ChatGPT",
      command: null,
      note: `Settings → Apps & Connectors → Developer mode → Create, адрес ${mcp}, Authentication: OAuth.`,
    },
  ] satisfies ClientHint[]).filter((hint) => reachableFrom(origin)(hint.id));
}
