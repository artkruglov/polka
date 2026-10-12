// Extensions of the open core (docs/specs/EXTENSIONS.md): modules named in
// POLKA_EXTENSIONS, loaded once at start. Each hook is a no-op without them,
// so an installation without extensions behaves exactly as the core alone.
import { createHmac } from "node:crypto";
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
  RedactResult,
  SessionDelete,
  SessionDeleteDecision,
  ExtensionSignInMethod,
  SignInAttempt,
  SignInDecision,
} from "../../packages/extension-api/index.ts";
import { createRedactor } from "../../scripts/polka-sessions.mjs";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
import { log } from "./log.ts";

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
      specifier.startsWith(".") || isAbsolute(specifier) ? pathToFileURL(resolve(specifier)).href : specifier;
    const module = await import(target);
    const extension = (module.default ?? module) as PolkaExtension;
    if (!extension || typeof extension !== "object" || !NAME.test(extension.name ?? ""))
      throw new Error(`POLKA_EXTENSIONS: ${specifier} does not export a Полка extension`);
    const own = `/api/ext/${extension.name}/`;
    const bad = (path: unknown, wildcard: boolean) =>
      typeof path !== "string" ||
      !path.startsWith(own) ||
      !(wildcard ? /^[\w/.-]+(\/\*)?$/ : /^[\w/.-]+$/).test(path) ||
      path.includes("..");
    for (const path of extension.machinePaths ?? [])
      if (bad(path, true))
        throw new Error(`POLKA_EXTENSIONS: ${extension.name}'s machine path ${String(path)} is not under ${own}`);
    for (const path of extension.signInPaths ?? [])
      if (bad(path, false))
        throw new Error(`POLKA_EXTENSIONS: ${extension.name}'s sign-in path ${String(path)} is not under ${own}`);
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

/**
 * An extension's machine route (machinePaths): bearer only, so the browser
 * Origin rule does not apply. Only paths under the extension's own prefix count.
 */
export const isExtensionMachinePath = (pathname: string) =>
  loaded.some((extension) =>
    extension.machinePaths?.some(
      (path) =>
        path.startsWith(`/api/ext/${extension.name}/`) &&
        (path.endsWith("/*") ? pathname.startsWith(path.slice(0, -1)) && !pathname.includes("..") : path === pathname),
    ),
  );

/**
 * An extension's sign-in route an identity provider's page posts the browser
 * to (signInPaths): no Origin rule, no cookie identity.
 */
export const isExtensionSignInPath = (pathname: string) =>
  loaded.some((extension) =>
    extension.signInPaths?.some((path) => path === pathname && path.startsWith(`/api/ext/${extension.name}/`)),
  );

/**
 * The first refusal wins: an extension may keep the core's own sign-in from
 * opening a session (e.g. the address's company signs in through its SSO).
 */
export async function checkSignIn(
  input: Omit<SignInAttempt, "accountEmail" | "email"> & { email: string | null },
  c: Pick<PoolClient, "query">,
) {
  if (!loaded.some((extension) => extension.policies?.signIn)) return;
  // The account's own address: a provider or a code may prove another one.
  const accountEmail = input.accountId
    ? (((await c.query("SELECT email FROM accounts WHERE id=$1", [input.accountId])).rows[0]?.email as
        string | null | undefined) ?? null)
    : null;
  const attempt: SignInAttempt = { ...input, email: input.email?.toLowerCase() ?? null, accountEmail };
  for (const extension of loaded) {
    const decision: SignInDecision | undefined = await extension.policies?.signIn?.(attempt, c);
    if (decision && !decision.allow)
      throw new Problem(403, "forbidden", decision.message, { reason: "sign_in_policy", extension: extension.name });
  }
}

const METHOD_ID = /^[a-z0-9-]{1,40}$/;

/** The extensions' sign-in buttons; a failing or malformed one shows nothing. */
export async function extensionSignInMethods() {
  const out: Array<ExtensionSignInMethod & { extension: string }> = [];
  for (const extension of loaded) {
    if (!extension.signInMethods) continue;
    try {
      for (const method of await extension.signInMethods()) {
        if (
          !method ||
          !METHOD_ID.test(method.id) ||
          typeof method.name !== "string" ||
          !method.name.trim() ||
          typeof method.start !== "string" ||
          !method.start.startsWith(`/api/ext/${extension.name}/`) ||
          !/^[\w/.?=&%-]+$/.test(method.start) ||
          method.start.includes("..")
        )
          continue;
        out.push({
          extension: extension.name,
          id: method.id,
          name: method.name.trim().slice(0, 60),
          start: method.start,
        });
      }
    } catch (error) {
      log.error({
        event: "extension.sign_in_methods_failed",
        extension: extension.name,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }
  return out.slice(0, 20);
}

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

/** The first refusal wins: any extension may keep a session from deletion. */
export async function checkSessionDelete(input: SessionDelete, c: PoolClient) {
  for (const extension of loaded) {
    const decision: SessionDeleteDecision | undefined = await extension.policies?.sessionDelete?.(input, c);
    if (decision && !decision.allow)
      throw new Problem(403, "forbidden", decision.message, { reason: "session_policy", extension: extension.name });
  }
}

/** Fire and forget, after the commit: an extension's failure never fails the core. */
export function emitEvent(event: PolkaEvent) {
  for (const extension of loaded) {
    if (!extension.onEvent) continue;
    Promise.resolve()
      .then(() => extension.onEvent!(event))
      .catch((error) =>
        log.error({
          event: "extension.event_failed",
          extension: extension.name,
          type: event.type,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      );
  }
}

/**
 * The installation's key for secret fingerprints (hex), derived from LINK_KEY
 * one way: what GET /api/v1/sessions/key hands the machines under
 * AGENT_SESSION_FINGERPRINTS=installation.
 */
export const installationFingerprintKey = () =>
  createHmac("sha256", config.LINK_KEY).update("polka/session-fingerprints/v1").digest("hex");

/**
 * context.redact: the CLI's own redactor (scripts/polka-sessions.mjs) keyed as
 * the CLI keys it, so a secret gets the marker and fingerprint an uploaded
 * session gives it under AGENT_SESSION_FINGERPRINTS=installation.
 */
export function redactForExtension(text: string): RedactResult {
  if (typeof text !== "string") throw new TypeError("context.redact takes a string");
  const redactor = createRedactor(Buffer.from(installationFingerprintKey(), "hex"));
  const out = redactor.redact(text);
  return { text: out, secrets: redactor.findings().map((f) => ({ type: f.type, fingerprint: f.fp })) };
}
