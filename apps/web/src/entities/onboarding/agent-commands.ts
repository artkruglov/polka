/**
 * The terminal commands that connect an agent to this installation. The
 * plugin and the skills in artkruglov/polka-plugin belong to polochka.app (the
 * plugin's .mcp.json names PLUGIN_MCP_URL): anywhere else they would connect
 * people to the public cloud, so the agent adds this origin's MCP server
 * directly and takes the skills this server serves (/.well-known/agent-skills,
 * which `npx skills add <origin>` reads). GET /connect builds the same
 * (apps/server/connect-guide.ts); a test keeps them equal.
 */

/** The skill package of the plugin repository. */
export const SKILL_INSTALL = "npx skills add artkruglov/polka-plugin";
/**
 * The repository is also a plugin marketplace for Claude Code
 * (.claude-plugin/) and Codex (.codex-plugin/, .agents/plugins/): one
 * install brings the MCP server and every skill under skills/.
 */
export const CLAUDE_PLUGIN_INSTALL =
  "claude plugin marketplace add artkruglov/polka-plugin && claude plugin install polka@polka";
export const CODEX_PLUGIN_INSTALL =
  "codex plugin marketplace add artkruglov/polka-plugin && codex plugin add polka@polka";
/** The one server the plugin connects to. */
export const PLUGIN_MCP_URL = "https://polochka.app/mcp";

export type AgentCommands = {
  /** The plugin serves this installation (polochka.app). */
  plugin: boolean;
  claude: string;
  codex: string;
  skills: string;
  /** The server's name in Claude Code's /mcp list. */
  claudeServer: string;
};

export function agentCommands(origin: string): AgentCommands {
  const mcp = `${origin}/mcp`;
  const plugin = mcp === PLUGIN_MCP_URL;
  return {
    plugin,
    claude: plugin ? CLAUDE_PLUGIN_INSTALL : `claude mcp add --transport http --scope user polka ${mcp}`,
    codex: plugin ? CODEX_PLUGIN_INSTALL : `codex mcp add polka --url ${mcp}`,
    skills: plugin ? SKILL_INSTALL : `npx skills add ${origin}`,
    claudeServer: plugin ? "plugin:polka:polka" : "polka",
  };
}
