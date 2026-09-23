// External identity providers: Полка as an OAuth 2.0 / OpenID Connect
// CLIENT (docs/specs/SIGN_IN_PROVIDERS.md § 1). Unrelated to oauth.ts, which
// makes Полка an authorization SERVER for agents.
//
// The flow state (state, PKCE verifier, nonce, where to return, the account
// to link) travels in one sealed cookie, never in the database or a URL.
// Provider tokens live only inside the request that exchanged them; nothing
// here logs a URL, a code, a token or a provider's error text.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { config } from "./config.ts";

export type ProviderId = "yandex" | "vk" | "oidc";
export const PROVIDER_IDS = ["yandex", "vk", "oidc"] as const;

/** What a provider told us about the person, after every check passed. */
export type ProviderProfile = {
  provider: ProviderId;
  subject: string;
  /** Lower-cased; null when the provider reported none. */
  email: string | null;
  /** The provider vouches for the address (and the installation trusts it). */
  emailVerified: boolean;
  name: string | null;
};

/** A refusal shown on the sign-in page by its code only. */
export class IdpError extends Error {
  constructor(
    readonly code:
      | "state"
      | "denied"
      | "provider"
      | "blocked"
      | "signup"
      | "domain"
      | "linked"
      | "unavailable",
  ) {
    super(code);
  }
}

// Endpoints. Fixed for Яндекс ID and VK ID; tests point them at a local
// mock (plain http is accepted for loopback hosts only).
export const providerEndpoints = {
  yandex: {
    authorize: "https://oauth.yandex.ru/authorize",
    token: "https://oauth.yandex.ru/token",
    userInfo: "https://login.yandex.ru/info?format=json",
  },
  vk: {
    authorize: "https://id.vk.ru/authorize",
    token: "https://id.vk.ru/oauth2/auth",
    userInfo: "https://id.vk.ru/oauth2/user_info",
  },
};

export const PROVIDER_NAMES: Record<ProviderId, () => string> = {
  yandex: () => "Яндекс ID",
  vk: () => "VK ID",
  oidc: () => config.OIDC_NAME,
};

export function providerEnabled(provider: string): provider is ProviderId {
  return (config.SIGN_IN_PROVIDERS as string[]).includes(provider);
}

/** Exactly what is registered with the provider; never taken from a request. */
export const redirectUri = (provider: ProviderId) =>
  `${config.APP_ORIGIN}/api/auth/idp/${provider}/callback`;

// ---------------------------------------------------------------------------
// The sealed flow cookie

export const FLOW_COOKIE = "polka_idp";
export const FLOW_COOKIE_PATH = "/api/auth/idp";
export const FLOW_TTL_SECONDS = 600;

export type Flow = {
  provider: ProviderId;
  state: string;
  verifier: string;
  nonce: string;
  next: string;
  /** Link to this signed-in account instead of signing in. */
  link: string | null;
  expires: number;
};

const flowKey = () =>
  createHmac("sha256", config.LINK_KEY).update("polka:idp-flow:v1").digest();

export function sealFlow(flow: Flow) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", flowKey(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(flow), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

export function openFlow(value: string | undefined, now = Date.now()) {
  if (!value || value.length > 4096) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      flowKey(),
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const flow = JSON.parse(
      Buffer.concat([
        decipher.update(raw.subarray(12, raw.length - 16)),
        decipher.final(),
      ]).toString("utf8"),
    ) as Flow;
    if (typeof flow.expires !== "number" || flow.expires < now) return null;
    return flow;
  } catch {
    return null;
  }
}

/** Constant-time comparison of the state the provider returned. */
export function sameState(expected: string, actual: unknown) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected),
    b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Same rule as the interface's safeNext: a path of this installation. */
export function safeReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20]/.test(value)
  )
    return null;
  try {
    const base = "https://polka.invalid";
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return null;
    const path = parsed.pathname + parsed.search + parsed.hash;
    return path.startsWith("//") ? null : path;
  } catch {
    return null;
  }
}

const random = () => randomBytes(32).toString("base64url");
const challenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

// ---------------------------------------------------------------------------
// HTTP to providers

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_RESPONSE = 256 * 1024;

function providerUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    return url;
  throw new IdpError("provider");
}

async function fetchJson(
  value: string,
  init: RequestInit = {},
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(providerUrl(value), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof IdpError) throw error;
    throw new IdpError("provider");
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE) throw new IdpError("provider");
  const text = await response.text().catch(() => "");
  if (text.length > MAX_RESPONSE || !response.ok)
    throw new IdpError("provider");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new IdpError("provider");
    return body;
  } catch {
    throw new IdpError("provider");
  }
}

const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,253}\.[^@\s]{2,63}$/;
const cleanEmail = (value: unknown) => {
  const email = text(value, 254)?.toLowerCase() ?? null;
  return email && EMAIL.test(email) ? email : null;
};

