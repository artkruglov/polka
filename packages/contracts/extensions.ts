// The web app's side of extensions (docs/specs/EXTENSIONS.md), shared by the
// app and packages/extension-api.

/** Where an extension's web module may add a section. */
export type ExtensionSlot = "company-admin";

/**
 * What the web app offers an extension's module on window.__polkaHost: the
 * app's React (never a second copy), a few of its controls, its API client
 * (it sends the session and the open shelf), and a way to add sections.
 */
export type ExtensionHost = {
  React: unknown;
  ui: Record<string, unknown>;
  request: <T>(path: string, body?: unknown, method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") => Promise<T>;
  addSection: (slot: ExtensionSlot, section: { id: string; title: string; Component: unknown }) => void;
};
