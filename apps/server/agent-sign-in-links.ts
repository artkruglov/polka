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
import { db, transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import {
  PROVISIONAL_SESSION_DAYS,
  PROVISIONAL_SESSION_SECONDS,
} from "./provisional.ts";
import type { ServiceActor } from "./service-auth.ts";
import {
  openValue,
  providerEnabled,
  sealValue,
  type ProviderId,
} from "./sign-in-providers.ts";
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

const HINT_LABEL = "polka:shelf-hint:v1";
const HINT_TTL_MS = 30 * 86_400_000;

/**
 * A pointer to a shelf's sign-in page that carries no secret: it only says
 * which shelf, so /signin can show that shelf's own ways in. Sealed, so it
 * reveals nothing and cannot be forged.
 */
export function shelfHint(accountId: string, now = Date.now()) {
  return sealValue({ a: accountId, expires: now + HINT_TTL_MS }, HINT_LABEL);
}

/** GET /api/auth/shelf-hint: the shelf's name and its ways in, no more. */
export async function describeShelfHint(hint: string) {
  const opened = openValue<{ a: string; expires: number }>(hint, HINT_LABEL);
  if (!opened) throw staleHint();
  const {
    rows: [account],
  } = await db.query(
    `SELECT COALESCE(display_name,name) AS display,name,email,password_hash
       FROM accounts WHERE id=$1 AND NOT disabled
        AND deletion_requested_at IS NULL`,
    [opened.a],
  );
  if (!account) throw staleHint();
  const { rows: identities } = await db.query(
    "SELECT DISTINCT provider FROM account_identities WHERE account_id=$1",
    [opened.a],
  );
  const email = account.email as string | null;
  return {
    displayName: account.display as string,
    providers: identities
      .map((row) => row.provider as ProviderId)
      .filter((provider) => providerEnabled(provider)),
    // Enough to recognise one's own address, not to learn someone else's.
    email: email ? maskEmail(email) : null,
    password: !/^(email|yandex|vk|oidc|guest)-[0-9a-f-]{36}$/.test(account.name),
  };
}

function maskEmail(email: string) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}…${email.slice(at)}`;
}

const staleHint = () =>
  new Problem(
    410,
    "expired",
    "Подсказка устарела. Попросите агента новую: «Открой мою Полку».",
  );

/**
 * «Открой мою Полку». A claimed shelf gets a sign-in hint (/signin?shelf=…,
 * no secret): the person signs in the usual way. Only an unclaimed
 * provisional shelf, which has no other way in, gets a one-time token link,
 * and only from an OAuth connection its owner allowed to (the sign_in
 * permission on consent and the switch on the agents page).
 */
export async function issueSignInLink(actor: ServiceActor) {
  await limitAttempts(
    `sign-in-link:${actor.connectionId}`,
    SIGN_IN_LINKS_PER_HOUR,
    "1 hour",
  );
  const token = randomBytes(32).toString("base64url");
  const issued = await transaction(async (c) => {
    const {
      rows: [connection],
    } = await c.query(
      `SELECT connection.oauth_client_id,connection.sign_in_links,
              connection.scopes,
              account.provisional_at IS NOT NULL
                AND account.claimed_at IS NULL AS provisional
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
    if (!connection.provisional) return { kind: "hint" as const };
    if (!connection.oauth_client_id)
      throw refused(
        "Ссылки для входа выдают только агенты, подключённые через OAuth (Claude, ChatGPT, Codex). Для этого подключения откройте Полку в браузере и войдите.",
      );
    if (
      !(connection.scopes as string[]).includes("sign_in") ||
      !connection.sign_in_links
    )
      throw refused(
        "Этому подключению не разрешено давать ссылки для входа. Владелец включает это на странице подключения («Давать ссылку для входа»).",
      );
    const {
      rows: [row],
    } = await c.query(
      `INSERT INTO agent_sign_in_links(token_hash,connection_id,created_at,expires_at)
       SELECT $1,$2,at,at+$3*interval '1 second' FROM (SELECT clock_timestamp() AS at) now
       RETURNING expires_at`,
      [sha256(token), actor.connectionId, SIGN_IN_LINK_TTL_SECONDS],
    );
    return {
      kind: "link" as const,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  });
  if (issued.kind === "hint") {
    const expiresAt = new Date(Date.now() + HINT_TTL_MS).toISOString();
    return {
      kind: "hint" as const,
      url: `${config.APP_ORIGIN}/signin?${new URLSearchParams({ shelf: shelfHint(actor.accountId) })}`,
      expiresAt,
      expiresInSeconds: HINT_TTL_MS / 1000,
      instructions:
        "Give this link to the user as it is. It carries no secret: it opens the sign-in page of this shelf, where the user signs in the usual way (Яндекс ID, VK ID, email code or login).",
    };
  }
  return {
    kind: "link" as const,
    url: `${config.APP_ORIGIN}/enter#${token}`,
    expiresAt: issued.expiresAt,
    expiresInSeconds: SIGN_IN_LINK_TTL_SECONDS,
    instructions:
      "Give this link to the user exactly as it is; do not open it yourself and do not shorten it. It opens this provisional shelf once, within 5 minutes, after the user confirms on the page.",
  };
}