const subjectOf = (value: unknown) => {
  const subject =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : text(value, 255);
  if (!subject) throw new IdpError("provider");
  return subject;
};

// ---------------------------------------------------------------------------
// OpenID Connect: discovery, JWKS and id_token

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};
let discoveryCache: { url: string; at: number; value: Discovery } | null = null;
let jwksCache: {
  url: string;
  at: number;
  keys: Array<Record<string, any>>;
} | null = null;
const CACHE_MS = 60 * 60 * 1000;

/** Tests switch installations; production reads config once per hour. */
export function resetOidcCache() {
  discoveryCache = null;
  jwksCache = null;
}

async function discovery(): Promise<Discovery> {
  const url = config.OIDC_DISCOVERY_URL!;
  if (discoveryCache?.url === url && Date.now() - discoveryCache.at < CACHE_MS)
    return discoveryCache.value;
  const body = await fetchJson(url);
  const value = body as Discovery;
  for (const key of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const)
    if (typeof value[key] !== "string") throw new IdpError("provider");
  // OIDC Discovery § 4.3: the document is at <issuer>/.well-known/…
  if (
    `${value.issuer.replace(/\/$/, "")}/.well-known/openid-configuration` !==
    url
  )
    throw new IdpError("provider");
  for (const endpoint of [
    value.authorization_endpoint,
    value.token_endpoint,
    value.jwks_uri,
  ])
    providerUrl(endpoint);
  discoveryCache = { url, at: Date.now(), value };
  return value;
}

async function jwks(url: string, refresh: boolean) {
  if (
    !refresh &&
    jwksCache?.url === url &&
    Date.now() - jwksCache.at < CACHE_MS
  )
    return jwksCache.keys;
  const body = await fetchJson(url);
  if (!Array.isArray(body.keys)) throw new IdpError("provider");
  jwksCache = { url, at: Date.now(), keys: body.keys };
  return jwksCache.keys;
}

const ALGORITHMS: Record<string, { hash: string; options: object }> = {
  RS256: { hash: "sha256", options: {} },
  PS256: {
    hash: "sha256",
    options: { padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 },
  },
  ES256: { hash: "sha256", options: { dsaEncoding: "ieee-p1363" } },
};

const decodePart = (part: string) => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new IdpError("provider");
  }
};

/** OIDC Core § 3.1.3.7: signature, issuer, audience, time, nonce. */
export async function verifyIdToken(
  token: unknown,
  expected: {
    issuer: string;
    audience: string;
    nonce: string;
    jwksUri: string;
  },
  now = Date.now(),
) {
  if (typeof token !== "string" || token.length > 16384)
    throw new IdpError("provider");
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdpError("provider");
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const algorithm = ALGORITHMS[header?.alg];
  if (!algorithm) throw new IdpError("provider");
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  const check = async (refresh: boolean) => {
    const keys = (await jwks(expected.jwksUri, refresh)).filter(
      (key: any) =>
        (!header.kid || key.kid === header.kid) &&
        (!key.use || key.use === "sig") &&
        (!key.alg || key.alg === header.alg),
    );
    for (const jwk of keys)
      try {
        const key = createPublicKey({ key: jwk as any, format: "jwk" });
        if (
          verifySignature(
            algorithm.hash,
            signed,
            { key, ...algorithm.options },
            signature,
          )
        )
          return true;
      } catch {
        // A key of another type: try the next one.
      }
    return false;
  };
  // An unknown key id may mean the provider rotated keys: fetch once more.
  if (!(await check(false)) && !(await check(true)))
    throw new IdpError("provider");
  const skew = 120;
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== expected.issuer ||
    !audiences.includes(expected.audience) ||
    (audiences.length > 1 && claims.azp !== expected.audience) ||
    typeof claims.exp !== "number" ||
    claims.exp + skew < seconds ||
    (typeof claims.iat === "number" && claims.iat - skew > seconds) ||
    typeof claims.nonce !== "string" ||
    !sameState(expected.nonce, claims.nonce)
  )
    throw new IdpError("state");
  return claims as Record<string, any>;
}

function orgClaimMatches(claims: Record<string, any>) {
  if (!config.OIDC_ORG_CLAIM) return true;
  const value = claims[config.OIDC_ORG_CLAIM];
  return Array.isArray(value)
    ? value.includes(config.OIDC_ORG_VALUE)
    : value === config.OIDC_ORG_VALUE;
}

// ---------------------------------------------------------------------------
// Start: the provider's authorization URL and the sealed flow

