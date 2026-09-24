import { oauthClientKind, trackAgentConnected } from "./analytics.ts";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  AGENT_SCOPES,
  agentScopeSchema,
  uuid,
  type AgentScope,
} from "../../packages/contracts/index.ts";
import type { Actor } from "./artifacts.ts";
import { identity, limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import {
  lockOwner,
  MAX_ACTIVE_CONNECTIONS,
  MCP_AUDIENCE,
} from "./service-auth.ts";
import { sha256 } from "./storage.ts";

/*
 * OAuth 2.1 authorization server for the remote MCP connector (Claude.ai,
 * ChatGPT). A grant becomes an ordinary agent_connections row whose bearer
 * token is the short-lived access token, so MCP tools, scope checks, audit and
 * the agents page need no second model. Codes and tokens are stored as SHA-256.
 */

const ACCESS_TTL_SECONDS = 3600;
const CODE_TTL_SECONDS = 60;
const REFRESH_REUSE_GRACE_SECONDS = 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const AUTH_METHODS = [
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Checked by default on the consent page; the rest stay opt-in. */
export const OAUTH_DEFAULT_SCOPES: readonly AgentScope[] = [
  "context",
  "capture",
  "read",
  "share",
];
export const OAUTH_BROWSER_COOKIE = "polka_oauth";
export const OAUTH_MACHINE_PATHS = new Set([
  "/oauth/token",
  "/oauth/register",
  "/oauth/revoke",
]);
export const PROTECTED_RESOURCE_METADATA_URL =
  getOAuthProtectedResourceMetadataUrl(new URL(MCP_AUDIENCE));

const issuer = config.APP_ORIGIN;
const endpoint = (path: string) => new URL(path, issuer).href;

export function authorizationServerMetadata() {
  return {
    issuer,
    authorization_endpoint: endpoint("/oauth/authorize"),
    token_endpoint: endpoint("/oauth/token"),
    registration_endpoint: endpoint("/oauth/register"),
    revocation_endpoint: endpoint("/oauth/revoke"),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...AGENT_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata() {
  return {
    ...buildOAuthProtectedResourceMetadata({
      oauthMetadata: authorizationServerMetadata() as any,
      resourceServerUrl: new URL(MCP_AUDIENCE),
      scopesSupported: [...AGENT_SCOPES],
      resourceName: "Полка",
      dangerouslyAllowInsecureIssuerUrl: LOOPBACK.has(new URL(issuer).hostname),
    }),
    bearer_methods_supported: ["header"],
  };
}

/** The error half of an OAuth endpoint answer (RFC 6749 §5.2 shape). */
class OAuthFailure extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400,
  ) {
    super(error);
  }
}
const invalidGrant = (
  description = "The grant is invalid, expired or already used.",
) => new OAuthFailure("invalid_grant", description);

const secret = () => randomBytes(32).toString("base64url");
const sameHash = (a: string, b: string) =>
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** Only the canonical MCP endpoint is a valid RFC 8707 resource here. */
export function acceptedResource(value: string) {
  try {
    const url = new URL(value);
    if (url.hash || url.search || url.username || url.password) return false;
    const path = url.pathname.replace(/\/$/, "");
    return `${url.origin}${path}` === MCP_AUDIENCE;
  } catch {
    return false;
  }
}

/** https, or http on a loopback host (OAuth for native apps, RFC 8252 §7.3). */
export function validRedirectUri(value: string) {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f#]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/** Exact match; a loopback http redirect may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: readonly string[], candidate: string) {
  if (registered.includes(candidate)) return true;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) return false;
  const withoutPort = (value: URL) =>
    `${value.protocol}//${value.hostname}${value.pathname}${value.search}`;
  return registered.some((entry) => {
    const known = new URL(entry);
    return (
      known.protocol === "http:" && withoutPort(known) === withoutPort(url)
    );
  });
}

function withParams(
  target: string,
  params: Record<string, string | undefined>,
) {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

/** Requested scopes the server knows, always with context; none → all. */
export function offeredScopes(scope: string | undefined): AgentScope[] {
  const known = new Set<AgentScope>(
    (scope ?? "")
      .split(" ")
      .filter((item): item is AgentScope =>
        (AGENT_SCOPES as readonly string[]).includes(item),
      ),
  );
  if (!known.size) return [...AGENT_SCOPES];
  known.add("context");
  return AGENT_SCOPES.filter((item) => known.has(item));
}

const cleanName = (value: string | undefined) => {
  const name = (value ?? "")
    .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return name || "MCP-клиент";
};

// Names people trust are reserved for the vendors' own callback hosts, so a
// self-registered client cannot pose as Claude or ChatGPT on the consent page.
const RESERVED_NAMES = [
  { words: ["claude", "anthropic"], hosts: ["claude.ai", "claude.com"] },
  { words: ["chatgpt", "openai"], hosts: ["chatgpt.com", "openai.com"] },
];
const LOOKALIKES: Record<string, string> = {
  а: "a",
  с: "c",
  е: "e",
  о: "o",
  р: "p",
  х: "x",
  у: "y",
  і: "i",
  ӏ: "l",
  к: "k",
  м: "m",
  т: "t",
  н: "h",
  в: "b",
  г: "r",
  "0": "o",
  "1": "l",
};
const onHost = (uri: string, hosts: string[]) => {
  const host = new URL(uri).hostname;
  return hosts.some((known) => host === known || host.endsWith(`.${known}`));
};

export function vettedClientName(name: string, redirectUris: string[]) {
  const folded = [...name.normalize("NFKC").toLowerCase()]
    .map((char) => LOOKALIKES[char] ?? char)
    .join("")
    .replace(/[^a-z]/g, "");
  const claimed = RESERVED_NAMES.find((entry) =>
    entry.words.some((word) => folded.includes(word)),
  );
  if (!claimed || redirectUris.every((uri) => onHost(uri, claimed.hosts)))
    return name;
  const suffix = " (имя не подтверждено)";
  return `${name.slice(0, 80 - suffix.length).trim()}${suffix}`;
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)

const registrationSchema = z
  .object({
    redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
    client_name: z.string().max(200).optional(),
    grant_types: z.array(z.string().max(64)).max(4).optional(),
    response_types: z.array(z.string().max(64)).max(4).optional(),
    token_endpoint_auth_method: z.string().max(64).optional(),
  })
  .passthrough();

/**
 * Claude.ai and ChatGPT register from their platforms' shared addresses, so
 * the per-address cap is generous; the daily cap bounds the table.
 */
export const REGISTER_LIMITS = { perIp: 300, perDay: 20_000 };

export async function registerClient(body: unknown, ip: string) {
  await limitAttempts(`oauth-register:ip:${ip}`, REGISTER_LIMITS.perIp);
  await limitAttempts("oauth-register:all", REGISTER_LIMITS.perDay, "24 hours");
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success)
    throw new OAuthFailure(
      "invalid_client_metadata",
      "redirect_uris is required; metadata must be JSON strings.",
    );
  const input = parsed.data;
  const redirectUris = [...new Set(input.redirect_uris)];
  if (!redirectUris.every(validRedirectUri))
    throw new OAuthFailure(
      "invalid_redirect_uri",
      "Redirect URIs must be absolute https URLs (http only on loopback) without fragments or credentials.",
    );
  const grantTypes = [...new Set(input.grant_types ?? ["authorization_code"])];
  if (
    !grantTypes.includes("authorization_code") ||
    grantTypes.some(
      (grant) => grant !== "authorization_code" && grant !== "refresh_token",
    )
  )
    throw new OAuthFailure(
      "invalid_client_metadata",
      "Only authorization_code and refresh_token grants are supported.",
    );
  const responseTypes = input.response_types ?? ["code"];
  if (responseTypes.some((type) => type !== "code"))
    throw new OAuthFailure(
      "invalid_client_metadata",
      "Only the code response type is supported.",
    );
  // RFC 7591 §2: an omitted method means client_secret_basic.
  const method = (input.token_endpoint_auth_method ??
    "client_secret_basic") as AuthMethod;
  if (!AUTH_METHODS.includes(method))
    throw new OAuthFailure(
      "invalid_client_metadata",
      "Supported token endpoint auth methods: none, client_secret_post, client_secret_basic.",
    );
  const clientId = `pc_${randomBytes(16).toString("base64url")}`;
  const clientSecret = method === "none" ? null : secret();
  const clientName = vettedClientName(
    cleanName(input.client_name),
    redirectUris,
  );
  const {
    rows: [row],
  } = await db.query(
    `INSERT INTO oauth_clients(
       client_id,secret_hash,auth_method,client_name,redirect_uris,grant_types
     ) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at`,
    [
      clientId,
      clientSecret ? sha256(clientSecret) : null,
      method,
      clientName,
      redirectUris,
      grantTypes,
    ],
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
    ...(clientSecret
      ? { client_secret: clientSecret, client_secret_expires_at: 0 }
      : {}),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: method,
  };
}

type Client = {
  client_id: string;
  secret_hash: string | null;
  auth_method: AuthMethod;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
};

async function findClient(clientId: string | undefined) {
  if (!clientId || !/^pc_[A-Za-z0-9_-]{22}$/.test(clientId)) return null;
  const {
    rows: [client],
  } = await db.query("SELECT * FROM oauth_clients WHERE client_id=$1", [
    clientId,
  ]);
  return (client as Client | undefined) ?? null;
}

/** Client authentication at the token and revocation endpoints. */
async function authenticateClient(
  params: Record<string, string>,
  authorization: string | undefined,
) {
  let clientId = params.client_id;
  let presented = params.client_secret || undefined;
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(authorization ?? "");
  if (basic) {
    if (presented)
      throw new OAuthFailure(
        "invalid_request",
        "Use one client authentication method.",
      );
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const split = decoded.indexOf(":");
    try {
      const basicId = decodeURIComponent(decoded.slice(0, split));
      if (split < 0 || (clientId && clientId !== basicId)) throw new Error();
      clientId = basicId;
      presented = decodeURIComponent(decoded.slice(split + 1));
    } catch {
      throw new OAuthFailure(
        "invalid_client",
        "Client authentication failed.",
        401,
      );
    }
  }
  const client = await findClient(clientId);
  if (!client)
    throw new OAuthFailure(
      "invalid_client",
      "Client authentication failed.",
      401,
    );
  if (client.auth_method === "none") {
    if (presented)
      throw new OAuthFailure(
        "invalid_client",
        "Client authentication failed.",
        401,
      );
    return client;
  }
  if (!presented || !sameHash(sha256(presented), client.secret_hash!))
    throw new OAuthFailure(
      "invalid_client",
      "Client authentication failed.",
      401,
    );
  return client;
}

// ---------------------------------------------------------------------------
// Authorization request → consent → code

type AuthorizeOutcome = { location: string; browserToken?: string };

const consentError = (reason: string) =>
  `/oauth/consent?error=${encodeURIComponent(reason)}`;

export async function beginAuthorization(
  query: Record<string, unknown>,
  ip: string,
): Promise<AuthorizeOutcome> {
  try {
    await limitAttempts(`oauth-authorize:ip:${ip}`, 60);
  } catch {
    return { location: consentError("rate") };
  }
  const single = (name: string) => {
    const value = query[name];
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
  };
  const client = await findClient(single("client_id") ?? undefined);
  if (!client) return { location: consentError("client") };
  const redirectUri = single("redirect_uri");
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri))
    return { location: consentError("redirect") };
  const state = single("state");
  // Any client can register any https redirect, so a malformed request is not
  // bounced there automatically (RFC 9700 §4.11.2): the owner sees the reason
  // here. Only an answer the owner gave on the consent page goes back.
  const fail = (error: string) => ({ location: consentError(error) });
  const names = [
    "response_type",
    "client_id",
    "redirect_uri",
    "state",
    "scope",
    "code_challenge",
    "code_challenge_method",
    "resource",
  ];
  if (names.some((name) => single(name) === null))
    return fail("invalid_request");
  if (single("response_type") !== "code")
    return fail("unsupported_response_type");
  const challenge = single("code_challenge");
  if (
    single("code_challenge_method") !== "S256" ||
    !challenge ||
    !TOKEN.test(challenge)
  )
    return fail("invalid_request");
  if (state && state.length > 2048) return fail("invalid_request");
  const resource = single("resource");
  if (resource !== undefined && !acceptedResource(resource!))
    return fail("invalid_target");
  const scope = single("scope");
  if (scope && scope.length > 1000) return fail("invalid_scope");
  const id = randomUUID();
  const browserToken = secret();
  await db.query(
    `INSERT INTO oauth_authorizations(
       id,client_id,browser_hash,redirect_uri,code_challenge,requested_scopes,
       state,resource,expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')`,
    [
      id,
      client.client_id,
      sha256(browserToken),
      redirectUri,
      challenge,
      offeredScopes(scope ?? undefined),
      state ?? null,
      MCP_AUDIENCE,
    ],
  );
  return { location: `/oauth/consent?request=${id}`, browserToken };
}