/**
 * Spends a link: the browser gets a session of the connection's account.
 * Everything that makes a link unusable (unknown, spent, expired, the
 * connection revoked or switched off, the account blocked) is one answer.
 */
const LIVE_LINK = `SELECT link.token_hash,connection.id AS connection_id,
              connection.tenant_id,connection.account_id,
              COALESCE(client.client_name,connection.name) AS client_name,
              COALESCE(account.display_name,account.name) AS shelf_name
         FROM agent_sign_in_links link
         JOIN agent_connections connection ON connection.id=link.connection_id
         JOIN accounts account ON account.id=connection.account_id
         LEFT JOIN oauth_clients client
           ON client.client_id=connection.oauth_client_id
        WHERE link.token_hash=$1 AND link.consumed_at IS NULL
          AND link.expires_at>clock_timestamp()
          AND connection.revoked_at IS NULL AND connection.expires_at>now()
          AND connection.sign_in_links AND 'sign_in'=ANY(connection.scopes)
          AND account.provisional_at IS NOT NULL AND account.claimed_at IS NULL
          AND NOT account.disabled AND account.deletion_requested_at IS NULL`;

/**
 * What the /enter page shows before anything happens: which shelf and which
 * agent. Looking does not spend the link (link scanners in mail and
 * messengers open pages, they do not press buttons).
 */
export async function previewSignInLink(token: string, ip: string) {
  await limitAttempts(`sign-in-link-ip:${ip}`, 20);
  if (!TOKEN.test(token)) throw staleLink();
  const {
    rows: [link],
  } = await db.query(LIVE_LINK, [sha256(token)]);
  if (!link) throw staleLink();
  return {
    shelfName: link.shelf_name as string,
    clientName: link.client_name as string,
  };
}

export async function consumeSignInLink(token: string, ip: string) {
  await limitAttempts(`sign-in-link-ip:${ip}`, 20);
  if (!TOKEN.test(token)) throw staleLink();
  return transaction(async (c) => {
    const {
      rows: [link],
    } = await c.query(
      LIVE_LINK,
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
    // A weak session (sessions.assurance): it browses the shelf and can be
    // upgraded by a real sign-in, nothing more (auth.ts assertStrongSession).
    const session = randomBytes(32).toString("base64url");
    await c.query(
      `INSERT INTO sessions(hash,account_id,expires_at,assurance)
       VALUES($1,$2,now()+$3*interval '1 day','agent_link')`,
      [sha256(session), link.account_id, PROVISIONAL_SESSION_DAYS],
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
      maxAge: PROVISIONAL_SESSION_SECONDS,
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