export async function startFlow(
  provider: ProviderId,
  next: string,
  link: string | null,
) {
  const flow: Flow = {
    provider,
    state: random(),
    verifier: random(),
    nonce: random(),
    next,
    link,
    expires: Date.now() + FLOW_TTL_SECONDS * 1000,
  };
  const params: Record<string, string> = {
    response_type: "code",
    redirect_uri: redirectUri(provider),
    state: flow.state,
    code_challenge: challenge(flow.verifier),
    code_challenge_method: "S256",
  };
  let authorize: string;
  if (provider === "yandex") {
    authorize = providerEndpoints.yandex.authorize;
    params.client_id = config.YANDEX_CLIENT_ID!;
    params.scope = "login:email login:info";
  } else if (provider === "vk") {
    authorize = providerEndpoints.vk.authorize;
    params.client_id = config.VK_CLIENT_ID!;
    params.scope = "email";
  } else {
    const document = await discovery();
    authorize = document.authorization_endpoint;
    params.client_id = config.OIDC_CLIENT_ID!;
    params.scope = config.OIDC_SCOPES;
    params.nonce = flow.nonce;
  }
  const url = providerUrl(authorize);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return { location: url.href, cookie: sealFlow(flow) };
}

// ---------------------------------------------------------------------------
// Callback: code → token → profile

export async function finishFlow(
  flow: Flow,
  query: Record<string, unknown>,
): Promise<ProviderProfile> {
  if (!sameState(flow.state, query.state)) throw new IdpError("state");
  if (typeof query.error === "string") throw new IdpError("denied");
  const code = text(query.code, 2048);
  if (!code) throw new IdpError("denied");
  if (flow.provider === "yandex") return yandexProfile(code, flow);
  if (flow.provider === "vk") return vkProfile(code, flow, query.device_id);
  return oidcProfile(code, flow);
}

async function yandexProfile(
  code: string,
  flow: Flow,
): Promise<ProviderProfile> {
  const token = await fetchJson(providerEndpoints.yandex.token, {
    ...form({
      grant_type: "authorization_code",
      code,
      code_verifier: flow.verifier,
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basic(
        config.YANDEX_CLIENT_ID!,
        config.YANDEX_CLIENT_SECRET!,
      ),
    },
  });
  const accessToken = text(token.access_token, 4096);
  if (!accessToken) throw new IdpError("provider");
  const info = await fetchJson(providerEndpoints.yandex.userInfo, {
    headers: { authorization: `OAuth ${accessToken}` },
  });
  const email = cleanEmail(info.default_email);
  return {
    provider: "yandex",
    subject: subjectOf(info.id),
    email,
    emailVerified: !!email && config.YANDEX_EMAIL_VERIFIED,
    name: text(info.real_name, 80) ?? text(info.display_name, 80),
  };
}

async function vkProfile(
  code: string,
  flow: Flow,
  deviceId: unknown,
): Promise<ProviderProfile> {
  const device = text(deviceId, 512);
  if (!device) throw new IdpError("provider");
  const token = await fetchJson(
    providerEndpoints.vk.token,
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: flow.verifier,
      client_id: config.VK_CLIENT_ID!,
      device_id: device,
      redirect_uri: redirectUri("vk"),
      state: flow.state,
    }),
  );
  if (token.state !== undefined && !sameState(flow.state, token.state))
    throw new IdpError("state");
  const accessToken = text(token.access_token, 4096);
  if (!accessToken) throw new IdpError("provider");
  const info = await fetchJson(
    providerEndpoints.vk.userInfo,
    form({ client_id: config.VK_CLIENT_ID!, access_token: accessToken }),
  );
  const user = info.user;
  if (!user || typeof user !== "object") throw new IdpError("provider");
  const email = cleanEmail(user.email);
  const name = [text(user.first_name, 40), text(user.last_name, 40)]
    .filter(Boolean)
    .join(" ");
  return {
    provider: "vk",
    subject: subjectOf(user.user_id ?? token.user_id),
    email,
    emailVerified: !!email && config.VK_EMAIL_VERIFIED,
    name: name || null,
  };
}

async function oidcProfile(code: string, flow: Flow): Promise<ProviderProfile> {
  const document = await discovery();
  const token = await fetchJson(document.token_endpoint, {
    ...form({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri("oidc"),
      code_verifier: flow.verifier,
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basic(config.OIDC_CLIENT_ID!, config.OIDC_CLIENT_SECRET!),
    },
  });
  const claims = await verifyIdToken(token.id_token, {
    issuer: document.issuer,
    audience: config.OIDC_CLIENT_ID!,
    nonce: flow.nonce,
    jwksUri: document.jwks_uri,
  });
  const email = cleanEmail(claims.email);
  const emailVerified = !!email && claims.email_verified === true;
  if (!orgClaimMatches(claims)) throw new IdpError("domain");
  if (
    config.OIDC_ALLOWED_DOMAINS.length &&
    !(
      email &&
      emailVerified &&
      config.OIDC_ALLOWED_DOMAINS.includes(
        email.slice(email.lastIndexOf("@") + 1),
      )
    )
  )
    throw new IdpError("domain");
  return {
    provider: "oidc",
    subject: subjectOf(claims.sub),
    email,
    emailVerified,
    name: text(claims.name, 80) ?? text(claims.preferred_username, 80),
  };
}