const expiredRequest = () =>
  new Problem(
    410,
    "expired",
    "Запрос на подключение устарел или открыт в другом браузере. Начните подключение заново в приложении.",
  );

export async function authorizationDetails(
  actor: Actor,
  requestId: string,
  browserToken: string,
) {
  if (!uuid.safeParse(requestId).success || !TOKEN.test(browserToken))
    throw expiredRequest();
  const {
    rows: [row],
  } = await db.query(
    `SELECT request.id,request.redirect_uri,request.requested_scopes,
            request.expires_at,client.client_id,client.client_name,
            EXISTS(
              SELECT 1 FROM agent_connections connection
              WHERE connection.tenant_id=$3 AND connection.account_id=$4
                AND connection.oauth_client_id=client.client_id
                AND connection.revoked_at IS NULL AND connection.expires_at>now()
            ) AS replaces
     FROM oauth_authorizations request
     JOIN oauth_clients client ON client.client_id=request.client_id
     WHERE request.id=$1 AND request.browser_hash=$2
       AND request.status='pending' AND request.expires_at>now()`,
    [requestId, sha256(browserToken), actor.tenant, actor.id],
  );
  if (!row) throw expiredRequest();
  const scopes = row.requested_scopes as AgentScope[];
  return {
    requestId: row.id,
    client: {
      name: row.client_name,
      redirectHost: new URL(row.redirect_uri).host,
    },
    scopes,
    defaultScopes: scopes.filter((scope) =>
      OAUTH_DEFAULT_SCOPES.includes(scope),
    ),
    accessMinutes: ACCESS_TTL_SECONDS / 60,
    refreshDays: 30,
    maxDays: 365,
    replaces: row.replaces as boolean,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

const decisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      request: uuid,
      decision: z.literal("approve"),
      scopes: z.array(agentScopeSchema).min(1).max(AGENT_SCOPES.length),
    })
    .strict(),
  z.object({ request: uuid, decision: z.literal("deny") }).strict(),
]);

