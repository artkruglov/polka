import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  issueAgentConnectionSchema,
  type AgentConnection,
  type AgentScope,
} from "../../packages/contracts/index.ts";
import type { Actor } from "./artifacts.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { sha256 } from "./storage.ts";
import { assertActiveOwner, lockActiveOwnerTenant } from "./owner-state.ts";
import { markActive, trackAgentConnected } from "./analytics.ts";
import { lockShelf, type ShelfRole } from "./shelves.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_ACTIVE_CONNECTIONS = 20;

export const MCP_AUDIENCE = new URL("/mcp", config.APP_ORIGIN).toString();
/**
 * A one-time project upload token's audience (polka_project_upload,
 * project-upload.ts): only the project routes of the HTTP API accept it.
 */
export const PROJECT_UPLOAD_AUDIENCE = new URL(
  "/api/v1/projects",
  config.APP_ORIGIN,
).toString();

export type ServiceActor = {
  accountId: string;
  tenantId: string;
  connectionId: string;
  scopes: AgentScope[];
  audience: string;
  expiresAt: number;
  /** Granted to a chat connector by OAuth (not a pasted static token). */
  oauth?: boolean;
  /** The connection's shelf: the account's own, or a department's. */
  shelf?: { kind: "personal" | "team"; name: string | null; role: ShelfRole };
};

/**
 * A connection that may act: not revoked, inside both its refresh window and
 * (for OAuth) its access-token lifetime, of an active account that is still
 * an active member of the connection's shelf (its own, or a department's
 * while TEAM_SHELVES is on; docs/specs/TEAM_SHELVES.md). `match` narrows by token or id; `lock` is an optional
 * row-lock clause for the connection row only.
 */
const liveConnectionSql = (match: string, lock = "") =>
  `SELECT connection.*,member.role AS shelf_role,tenant.kind AS shelf_kind,
          tenant.name AS shelf_name
     FROM agent_connections connection
     JOIN accounts account ON account.id=connection.account_id
     JOIN tenant_members member ON member.tenant_id=connection.tenant_id
       AND member.account_id=account.id AND member.state='active'
     JOIN tenants tenant ON tenant.id=connection.tenant_id
       AND tenant.state='active' ${teamShelvesSql()}
    WHERE ${match}
      AND connection.revoked_at IS NULL AND connection.expires_at>now()
      -- A project upload token lives only while the connection that asked for it does.
      AND (connection.parent_id IS NULL OR EXISTS (
        SELECT 1 FROM agent_connections parent
        WHERE parent.id=connection.parent_id AND parent.revoked_at IS NULL
          AND parent.expires_at>now()
          AND (parent.access_expires_at IS NULL OR parent.access_expires_at>now())))
      AND (connection.access_expires_at IS NULL
        OR connection.access_expires_at>now())
      AND NOT account.disabled AND account.deletion_requested_at IS NULL
    ${lock}`;

const teamShelvesSql = () =>
  config.TEAM_SHELVES === "on" ? "" : "AND tenant.kind='personal'";

const CONNECTION_BY_ID = `connection.id=$1 AND connection.tenant_id=$2
      AND connection.account_id=$3 AND connection.audience=$4`;
const connectionIdParams = (actor: ServiceActor) => [
  actor.connectionId,
  actor.tenantId,
  actor.accountId,
  actor.audience,
];

function serviceActorFromRow(row: any): ServiceActor {
  return {
    accountId: row.account_id,
    tenantId: row.tenant_id,
    connectionId: row.id,
    scopes: row.scopes,
    audience: row.audience,
    oauth: !!row.oauth_client_id,
    ...(row.shelf_role && {
      shelf: {
        kind: row.shelf_kind,
        name: row.shelf_name,
        role: row.shelf_role,
      },
    }),
    // An OAuth access token lapses before its connection's refresh window.
    expiresAt: Math.floor(
      Math.min(
        new Date(row.expires_at).getTime(),
        row.access_expires_at
          ? new Date(row.access_expires_at).getTime()
          : Infinity,
      ) / 1000,
    ),
  };
}

export const unauthorized = () =>
  new Problem(401, "unauthorized", "Подключение агента недействительно.");

const requireScope = (scopes: readonly AgentScope[], scope: AgentScope) => {
  if (!scopes.includes(scope))
    throw new Problem(
      403,
      "forbidden",
      "У подключения нет разрешения для этого действия.",
    );
};

