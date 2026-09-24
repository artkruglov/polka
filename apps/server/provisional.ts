// Provisional shelves (docs/specs/SIGN_IN_PROVIDERS.md § 8).
//
// An agent connection started in a browser with no session may open a shelf
// without sign-up: an account with no address and no sign-in method, held by
// the browser's session cookie alone (30 days, renewed on every visit). It
// saves privately, previews and serves agents, but a link or a publication
// needs an authorised person (ч. 10 ст. 8 149-ФЗ): the owner claims the shelf
// with Яндекс ID, VK ID or an address on an allowed domain first. Claiming
// attaches that method to this very account; it never opens another one.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { passwordHash } from "./auth.ts";
import {
  trackShelfClaimed,
  trackSignup,
  type VisitSource,
} from "./analytics.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { signupRoomLeft } from "./email-auth.ts";
import { Problem } from "./errors.ts";
import { sha256 } from "./storage.ts";

type Queryable = Pick<PoolClient, "query">;

export const PROVISIONAL_SESSION_DAYS = 30;
export const PROVISIONAL_SESSION_SECONDS = PROVISIONAL_SESSION_DAYS * 86_400;
/** Idle this long (no visit, no agent, no save) and maintenance deletes it. */
export const PROVISIONAL_IDLE_DAYS = 30;
export const PROVISIONAL_DISPLAY_NAME = "Временная полка";

export const claimUrl = () => `${config.APP_ORIGIN}/claim`;

/** The refusal of a link or a publication from an unclaimed shelf. */
export const unclaimedRefusal = () =>
  new Problem(
    403,
    "forbidden",
    `Полка ещё не закреплена: чтобы выдать ссылку, владелец должен войти через Яндекс ID или почту: ${claimUrl()}. Работа сохранена на полке, видна только владельцу.`,
    { reason: "provisional", claimUrl: claimUrl() },
  );

/** Whether the account is a provisional shelf nobody has claimed yet. */
export async function isUnclaimed(c: Queryable, accountId: string) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT provisional_at IS NOT NULL AND claimed_at IS NULL AS unclaimed
       FROM accounts WHERE id=$1`,
    [accountId],
  );
  return !!row?.unclaimed;
}

export async function assertClaimed(c: Queryable, accountId: string) {
  if (await isUnclaimed(c, accountId)) throw unclaimedRefusal();
}

/**
 * Marks the (locked) provisional account claimed by `method`. A no-op for an
 * ordinary account or one already claimed. The display name stops saying
 * «Временная полка» once the person is known.
 */
export async function markClaimed(
  c: PoolClient,
  accountId: string,
  method: "email" | "yandex" | "vk" | "oidc",
  displayName: string | null,
) {
  const claimed = await c.query(
    `UPDATE accounts SET claimed_at=clock_timestamp(),
            display_name=CASE WHEN display_name=$3 AND $2::text IS NOT NULL
                              THEN $2 ELSE display_name END
      WHERE id=$1 AND provisional_at IS NOT NULL AND claimed_at IS NULL`,
    [accountId, displayName?.slice(0, 40) || null, PROVISIONAL_DISPLAY_NAME],
  );
  if (claimed.rowCount) trackShelfClaimed(c, accountId, method);
  return !!claimed.rowCount;
}

/** Whether the provisional shelf holds anything a merge should keep. */
export async function provisionalHasContent(c: Queryable, accountId: string) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT EXISTS(SELECT 1 FROM artifacts a JOIN tenants t ON t.id=a.tenant_id
                    WHERE t.owner_id=$1)
         OR EXISTS(SELECT 1 FROM agent_connections
                    WHERE account_id=$1 AND revoked_at IS NULL
                      AND expires_at>now()) AS content`,
    [accountId],
  );
  return !!row?.content;
}

/**
 * Opens a provisional shelf and signs this browser in to it. The caller has
 * already checked the request is a real consent step (Origin, the pending
 * authorization's browser cookie). Counts against the same daily limits as a
 * sign-up (installation, network, subnet).
 */
export async function createProvisionalShelf(
  ip: string,
  source: VisitSource | null = null,
) {
  const password = await passwordHash(randomBytes(32).toString("hex"));
  return transaction(async (c) => {
    await signupRoomLeft(c, ip, true, null);
    const id = randomUUID(),
      tenant = randomUUID();
    await c.query(
      `INSERT INTO accounts(id,name,password_hash,display_name,provisional_at)
       VALUES($1,$2,$3,$4,clock_timestamp())`,
      [id, `guest-${id}`, password, PROVISIONAL_DISPLAY_NAME],
    );
    await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      tenant,
      id,
    ]);
    trackSignup(c, id, "provisional", source);
    const session = randomBytes(32).toString("base64url");
    await c.query(
      `INSERT INTO sessions VALUES($1,$2,now()+$3*interval '1 day')`,
      [sha256(session), id, PROVISIONAL_SESSION_DAYS],
    );
    return { accountId: id, tenant, session };
  });
}

/**
 * A provisional shelf lives while its browser comes back: each visit moves
 * the session's end 30 days ahead (at most once a day). Returns whether the
 * cookie should be sent again with the new lifetime.
 */
export async function renewProvisionalSession(sessionToken: string) {
  const renewed = await db.query(
    `UPDATE sessions SET expires_at=now()+$2*interval '1 day'
      WHERE hash=$1 AND expires_at>now()
        AND expires_at<now()+($2-1)*interval '1 day'`,
    [sha256(sessionToken), PROVISIONAL_SESSION_DAYS],
  );
  return !!renewed.rowCount;
}