export async function decideAuthorization(
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
  browserToken: string,
  body: unknown,
) {
  const input = decisionSchema.parse(body);
  await limitAttempts(`oauth-decision:${actor.id}`, 30);
  if (!TOKEN.test(browserToken)) throw expiredRequest();
  return transaction(async (c) => {
    await lockOwner(c, actor, sessionToken, csrfToken);
    const {
      rows: [row],
    } = await c.query(
      `SELECT * FROM oauth_authorizations
       WHERE id=$1 AND browser_hash=$2 AND status='pending' AND expires_at>now()
       FOR UPDATE`,
      [input.request, sha256(browserToken)],
    );
    if (!row) throw expiredRequest();
    const answer = (params: Record<string, string>) => ({
      redirectTo: withParams(row.redirect_uri, {
        ...params,
        ...(row.state !== null ? { state: row.state } : {}),
        iss: issuer,
      }),
    });
    if (input.decision === "deny") {
      await c.query(
        "UPDATE oauth_authorizations SET status='denied' WHERE id=$1",
        [row.id],
      );
      return answer({
        error: "access_denied",
        error_description: "The owner declined the connection.",
      });
    }
    const granted = AGENT_SCOPES.filter((scope) =>
      input.scopes.includes(scope),
    );
    if (
      !granted.includes("context") ||
      granted.some((scope) => !row.requested_scopes.includes(scope))
    )
      throw new Problem(
        400,
        "invalid",
        "Сведения и статус нужны каждому подключению; остальные разрешения — только из запроса.",
      );
    const code = secret();
    await c.query(
      `UPDATE oauth_authorizations SET status='approved',tenant_id=$2,
         account_id=$3,granted_scopes=$4,code_hash=$5,
         code_expires_at=now()+$6*interval '1 second'
       WHERE id=$1`,
      [row.id, actor.tenant, actor.id, granted, sha256(code), CODE_TTL_SECONDS],
    );
    return answer({ code });
  });
}