const connectionDTO = (row: any): AgentConnection => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes,
  audience: row.audience,
  status: row.revoked_at
    ? "revoked"
    : new Date(row.expires_at).getTime() <= Date.now()
      ? "expired"
      : row.last_seen_at
        ? "seen"
        : "issued",
  kind: row.oauth_client_id ? "oauth" : "token",
  // OAuth connections may hand their owner a sign-in link (agent-sign-in-links.ts).
  signInLinks: !!row.oauth_client_id && row.sign_in_links !== false,
  createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
  lastSeenAt: row.last_seen_at
    ? new Date(row.last_seen_at).toISOString()
    : null,
  ...(row.shelf_kind === "team" && {
    shelf: { id: row.tenant_id, name: row.shelf_name },
  }),
});

/**
 * A sign-in link opens one's own shelf: an agent connected to a department
 * shelf has none to give (docs/specs/TEAM_SHELVES.md).
 */
export function assertOwnShelf(actor: ServiceActor) {
  if (actor.shelf?.kind === "team")
    throw new Problem(
      409,
      "conflict",
      "Ссылку для входа агент выдаёт только со своей полки. Полку отдела открывают в браузере из «Моей полки».",
    );
}

/** Scopes that change the shelf: a reader connects an agent only to read it. */
const WRITE_SCOPES: readonly AgentScope[] = [
  "capture",
  "revise",
  "share",
  "manage",
];
export function assertScopesFitRole(
  role: ShelfRole,
  scopes: readonly AgentScope[],
) {
  if (role === "reader" && scopes.some((scope) => WRITE_SCOPES.includes(scope)))
    throw new Problem(
      403,
      "forbidden",
      "На этой полке вы читатель: агент может только читать и искать работы.",
    );
}

/** Lock the active owner and verify the session-bound CSRF token. */
export async function lockOwner(
  c: PoolClient,
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
) {
  await lockActiveOwnerTenant(c, actor, unauthorized);
  if (!TOKEN.test(sessionToken) || !TOKEN.test(csrfToken))
    throw new Problem(403, "forbidden", "Проверка запроса истекла.");
  const valid = await c.query(
    `SELECT 1
     FROM sessions s
     JOIN agent_connection_csrf csrf ON csrf.session_hash=s.hash
     WHERE s.hash=$1 AND s.account_id=$2 AND s.expires_at>now()
       AND csrf.token_hash=$3 AND csrf.expires_at>now()`,
    [sha256(sessionToken), actor.id, sha256(csrfToken)],
  );
  if (!valid.rowCount)
    throw new Problem(403, "forbidden", "Проверка запроса истекла.");
}

export async function issueConnectionCsrf(actor: Actor, sessionToken: string) {
  if (!TOKEN.test(sessionToken)) throw unauthorized();
  const token = randomBytes(32).toString("base64url");
  const {
    rows: [row],
  } = await db.query(
    `INSERT INTO agent_connection_csrf(session_hash,token_hash,expires_at)
     SELECT s.hash,$3,now()+interval '10 minutes'
     FROM sessions s
     JOIN accounts a ON a.id=s.account_id
     JOIN tenants t ON t.owner_id=a.id
     WHERE s.hash=$1 AND s.account_id=$2 AND t.id=$4
       AND s.expires_at>now() AND NOT a.disabled
       AND a.deletion_requested_at IS NULL
     ON CONFLICT(session_hash) DO UPDATE
       SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=now()
     RETURNING expires_at`,
    [sha256(sessionToken), actor.id, sha256(token), actor.tenant],
  );
  if (!row) throw unauthorized();
  return { csrfToken: token, expiresAt: row.expires_at.toISOString() };
}

export async function issueAgentConnection(
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
  body: unknown,
) {
  const input = issueAgentConnectionSchema.parse(body);
  if (input.audience !== MCP_AUDIENCE)
    throw new Problem(
      400,
      "invalid",
      "Endpoint подключения не поддерживается.",
    );
  const token = randomBytes(32).toString("base64url");
  const connection = await transaction(async (c) => {
    // To a department shelf the account belongs to (docs/specs/TEAM_SHELVES.md).
    // Its row first: shelf before account, the order every shelf path takes.
    const tenant = input.shelfId ?? actor.tenant;
    if (tenant !== actor.tenant)
      await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [tenant]);
    await lockOwner(c, actor, sessionToken, csrfToken);
    const shelf =
      tenant === actor.tenant
        ? null
        : await lockShelf(c, { id: actor.id, tenant }, "reader");
    if (shelf) assertScopesFitRole(shelf.role, input.scopes);
    const {
      rows: [active],
    } = await c.query(
      `SELECT count(*) AS count FROM agent_connections
       WHERE tenant_id=$1 AND account_id=$2 AND parent_id IS NULL
         AND revoked_at IS NULL AND expires_at>now()`,
      [tenant, actor.id],
    );
    if (Number(active.count) >= MAX_ACTIVE_CONNECTIONS)
      throw new Problem(
        413,
        "quota",
        "Достигнут лимит активных подключений агента.",
      );
    const id = randomUUID();
    const {
      rows: [row],
    } = await c.query(
      `INSERT INTO agent_connections(
         id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day')
       RETURNING *,$9::text AS shelf_kind,$10::text AS shelf_name`,
      [
        id,
        tenant,
        actor.id,
        sha256(token),
        input.name,
        input.scopes,
        input.audience,
        input.ttlDays,
        shelf ? "team" : "personal",
        shelf?.tenant.name ?? null,
      ],
    );
    await c.query(
      "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'agent.connection.issued',$3)",
      [tenant, actor.id, id],
    );
    return row;
  });
  return { connection: connectionDTO(connection), token };
}

