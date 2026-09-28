// Tokens of Полка as hex (apps/web/src/shared/styles/tokens.css), for anything that animates.
export const C = {
  canvas: "#ffffff",
  soft: "#f5f7fa",
  soft2: "#eef1f6",
  soft3: "#fafbfe",
  ink: "#0f1420",
  ink2: "#28354a",
  muted: "#647087",
  line: "#e7ebf1",
  lineStrong: "#d9dfe9",
  accent: "#1f4fff",
  accentStrong: "#1740e0",
  accentSoft: "#edf2ff",
  accentInk: "#1a3fd1",
  success: "#1f6b35",
  successSoft: "#e3f3e6",
} as const;

export const FONT = '"Polka Sans", -apple-system, "Segoe UI", Roboto, sans-serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Agents as the product shows them (packages/contracts/link-providers.ts): two letters on the service's colour. */
export const AGENTS = {
  claude: { name: "Claude", mark: "Cl", color: "#c96442" },
  chatgpt: { name: "ChatGPT", mark: "GP", color: "#10a37f" },
  gemini: { name: "Gemini", mark: "Ge", color: "#4f6bed" },
  perplexity: { name: "Perplexity", mark: "Px", color: "#1f6f78" },
} as const;
export type AgentId = keyof typeof AGENTS;

/** The product's one easing, cubic-bezier(.2,.7,.2,1). */
export const EASE = [0.2, 0.7, 0.2, 1] as const;