// ---------------------------------------------------------------------------
// Token endpoint

type TokenAnswer = Record<string, unknown>;

export async function revokeConnectionInTransaction(
  c: PoolClient,
  connection: { id: string; tenant_id: string; account_id: string },
) {
  const revoked = await c.query(
    `UPDATE agent_connections SET revoked_at=clock_timestamp()
     WHERE id=$1 AND revoked_at IS NULL`,
    [connection.id],
  );
  await c.query(
    `UPDATE oauth_refresh_tokens SET revoked_at=clock_timestamp()
     WHERE connection_id=$1 AND revoked_at IS NULL`,
    [connection.id],
  );
  if (revoked.rowCount)
    await c.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'agent.connection.revoked',$3)",
      [connection.tenant_id, connection.account_id, connection.id],
    );
}

const lockOwnerOrInvalidGrant = (
  c: PoolClient,
  owner: { account_id: string; tenant_id: string },
) =>
  lockActiveOwnerTenant(
    c,
    { id: owner.account_id, tenant: owner.tenant_id },
    () => invalidGrant(),
  );

function tokenAnswer(
  accessToken: string,
  refreshToken: string | null,
  scopes: AgentScope[],
): TokenAnswer {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    scope: scopes.join(" "),
  };
}

async function exchangeCode(
  client: Client,
  params: Record<string, string>,
): Promise<TokenAnswer> {
  const code = params.code ?? "";
  if (!TOKEN.test(code)) throw invalidGrant();
  if (!params.redirect_uri)
    throw new OAuthFailure("invalid_request", "redirect_uri is required.");
  if (!VERIFIER.test(params.code_verifier ?? ""))
    throw new OAuthFailure(
      "invalid_request",
      "code_verifier must be 43-128 unreserved characters.",
    );
  if (params.resource !== undefined && !acceptedResource(params.resource))
    throw new OAuthFailure(
      "invalid_target",
      `The only resource is ${MCP_AUDIENCE}.`,
    );
  const codeHash = sha256(code);
  const {
    rows: [owner],
  } = await db.query(
    "SELECT account_id,tenant_id FROM oauth_authorizations WHERE code_hash=$1",
    [codeHash],
  );
  if (!owner) throw invalidGrant();
  const outcome = await transaction(async (c) => {
    // Owner before authorization row: the same lock order as the consent step.
    await lockOwnerOrInvalidGrant(c, owner);
    const {
      rows: [row],
    } = await c.query(
      "SELECT * FROM oauth_authorizations WHERE code_hash=$1 FOR UPDATE",
      [codeHash],
    );
    if (!row || row.client_id !== client.client_id) return invalidGrant();
    if (row.status === "consumed") {
      // A replayed code means it leaked: close whatever it produced.
      if (row.connection_id)
        await revokeConnectionInTransaction(c, {
          id: row.connection_id,
          tenant_id: row.tenant_id,
          account_id: row.account_id,
        });
      return invalidGrant();
    }
    if (row.status !== "approved") return invalidGrant();
    // Any redemption attempt uses the code up, successful or not.
    await c.query(
      "UPDATE oauth_authorizations SET status='consumed',consumed_at=clock_timestamp() WHERE id=$1",
      [row.id],
    );
    if (new Date(row.code_expires_at).getTime() <= Date.now())
      return invalidGrant();
    if (params.redirect_uri !== row.redirect_uri) return invalidGrant();
    const challenge = createHash("sha256")
      .update(params.code_verifier)
      .digest("base64url");
    // Both sides are 43-character base64url SHA-256 digests.
    if (
      challenge.length !== row.code_challenge.length ||
      !timingSafeEqual(Buffer.from(challenge), Buffer.from(row.code_challenge))
    )
      return invalidGrant();
    // One live connection per client and owner: re-authorizing replaces it.
    const { rows: previous } = await c.query(
      `SELECT id,tenant_id,account_id FROM agent_connections
       WHERE tenant_id=$1 AND account_id=$2 AND oauth_client_id=$3
         AND revoked_at IS NULL
       ORDER BY id FOR UPDATE`,
      [row.tenant_id, row.account_id, client.client_id],
    );
    // Check the quota before replacing anything: a refusal must leave the
    // previous connection working.
    const {
      rows: [active],
    } = await c.query(
      `SELECT count(*) AS count FROM agent_connections
       WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>now()
         AND NOT (id = ANY($2::uuid[]))`,
      [row.tenant_id, previous.map((connection) => connection.id)],
    );
    if (Number(active.count) >= MAX_ACTIVE_CONNECTIONS)
      return new OAuthFailure(
        "invalid_grant",
        "Too many active agent connections. Revoke one on the Polka agents page.",
      );
    for (const connection of previous)
      await revokeConnectionInTransaction(c, connection);
    const accessToken = secret();
    const connectionId = randomUUID();
    const {
      rows: [connection],
    } = await c.query(
      `INSERT INTO agent_connections(
         id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,
         oauth_client_id,access_expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 days',$8,
         now()+$9*interval '1 second')
       RETURNING *`,
      [
        connectionId,
        row.tenant_id,
        row.account_id,
        sha256(accessToken),
        client.client_name,
        row.granted_scopes,
        MCP_AUDIENCE,
        client.client_id,
        ACCESS_TTL_SECONDS,
      ],
    );
    await c.query(
      "UPDATE oauth_authorizations SET connection_id=$2 WHERE id=$1",
      [row.id, connectionId],
    );
    // Analytics: an agent connected (a new grant; re-authorising counts
    // again, the report counts accounts). `first`: no earlier connection
    // of this account ever worked.
    const {
      rows: [earlier],
    } = await c.query(
      `SELECT EXISTS(SELECT 1 FROM agent_connections
         WHERE tenant_id=$1 AND id<>$2
           AND (oauth_client_id IS NOT NULL OR last_seen_at IS NOT NULL)) AS found`,
      [row.tenant_id, connectionId],
    );
    trackAgentConnected(
      c,
      row.account_id,
      oauthClientKind(client.client_name, client.redirect_uris),
      !earlier.found,
    );
    await c.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'agent.connection.issued',$3)",
      [row.tenant_id, row.account_id, connectionId],
    );
    let refreshToken: string | null = null;
    if (client.grant_types.includes("refresh_token")) {
      refreshToken = secret();
      await c.query(
        `INSERT INTO oauth_refresh_tokens(
           id,connection_id,tenant_id,account_id,client_id,token_hash,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          connectionId,
          row.tenant_id,
          row.account_id,
          client.client_id,
          sha256(refreshToken),
          connection.expires_at,
        ],
      );
    }
    return tokenAnswer(accessToken, refreshToken, connection.scopes);
  });
  if (outcome instanceof OAuthFailure) throw outcome;
  return outcome;
}

async function refresh(
  client: Client,
  params: Record<string, string>,
): Promise<TokenAnswer> {
  if (!client.grant_types.includes("refresh_token"))
    throw new OAuthFailure(
      "unauthorized_client",
      "This client did not register the refresh_token grant.",
    );
  const token = params.refresh_token ?? "";
  if (!TOKEN.test(token)) throw invalidGrant();
  if (params.resource !== undefined && !acceptedResource(params.resource))
    throw new OAuthFailure(
      "invalid_target",
      `The only resource is ${MCP_AUDIENCE}.`,
    );
  const tokenHash = sha256(token);
  const {
    rows: [owner],
  } = await db.query(
    "SELECT account_id,tenant_id FROM oauth_refresh_tokens WHERE token_hash=$1",
    [tokenHash],
  );
  if (!owner) throw invalidGrant();
  const outcome = await transaction(async (c) => {
    await lockOwnerOrInvalidGrant(c, owner);
    const {
      rows: [row],
    } = await c.query(
      `SELECT token.*,connection.scopes,
              connection.revoked_at AS connection_revoked_at,
              connection.expires_at AS connection_expires_at
       FROM oauth_refresh_tokens token
       JOIN agent_connections connection ON connection.id=token.connection_id
       WHERE token.token_hash=$1
       FOR UPDATE OF token,connection`,
      [tokenHash],
    );
    if (!row || row.client_id !== client.client_id) return invalidGrant();
    if (row.rotated_at) {
      // A client retrying a refresh whose answer it lost (or racing itself)
      // presents the token it just rotated. Within the grace window, and only
      // for the immediate predecessor of the live token, refuse without
      // ending the grant; the successor pair from that rotation stays valid.
      const {
        rows: [grace],
      } = await c.query(
        // Compare in SQL: a JS Date would drop the microseconds.
        `SELECT token.rotated_at>clock_timestamp()-$2*interval '1 second'
                AND NOT EXISTS(
                  SELECT 1 FROM oauth_refresh_tokens later
                  WHERE later.connection_id=token.connection_id
                    AND later.id<>token.id AND later.rotated_at>token.rotated_at
                ) AS retry
         FROM oauth_refresh_tokens token WHERE token.id=$1`,
        [row.id, REFRESH_REUSE_GRACE_SECONDS],
      );
      if (grace.retry && !row.revoked_at && !row.connection_revoked_at)
        return invalidGrant(
          "This refresh token was just rotated; use the tokens from that response.",
        );
      // Reuse of a rotated refresh token: assume theft and end the grant.
      await revokeConnectionInTransaction(c, {
        id: row.connection_id,
        tenant_id: row.tenant_id,
        account_id: row.account_id,
      });
      return invalidGrant();
    }
    if (
      row.revoked_at ||
      row.connection_revoked_at ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      new Date(row.connection_expires_at).getTime() <= Date.now()
    )
      return invalidGrant();
    const scopes = row.scopes as AgentScope[];
    if (
      params.scope !== undefined &&
      params.scope
        .split(" ")
        .some((scope) => !(scopes as string[]).includes(scope))
    )
      return new OAuthFailure(
        "invalid_scope",
        "A refresh cannot add scopes beyond the original grant.",
      );
    await c.query(
      "UPDATE oauth_refresh_tokens SET rotated_at=clock_timestamp() WHERE id=$1",
      [row.id],
    );
    const accessToken = secret();
    const refreshToken = secret();
    // The refresh window slides with use but never past one year.
    const {
      rows: [connection],
    } = await c.query(
      `UPDATE agent_connections SET token_hash=$2,
         access_expires_at=now()+$3*interval '1 second',
         expires_at=LEAST(now()+interval '30 days',created_at+interval '365 days')
       WHERE id=$1 RETURNING expires_at`,
      [row.connection_id, sha256(accessToken), ACCESS_TTL_SECONDS],
    );
    await c.query(
      `INSERT INTO oauth_refresh_tokens(
         id,connection_id,tenant_id,account_id,client_id,token_hash,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        row.connection_id,
        row.tenant_id,
        row.account_id,
        client.client_id,
        sha256(refreshToken),
        connection.expires_at,
      ],
    );
    return tokenAnswer(accessToken, refreshToken, scopes);
  });
  if (outcome instanceof OAuthFailure) throw outcome;
  return outcome;
}