export async function listAgentConnections(actor: Actor) {
  await assertActiveOwner(db, actor);
  // Every shelf's: its own and the department shelves it connected agents to.
  const { rows } = await db.query(
    `SELECT listed.*,tenant.kind AS shelf_kind,tenant.name AS shelf_name FROM (
       SELECT * FROM agent_connections
       WHERE account_id=$1 AND parent_id IS NULL
         AND revoked_at IS NULL AND expires_at>now()
       UNION ALL
       (
         SELECT * FROM agent_connections
         WHERE account_id=$1 AND parent_id IS NULL
           AND (revoked_at IS NOT NULL OR expires_at<=now())
         ORDER BY created_at DESC,id DESC LIMIT 100
       )
     ) listed
     JOIN tenants tenant ON tenant.id=listed.tenant_id
     ORDER BY (listed.revoked_at IS NULL AND listed.expires_at>now()) DESC,
       listed.created_at DESC,listed.id DESC`,
    [actor.id],
  );
  return rows.map(connectionDTO);
}

export async function revokeAgentConnection(
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
  connectionId: string,
) {
  return transaction(async (c) => {
    await lockOwner(c, actor, sessionToken, csrfToken);
    const {
      rows: [connection],
    } = await c.query(
      `SELECT * FROM agent_connections
       WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [connectionId, actor.id],
    );
    if (!connection) throw missing();
    if (!connection.revoked_at) {
      await c.query(
        "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1",
        [connectionId],
      );
      await c.query(
        `UPDATE oauth_refresh_tokens SET revoked_at=clock_timestamp()
         WHERE connection_id=$1 AND revoked_at IS NULL`,
        [connectionId],
      );
      await c.query(
        "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,'agent.connection.revoked',$3)",
        [connection.tenant_id, actor.id, connectionId],
      );
    }
    return { ok: true };
  });
}

/** «Может выдавать ссылки для входа»: the owner's switch per OAuth connection. */
export async function setConnectionSignInLinks(
  actor: Actor,
  sessionToken: string,
  csrfToken: string,
  connectionId: string,
  body: unknown,
) {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(body);
  return transaction(async (c) => {
    await lockOwner(c, actor, sessionToken, csrfToken);
    const { setSignInLinks } = await import("./agent-sign-in-links.ts");
    if (!(await setSignInLinks(c, actor, connectionId, enabled)))
      throw missing();
    // An owner who switches links off also voids the ones not yet used.
    if (!enabled)
      await c.query(
        `UPDATE agent_sign_in_links SET consumed_at=clock_timestamp()
          WHERE connection_id=$1 AND consumed_at IS NULL`,
        [connectionId],
      );
    return { ok: true, signInLinks: enabled };
  });
}

export async function authenticateServiceToken(
  token: string,
  audience: string,
  scope?: AgentScope,
  transport: "mcp" | "http" = "mcp",
): Promise<ServiceActor> {
  if (
    !TOKEN.test(token) ||
    (audience !== MCP_AUDIENCE && audience !== PROJECT_UPLOAD_AUDIENCE)
  )
    throw unauthorized();
  const tokenHash = sha256(token);
  const {
    rows: [row],
  } = await db.query(
    liveConnectionSql("connection.token_hash=$1 AND connection.audience=$2"),
    [tokenHash, audience],
  );
  if (!row) throw unauthorized();
  if (scope) requireScope(row.scopes, scope);
  // A token's first successful call is when its agent connected (analytics;
  // an OAuth connection counts when it is granted, oauth.ts). Only one of
  // two concurrent first calls claims it.
  const firstCall =
    // A project upload token is not a newly connected agent.
    !row.oauth_client_id && !row.parent_id && !row.last_seen_at
      ? !!(
          await db.query(
            `UPDATE agent_connections SET last_seen_at=clock_timestamp()
              WHERE id=$1 AND last_seen_at IS NULL`,
            [row.id],
          )
        ).rowCount
      : false;
  const seen = await db.query(
    `UPDATE agent_connections connection
     SET last_seen_at=clock_timestamp()
     FROM accounts account,tenants tenant,tenant_members member
     WHERE connection.token_hash=$1 AND connection.audience=$2
       AND connection.revoked_at IS NULL AND connection.expires_at>now()
       AND (connection.access_expires_at IS NULL
         OR connection.access_expires_at>now())
       AND account.id=connection.account_id AND NOT account.disabled
       AND account.deletion_requested_at IS NULL
       AND tenant.id=connection.tenant_id AND tenant.state='active'
       AND member.tenant_id=tenant.id AND member.account_id=account.id
       AND member.state='active' ${teamShelvesSql()}`,
    [tokenHash, audience],
  );
  if (!seen.rowCount) throw unauthorized();
  markActive(row.account_id);
  if (firstCall) {
    const {
      rows: [earlier],
    } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM agent_connections
         WHERE tenant_id=$1 AND id<>$2
           AND (oauth_client_id IS NOT NULL OR last_seen_at IS NOT NULL)) AS found`,
      [row.tenant_id, row.id],
    );
    trackAgentConnected(
      null,
      row.account_id,
      transport === "http" ? "token-http" : "token-mcp",
      !earlier.found,
    );
  }
  return serviceActorFromRow(row);
}

export async function recheckServiceActor(
  actor: ServiceActor,
  scope: AgentScope,
) {
  const {
    rows: [connection],
  } = await db.query(
    liveConnectionSql(CONNECTION_BY_ID),
    connectionIdParams(actor),
  );
  if (!connection) throw unauthorized();
  requireScope(connection.scopes, scope);
  return serviceActorFromRow(connection);
}

export async function withServiceActorTransaction<T>(
  actor: ServiceActor,
  scope: AgentScope,
  operation: (c: PoolClient, actor: ServiceActor) => Promise<T>,
) {
  return withLockedServiceActor(actor, async (c, verified) => {
    requireScope(verified.scopes, scope);
    return operation(c, verified);
  });
}

/**
 * Recheck a service connection without taking owner locks before an operation
 * that has its own cross-tenant lock order. The operation must validate actor
 * account/tenant and its resource ACL. Byte readers hold canonical row locks
 * until reading finishes; catalog readers authorize one SQL snapshot.
 */
export async function withFreshServiceActorTransaction<T>(
  actor: ServiceActor,
  scope: AgentScope,
  operation: (c: PoolClient, actor: ServiceActor) => Promise<T>,
) {
  return transaction(async (c) => {
    const {
      rows: [connection],
    } = await c.query(
      liveConnectionSql(CONNECTION_BY_ID),
      connectionIdParams(actor),
    );
    if (!connection) throw unauthorized();
    requireScope(connection.scopes, scope);
    const result = await operation(c, serviceActorFromRow(connection));
    const current = await c.query(
      liveConnectionSql(CONNECTION_BY_ID, "FOR SHARE OF connection"),
      connectionIdParams(actor),
    );
    if (!current.rowCount) throw unauthorized();
    requireScope(current.rows[0].scopes, scope);
    return result;
  });
}

async function withLockedServiceActor<T>(
  actor: ServiceActor,
  operation: (c: PoolClient, actor: ServiceActor) => Promise<T>,
) {
  return transaction(async (c) => {
    // The shelf, the account and its membership: an agent acts only while
    // its account is on the shelf. The role is checked by each operation.
    await lockShelf(
      c,
      { id: actor.accountId, tenant: actor.tenantId },
      "reader",
      "UPDATE",
      unauthorized,
    );
    const {
      rows: [connection],
    } = await c.query(
      liveConnectionSql(CONNECTION_BY_ID, "FOR UPDATE OF connection"),
      connectionIdParams(actor),
    );
    if (!connection) throw unauthorized();
    return operation(c, serviceActorFromRow(connection));
  });
}

export async function withServiceActorDerivedScopeTransaction<Value, Result>(
  actor: ServiceActor,
  derive: (
    c: PoolClient,
    actor: ServiceActor,
  ) => Promise<{ scope: AgentScope; value: Value }>,
  operation: (
    c: PoolClient,
    actor: ServiceActor,
    value: Value,
  ) => Promise<Result>,
) {
  return withLockedServiceActor(actor, async (c, verified) => {
    const { scope, value } = await derive(c, verified);
    requireScope(verified.scopes, scope);
    return operation(c, verified, value);
  });
}
