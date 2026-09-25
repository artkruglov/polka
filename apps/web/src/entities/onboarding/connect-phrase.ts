/**
 * The one phrase a person says to their agent, and the four commands the
 * agent would run. The commands are the same ones GET /connect serves
 * (apps/server/connect-guide.ts); a test keeps them in step.
 */
export const connectPhrase = (origin: string, ref?: string) =>
  `Подключи Полку: ${origin}/connect${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

export type ClientHint = {
  id: "codex" | "claude-code" | "claude-ai" | "chatgpt";
  client: string;
  /** A shell command when there is one; otherwise the path through the app's settings. */
  command: string | null;
  note: string;
};

export function clientHints(origin: string): ClientHint[] {
  const mcp = `${origin}/mcp`;
  return [
    {
      id: "codex",
      client: "Codex",
      command:
        "codex plugin marketplace add artkruglov/polka && codex plugin add polka@polka",
      note: "Плагин ставит подключение и скилл. Затем войдите: codex mcp login polka.",
    },
    {
      id: "claude-code",
      client: "Claude Code",
      command:
        "claude plugin marketplace add artkruglov/polka && claude plugin install polka@polka",
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
  ];
}