export async function tokenRequest(
  params: Record<string, string>,
  authorization: string | undefined,
  ip: string,
) {
  // Platforms exchange codes from shared addresses: only failed client
  // authentication counts per address; a known client has its own cap.
  const client = await authenticateClient(params, authorization).catch(
    async (error) => {
      await limitAttempts(`oauth-token:ip:${ip}`, 300);
      throw error;
    },
  );
  await limitAttempts(`oauth-token:client:${client.client_id}`, 300);
  if (params.grant_type === "authorization_code")
    return exchangeCode(client, params);
  if (params.grant_type === "refresh_token") return refresh(client, params);
  throw new OAuthFailure(
    "unsupported_grant_type",
    "Supported grants: authorization_code, refresh_token.",
  );
}

/** RFC 7009: revoking either token ends the whole grant. */
export async function revokeRequest(
  params: Record<string, string>,
  authorization: string | undefined,
  ip: string,
) {
  await limitAttempts(`oauth-revoke:ip:${ip}`, 300);
  const client = await authenticateClient(params, authorization);
  const token = params.token ?? "";
  if (!TOKEN.test(token)) return;
  const tokenHash = sha256(token);
  const {
    rows: [connection],
  } = await db.query(
    `SELECT connection.id,connection.tenant_id,connection.account_id
     FROM agent_connections connection
     WHERE connection.oauth_client_id=$2 AND (
       connection.token_hash=$1 OR connection.id IN (
         SELECT connection_id FROM oauth_refresh_tokens
         WHERE token_hash=$1 AND client_id=$2
       )
     )`,
    [tokenHash, client.client_id],
  );
  if (!connection) return;
  // The token and refresh paths lock owner tenant, account, then connection;
  // revoke takes the same order so the three cannot deadlock each other. The
  // owner need not be active: a disabled owner's grant is still revoked.
  await transaction(async (c) => {
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [
      connection.tenant_id,
    ]);
    await c.query("SELECT 1 FROM accounts WHERE id=$1 FOR UPDATE", [
      connection.account_id,
    ]);
    await c.query("SELECT id FROM agent_connections WHERE id=$1 FOR UPDATE", [
      connection.id,
    ]);
    await revokeConnectionInTransaction(c, connection);
  });
}

