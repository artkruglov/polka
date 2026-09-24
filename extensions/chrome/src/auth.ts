/*
 * OAuth 2.1 with Полка's own authorization server (apps/server/oauth.ts):
 * discovery, dynamic client registration as a public client, authorization
 * code with PKCE (S256) through chrome.identity.launchWebAuthFlow, rotating
 * refresh tokens, revocation on disconnect.
 *
 * Storage (per Полка origin):
 *   chrome.storage.local   client:<origin>  the registered client_id
 *                          grant:<origin>   the refresh token and scopes
 *   chrome.storage.session access:<origin>  the access token (1 hour), kept in
 *                          memory only and gone when the browser closes
 * Both areas are readable by the extension's own pages and service worker;
 * session storage is restricted to them (TRUSTED_CONTEXTS), and web pages never
 * see either.
 */
import { sameOrigin } from "./shared/origin.ts";

export const SCOPES = "context capture share";
const CLIENT_NAME = "На Полку";

type Metadata = {
  authorize: string;
  token: string;
  register: string;
  revoke: string | null;
  resource: string;
};
type Grant = { refreshToken: string; scope: string; clientId: string };
type Access = { accessToken: string; expiresAt: number };

export class AuthError extends Error {
  constructor(
    public code: "not_connected" | "cancelled" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = (size = 32) => base64url(crypto.getRandomValues(new Uint8Array(size)));

export async function pkcePair() {
  const verifier = random(32);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function json(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function discover(origin: string): Promise<Metadata> {
  const [server, resource] = await Promise.all([
    fetch(`${origin}/.well-known/oauth-authorization-server`).then(json),
    fetch(`${origin}/.well-known/oauth-protected-resource`).then(json),
  ]);
  const authorize = sameOrigin(server.authorization_endpoint, origin);
  const token = sameOrigin(server.token_endpoint, origin);
  const register = sameOrigin(server.registration_endpoint, origin);
  const audience = sameOrigin(resource.resource, origin);
  if (!authorize || !token || !register || !audience)
    throw new AuthError(
      "failed",
      `По адресу ${origin} не отвечает Полка с входом для приложений.`,
    );
  return {
    authorize,
    token,
    register,
    revoke: sameOrigin(server.revocation_endpoint, origin),
    resource: audience,
  };
}

const redirectUri = () => chrome.identity.getRedirectURL("polka");

async function clientId(origin: string, meta: Metadata, fresh = false) {
  const key = `client:${origin}`;
  const stored = (await chrome.storage.local.get(key))[key] as
    | { clientId: string; redirectUri: string }
    | undefined;
  if (!fresh && stored && stored.redirectUri === redirectUri())
    return stored.clientId;
  const response = await fetch(meta.register, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await json(response);
  if (response.status !== 201 || typeof body.client_id !== "string")
    throw new AuthError("failed", "Полка не зарегистрировала расширение. Повторите позже.");
  await chrome.storage.local.set({
    [key]: { clientId: body.client_id, redirectUri: redirectUri() },
  });
  return body.client_id;
}

async function tokenRequest(meta: Metadata, params: Record<string, string>) {
  const response = await fetch(meta.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await json(response);
  if (!response.ok || typeof body.access_token !== "string")
    return { ok: false as const, error: String(body.error ?? response.status) };
  return {
    ok: true as const,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
    scope: typeof body.scope === "string" ? body.scope : SCOPES,
  };
}

async function store(
  origin: string,
  clientId: string,
  issued: { accessToken: string; refreshToken: string | null; expiresIn: number; scope: string },
  previousRefresh?: string,
) {
  const refreshToken = issued.refreshToken ?? previousRefresh;
  if (refreshToken)
    await chrome.storage.local.set({
      [`grant:${origin}`]: { refreshToken, scope: issued.scope, clientId } satisfies Grant,
    });
  await chrome.storage.session.set({
    [`access:${origin}`]: {
      accessToken: issued.accessToken,
      // A minute early, so a request never leaves with a token about to lapse.
      expiresAt: Date.now() + (issued.expiresIn - 60) * 1000,
    } satisfies Access,
  });
}

/** Sign-in window on Полка → consent → token. Needs the user at the screen. */
export async function connect(origin: string): Promise<void> {
  const meta = await discover(origin);
  let id = await clientId(origin, meta);
  const { verifier, challenge } = await pkcePair();
  const state = random(16);
  const url = new URL(meta.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: SCOPES,
    resource: meta.resource,
  }).toString();
  let answer: string | undefined;
  try {
    answer = await chrome.identity.launchWebAuthFlow({
      url: url.href,
      interactive: true,
    });
  } catch (error) {
    // Closing the window is the usual cause; an unknown client (the server's
    // database was reset) also ends here, so the next attempt registers anew.
    await chrome.storage.local.remove(`client:${origin}`);
    throw new AuthError("cancelled", "Подключение не завершено: окно входа закрыто.");
  }
  const returned = new URL(answer ?? "");
  if (returned.searchParams.get("state") !== state)
    throw new AuthError("failed", "Ответ Полки не совпал с запросом. Повторите подключение.");
  const iss = returned.searchParams.get("iss");
  if (iss !== null && iss !== origin)
    throw new AuthError("failed", "Ответ пришёл не от вашей Полки.");
  if (returned.searchParams.get("error") === "access_denied")
    throw new AuthError("cancelled", "Доступ не разрешён.");
  const code = returned.searchParams.get("code");
  if (!code) throw new AuthError("failed", "Полка не выдала доступ. Повторите подключение.");
  const issued = await tokenRequest(meta, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    client_id: id,
    resource: meta.resource,
  });
  if (!issued.ok) throw new AuthError("failed", "Полка не выдала токен. Повторите подключение.");
  await store(origin, id, issued);
}

const refreshing = new Map<string, Promise<string | null>>();

/**
 * A valid access token, refreshing it when needed; null when not connected.
 * Refreshes are single-flight: Полка rotates refresh tokens and treats reuse
 * of a rotated one as theft, so two concurrent refreshes must not happen.
 */
export async function accessToken(origin: string, force = false): Promise<string | null> {
  if (!force) {
    const key = `access:${origin}`;
    const access = (await chrome.storage.session.get(key))[key] as Access | undefined;
    if (access && access.expiresAt > Date.now()) return access.accessToken;
  }
  const pending = refreshing.get(origin);
  if (pending) return pending;
  const run = (async () => {
    const key = `grant:${origin}`;
    const grant = (await chrome.storage.local.get(key))[key] as Grant | undefined;
    if (!grant) return null;
    const meta = await discover(origin);
    const issued = await tokenRequest(meta, {
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: grant.clientId,
      resource: meta.resource,
    });
    if (!issued.ok) {
      // invalid_grant: revoked on the agents page, expired or rotated away.
      if (issued.error === "invalid_grant" || issued.error === "invalid_client")
        await forget(origin);
      return null;
    }
    await store(origin, grant.clientId, issued, grant.refreshToken);
    return issued.accessToken;
  })().finally(() => refreshing.delete(origin));
  refreshing.set(origin, run);
  return run;
}

export async function isConnected(origin: string) {
  const key = `grant:${origin}`;
  return !!(await chrome.storage.local.get(key))[key];
}

async function forget(origin: string) {
  await chrome.storage.local.remove(`grant:${origin}`);
  await chrome.storage.session.remove(`access:${origin}`);
}

/** Revokes the grant on Полка (best effort) and forgets it here. */
export async function disconnect(origin: string) {
  const key = `grant:${origin}`;
  const grant = (await chrome.storage.local.get(key))[key] as Grant | undefined;
  await forget(origin);
  if (!grant) return;
  try {
    const meta = await discover(origin);
    if (meta.revoke)
      await fetch(meta.revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: grant.refreshToken,
          token_type_hint: "refresh_token",
          client_id: grant.clientId,
        }).toString(),
      });
  } catch {
    /* offline: the grant stays listed on the agents page until revoked there */
  }
}
