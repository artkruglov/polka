// One-time sign-in links from an agent (docs/specs/SIGN_IN_PROVIDERS.md § 10).
//
// «Как вернуться в полку, куда сохраняет мой Claude?» The person asks the
// agent «Открой мою Полку»; an OAuth-connected agent calls polka_open_shelf
// (or POST /api/v1/sign-in-link) and hands over <origin>/enter#<token>. The
// token sits in the #fragment, so it never reaches a server log, a Referer
// or analytics; the page posts it to /api/auth/enter, which spends it and
// signs the browser in to the connection's shelf.
//
// 32 random bytes, stored as SHA-256, 5 minutes, one use, bound to the
// connection (and through it to the account). Only OAuth connections issue
// links (a pasted static token is a secret the person already holds and
// often shares with CI); the owner can switch it off per connection.
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import {
  PROVISIONAL_SESSION_DAYS,
  PROVISIONAL_SESSION_SECONDS,
} from "./provisional.ts";
import type { ServiceActor } from "./service-auth.ts";
import { sha256 } from "./storage.ts";

export const SIGN_IN_LINK_TTL_SECONDS = 300;
/** Links one connection may issue per hour. */
export const SIGN_IN_LINKS_PER_HOUR = 5;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const refused = (message: string) => new Problem(403, "forbidden", message);

export const staleLink = () =>
  new Problem(
    410,
    "expired",
    "Ссылка устарела или уже использована. Попросите агента новую: «Открой мою Полку».",
  );

/** Issues a link into the shelf `actor`'s connection saves to. */
export async function issueSignInLink(actor: ServiceActor) {
  await limitAttempts(
    `sign-in-link:${actor.connectionId}`,
    SIGN_IN_LINKS_PER_HOUR,
    "1 hour",
  );
  const token = randomBytes(32).toString("base64url");
  const expiresAt = await transaction(async (c) => {
    const {
      rows: [connection],
    } = await c.query(
      `SELECT connection.oauth_client_id,connection.sign_in_links
         FROM agent_connections connection
         JOIN accounts account ON account.id=connection.account_id
         JOIN tenants tenant ON tenant.id=connection.tenant_id
          AND tenant.owner_id=account.id
        WHERE connection.id=$1 AND connection.tenant_id=$2
          AND connection.account_id=$3
          AND connection.revoked_at IS NULL AND connection.expires_at>now()
          AND NOT account.disabled AND account.deletion_requested_at IS NULL
        FOR UPDATE OF connection`,
      [actor.connectionId, actor.tenantId, actor.accountId],
    );
    if (!connection)
      throw new Problem(401, "unauthorized", "Подключение агента недействительно.");
    if (!connection.oauth_client_id)
      throw refused(
        "Ссылки для входа выдают только агенты, подключённые через OAuth (Claude, ChatGPT, Codex). Для этого подключения откройте Полку в браузере и войдите.",
      );
    if (!connection.sign_in_links)
      throw refused(
        "Владелец выключил ссылки для входа у этого подключения (раздел «Агенты» на Полке).",
      );
    const {
      rows: [row],
    } = await c.query(
      `INSERT INTO agent_sign_in_links(token_hash,connection_id,created_at,expires_at)
       SELECT $1,$2,at,at+$3*interval '1 second' FROM (SELECT clock_timestamp() AS at) now
       RETURNING expires_at`,
      [sha256(token), actor.connectionId, SIGN_IN_LINK_TTL_SECONDS],
    );
    return new Date(row.expires_at).toISOString();
  });
  return {
    url: `${config.APP_ORIGIN}/enter#${token}`,
    expiresAt,
    expiresInSeconds: SIGN_IN_LINK_TTL_SECONDS,
    instructions:
      "Give this link to the user exactly as it is; do not open it yourself and do not shorten it. It signs one browser in to this shelf once, within 5 minutes.",
  };
}

/**
 * Spends a link: the browser gets a session of the connection's account.
 * Everything that makes a link unusable (unknown, spent, expired, the
 * connection revoked or switched off, the account blocked) is one answer.
 */
export async function consumeSignInLink(token: string, ip: string) {
  await limitAttempts(`sign-in-link-ip:${ip}`, 20);
  if (!TOKEN.test(token)) throw staleLink();
  return transaction(async (c) => {
    const {
      rows: [link],
    } = await c.query(
      `SELECT link.token_hash,connection.id AS connection_id,
              connection.tenant_id,connection.account_id,
              COALESCE(client.client_name,connection.name) AS client_name,
              account.provisional_at IS NOT NULL
                AND account.claimed_at IS NULL AS provisional
         FROM agent_sign_in_links link
         JOIN agent_connections connection ON connection.id=link.connection_id
         JOIN accounts account ON account.id=connection.account_id
         LEFT JOIN oauth_clients client
           ON client.client_id=connection.oauth_client_id
        WHERE link.token_hash=$1 AND link.consumed_at IS NULL
          AND link.expires_at>clock_timestamp()
          AND connection.revoked_at IS NULL AND connection.expires_at>now()
          AND connection.sign_in_links`,
      [sha256(token)],
    );
    if (!link) throw staleLink();
    const owner = { id: link.account_id, tenant: link.tenant_id };
    await lockActiveOwnerTenant(c as PoolClient, owner, staleLink);
    const spent = await c.query(
      `UPDATE agent_sign_in_links SET consumed_at=clock_timestamp()
        WHERE token_hash=$1 AND consumed_at IS NULL`,
      [link.token_hash],
    );
    if (!spent.rowCount) throw staleLink();
    const session = randomBytes(32).toString("base64url");
    const days = link.provisional ? PROVISIONAL_SESSION_DAYS : 7;
    await c.query(
      "INSERT INTO sessions VALUES($1,$2,now()+$3*interval '1 day')",
      [sha256(session), link.account_id, days],
    );
    // The journal of the shelf: which connection let a browser in. Never
    // the token.
    await c.query(
      `INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,actor_type,connection_id)
       VALUES($1,$2,'auth.agent_link_used',$3,'agent',$3)`,
      [link.tenant_id, link.account_id, link.connection_id],
    );
    return {
      session,
      maxAge: link.provisional ? PROVISIONAL_SESSION_SECONDS : 604800,
      clientName: link.client_name as string,
    };
  });
}

/** The owner's per-connection switch (the agents page). */
export async function setSignInLinks(
  c: PoolClient,
  owner: { id: string; tenant: string },
  connectionId: string,
  enabled: boolean,
) {
  const updated = await c.query(
    `UPDATE agent_connections SET sign_in_links=$4
      WHERE id=$1 AND tenant_id=$2 AND account_id=$3
        AND oauth_client_id IS NOT NULL
      RETURNING id`,
    [connectionId, owner.tenant, owner.id, enabled],
  );
  return !!updated.rowCount;
}

