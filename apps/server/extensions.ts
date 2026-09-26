// Extensions of the open core (docs/specs/EXTENSIONS.md): modules named in
// POLKA_EXTENSIONS, loaded once at start. Each hook is a no-op without them,
// so an installation without extensions behaves exactly as the core alone.
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { PoolClient } from "pg";
import type {
  LinkIssue,
  LinkIssueDecision,
  LinkOpen,
  LinkOpenDecision,
  PolkaEvent,
  PolkaExtension,
} from "../../packages/extension-api/index.ts";
import { Problem } from "./errors.ts";

let loaded: PolkaExtension[] = [];
let configured = false;
/** Loaded already (at start, or by a test through useExtensions). */
export const extensionsConfigured = () => configured;

const NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** Loads the extensions a comma-separated list names (package names or paths). */
export async function loadExtensions(list: string | undefined) {
  const specifiers = (list ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const extensions: PolkaExtension[] = [];
  for (const specifier of specifiers) {
    const target =
      specifier.startsWith(".") || isAbsolute(specifier)
        ? pathToFileURL(resolve(specifier)).href
        : specifier;
    const module = await import(target);
    const extension = (module.default ?? module) as PolkaExtension;
    if (!extension || typeof extension !== "object" || !NAME.test(extension.name ?? ""))
      throw new Error(`POLKA_EXTENSIONS: ${specifier} does not export a Полка extension`);
    if (extensions.some((other) => other.name === extension.name))
      throw new Error(`POLKA_EXTENSIONS: ${extension.name} is loaded twice`);
    extensions.push(extension);
  }
  loaded = extensions;
  configured = true;
  return extensions;
}

/** For tests: use these extensions instead of POLKA_EXTENSIONS. */
export function useExtensions(extensions: PolkaExtension[]) {
  loaded = extensions;
  configured = true;
}

export const extensions = () => loaded;

/** The first refusal wins: any extension may forbid a link. */
export async function checkLinkIssue(issue: LinkIssue, c: PoolClient) {
  for (const extension of loaded) {
    const decision: LinkIssueDecision | undefined = await extension.policies?.linkIssue?.(issue, c);
    if (decision && !decision.allow)
      throw new Problem(403, "forbidden", decision.message, { reason: "link_policy", extension: extension.name });
  }
}

export async function checkLinkOpen(open: LinkOpen, c: PoolClient) {
  for (const extension of loaded) {
    const decision: LinkOpenDecision | undefined = await extension.policies?.linkOpen?.(open, c);
    if (decision && !decision.allow) {
      if (decision.signIn)
        throw new Problem(401, "unauthorized", decision.message, {
          reason: "sign_in_required",
          extension: extension.name,
        });
      throw new Problem(403, "forbidden", decision.message, { reason: "link_policy", extension: extension.name });
    }
  }
}

/** Fire and forget, after the commit: an extension's failure never fails the core. */
export function emitEvent(event: PolkaEvent) {
  for (const extension of loaded) {
    if (!extension.onEvent) continue;
    Promise.resolve()
      .then(() => extension.onEvent!(event))
      .catch((error) =>
        console.error(
          JSON.stringify({
            event: "extension.event_failed",
            extension: extension.name,
            type: event.type,
            error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
          }),
        ),
      );
  }
}
