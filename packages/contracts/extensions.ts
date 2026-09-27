// The web app's side of extensions (docs/specs/EXTENSIONS.md), shared by the
// app and packages/extension-api.

/** Where an extension's web module may add a section. */
export type ExtensionSlot = "company-admin" | "agent-connection" | "share-dialog";

/** What a section in the agent-connection place receives: one connection. */
export type AgentConnectionSlotProps = {
  connection: { id: string; name: string; kind: "token" | "oauth"; shelf?: { id: string; name: string } };
};

/**
 * What a section in the share-dialog place receives: the work in the
 * «Поделиться» window, the department shelf it is on (null: one's own) and
 * its link, if it has one. E.g. the rules links from this shelf follow.
 */
export type ShareDialogSlotProps = {
  artifact: { id: string; title: string; revisionId: string; revisionNumber: number };
  shelf: string | null;
  link: { status: "active" | "behind" | "expired" | "revoked"; expiresAt: string } | null;
};

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