// ---------------------------------------------------------------------------
// Routes

/** Only the urlencoded parser below creates this; JSON cannot pose as it. */
class FormBody {
  constructor(
    public params: Record<string, string>,
    public duplicate: boolean,
  ) {}
}

function formParams(req: FastifyRequest) {
  const type = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  const body = req.body;
  if (!(body instanceof FormBody) || body.duplicate) return null;
  return Object.values(body.params).every((value) => typeof value === "string")
    ? body.params
    : null;
}

function sendFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof OAuthFailure) {
    if (error.status === 401)
      reply.header("www-authenticate", 'Basic realm="polka"');
    return reply
      .code(error.status)
      .send({ error: error.error, error_description: error.description });
  }
  if (error instanceof Problem && error.status === 429) {
    if (error.retryAfter) reply.header("retry-after", String(error.retryAfter));
    return reply.code(429).send({
      error: "temporarily_unavailable",
      error_description: "Too many requests. Retry in a few minutes.",
    });
  }
  // A deadlock or serialization victim committed nothing; the client may retry.
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "40P01" || code === "40001")
    return reply.code(503).header("retry-after", "1").send({
      error: "temporarily_unavailable",
      error_description: "The request raced another one. Retry it.",
    });
  throw error;
}

const browserCookie = (req: FastifyRequest) =>
  req.cookies[OAUTH_BROWSER_COOKIE] ?? "";

export async function registerOAuthRoutes(app: FastifyInstance) {
  const discovery = { "access-control-allow-origin": "*" };
  for (const path of [
    "/.well-known/oauth-protected-resource",
    new URL(PROTECTED_RESOURCE_METADATA_URL).pathname,
  ])
    app.get(path, async (_req, reply) =>
      reply.headers(discovery).send(protectedResourceMetadata()),
    );
  app.get("/.well-known/oauth-authorization-server", async (_req, reply) =>
    reply.headers(discovery).send(authorizationServerMetadata()),
  );

  app.get("/oauth/authorize", async (req, reply) => {
    const outcome = await beginAuthorization(
      (req.query ?? {}) as Record<string, unknown>,
      req.ip,
    );
    if (outcome.browserToken)
      reply.setCookie(OAUTH_BROWSER_COOKIE, outcome.browserToken, {
        httpOnly: true,
        // Set on a top-level navigation from the client; read by same-origin fetches.
        sameSite: "lax",
        secure: config.COOKIE_SECURE === "true",
        path: "/oauth",
        maxAge: 600,
      });
    return reply.redirect(outcome.location, 302);
  });
  app.get("/oauth/authorize/details", async (req) => {
    const actor = await identity(req);
    const { request } = z
      .object({ request: z.string().max(64) })
      .parse(req.query);
    return authorizationDetails(actor, request, browserCookie(req));
  });
  // Browser-only: the global Origin check, session and CSRF token all apply.
  app.post(
    "/oauth/authorize/decision",
    { bodyLimit: 4096 },
    async (req, reply) => {
      const result = await decideAuthorization(
        await identity(req),
        req.cookies.polka_session ?? "",
        String(req.headers["x-polka-csrf"] ?? ""),
        browserCookie(req),
        req.body,
      );
      reply.clearCookie(OAUTH_BROWSER_COOKIE, { path: "/oauth" });
      return result;
    },
  );

  // Machine endpoints: called server-to-server by the connector platform. They
  // read no cookies, so the global browser Origin check does not apply.
  await app.register(async (machine) => {
    machine.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16 * 1024 },
      (_req, body, done) => {
        const params: Record<string, string> = {};
        let duplicate = false;
        for (const [key, value] of new URLSearchParams(body as string)) {
          if (key in params) duplicate = true;
          params[key] = value;
        }
        done(null, new FormBody(params, duplicate));
      },
    );
    machine.post(
      "/oauth/register",
      { bodyLimit: 16 * 1024 },
      async (req, reply) => {
        try {
          return reply.code(201).send(await registerClient(req.body, req.ip));
        } catch (error) {
          return sendFailure(reply, error);
        }
      },
    );
    machine.post("/oauth/token", async (req, reply) => {
      reply.header("pragma", "no-cache");
      try {
        const params = formParams(req);
        if (!params)
          throw new OAuthFailure(
            "invalid_request",
            "Send one application/x-www-form-urlencoded value per parameter.",
          );
        return reply.send(
          await tokenRequest(params, req.headers.authorization, req.ip),
        );
      } catch (error) {
        return sendFailure(reply, error);
      }
    });
    machine.post("/oauth/revoke", async (req, reply) => {
      try {
        const params = formParams(req);
        if (!params)
          throw new OAuthFailure(
            "invalid_request",
            "Send one application/x-www-form-urlencoded value per parameter.",
          );
        await revokeRequest(params, req.headers.authorization, req.ip);
        return reply.send({});
      } catch (error) {
        return sendFailure(reply, error);
      }
    });
  });
}
