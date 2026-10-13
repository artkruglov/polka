// One-time sign-in links the operator prints on the server (migration 074).
//
// A new installation has no account yet, and often no mail or identity
// provider either. The operator runs, on the VM:
//
//   npm run admin -- account bootstrap anna@company.ru
//
// which finds or creates the account with that (verified) address, makes it
// the company admin (TEAM_SHELVES_SCOPE=installation; --org on a shared
// cloud) and prints <origin>/welcome#<token>. The person opens it, presses
// the button and has an ordinary full session; from there they link Яндекс
// ID, the company's SSO or an emailed code. The same command lets a person
// who lost every way in back to their shelf (--no-admin).
//
// Nothing here is reachable from the network except spending a link: issuing
// one needs the database, i.e. the operator. 32 random bytes, stored as
// SHA-256, one hour, one use; a new link spends the account's older ones.
// The token sits in the #fragment, so no server log, Referer or analytics
// sees it.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { limitAttempts, passwordHash } from "./auth.ts";
import { trackSignup } from "./analytics.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { log } from "./log.ts";
import { setCompanyAdmin } from "./organisations.ts";
import { sha256 } from "./storage.ts";

export const OPERATOR_LINK_TTL_SECONDS = 3600;
/** A session opened by the operator's link: the usual 7 days. */
const SESSION_DAYS = 7;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const staleOperatorLink = () =>
  new Problem(
    410,
    "expired",
    "Ссылка устарела или уже использована. Попросите администратора сервера новую: npm run admin -- account bootstrap.",
  );

export const bootstrapEmail = z.string().trim().toLowerCase().email().max(254);

export type BootstrapResult = {
  accountId: string;
  created: boolean;
  companyAdmin: boolean;
  organisation: { id: string; name: string } | null;
  url: string;
  expiresAt: string;
};

/**
 * Finds or creates the account with this address, optionally makes it the
 * company admin, and issues a one-time link. Runs in the caller's
 * transaction (the operator command); never prints or returns the hash.
 */
export async function bootstrapAccount(
  c: PoolClient,
  email: string,
  options: { admin?: boolean; org?: string } = {},
): Promise<BootstrapResult> {
  const address = bootstrapEmail.parse(email);
  // The same lock as an emailed code for this address (email-auth.ts), so a
  // sign-up by code at the same moment cannot open a second account.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [address]);
  let {
    rows: [account],
  } = await c.query(
    "SELECT id,disabled,deletion_requested_at,provisional_at,claimed_at FROM accounts WHERE email=$1 FOR UPDATE",
    [address],
  );
  let created = false;
  if (account) {
    if (account.disabled || account.deletion_requested_at)
      throw new Error(`The account of ${address} is blocked or being deleted; nothing changed.`);
    // Whoever holds the operator's link proved nothing new about the
    // address, but the operator vouches for it, as for a password account.
    await c.query(
      "UPDATE accounts SET email_verified_at=COALESCE(email_verified_at,now()),trusted_at=COALESCE(trusted_at,now()) WHERE id=$1",
      [account.id],
    );
  } else {
    const id = randomUUID();
    // No usable password: the person signs in by this link, then links a
    // provider or an emailed code (like an account opened by a code).
    const unusable = await passwordHash(randomBytes(32).toString("hex"));
    await c.query(
      `INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at,trusted_at)
       VALUES($1,$2,$3,$4,$5,now(),now())`,
      [id, `email-${id}`, unusable, address, address.split("@")[0]!.slice(0, 40)],
    );
    await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [randomUUID(), id]);
    trackSignup(c, id, "password");
    account = { id };
    created = true;
  }
  let companyAdmin = false;
  let organisation: { id: string; name: string } | null = null;
  if (options.admin !== false) {
    const result = await setCompanyAdmin(c, address, { org: options.org });
    companyAdmin = result.companyAdmin;
    organisation = result.organisation ? { id: result.organisation.id, name: result.organisation.name } : null;
  }
  // One live link per account: the newest.
  await c.query("UPDATE operator_sign_in_links SET consumed_at=now() WHERE account_id=$1 AND consumed_at IS NULL", [
    account.id,
  ]);
  const token = randomBytes(32).toString("base64url");
  const {
    rows: [link],
  } = await c.query(
    `INSERT INTO operator_sign_in_links(token_hash,account_id,created_at,expires_at)
     SELECT $1,$2,at,at+$3*interval '1 second' FROM (SELECT now() AS at) now
     RETURNING expires_at`,
    [sha256(token), account.id, OPERATOR_LINK_TTL_SECONDS],
  );
  return {
    accountId: account.id,
    created,
    companyAdmin,
    organisation,
    url: `${config.APP_ORIGIN}/welcome#${token}`,
    expiresAt: new Date(link.expires_at).toISOString(),
  };
}

const LIVE_LINK = `SELECT link.token_hash,link.account_id,tenant.id AS tenant_id,
              COALESCE(account.display_name,account.name) AS shelf_name,
              account.email,account.company_admin
         FROM operator_sign_in_links link
         JOIN accounts account ON account.id=link.account_id
         JOIN tenants tenant ON tenant.owner_id=account.id
        WHERE link.token_hash=$1 AND link.consumed_at IS NULL
          AND link.expires_at>now()
          AND NOT account.disabled AND account.deletion_requested_at IS NULL`;

/** What /welcome shows before the click. Looking spends nothing (link scanners open pages). */
export async function previewOperatorLink(token: string, ip: string) {
  await limitAttempts(`operator-link-ip:${ip}`, 20);
  if (!TOKEN.test(token)) throw staleOperatorLink();
  const {
    rows: [link],
  } = await db.query(LIVE_LINK, [sha256(token)]);
  if (!link) throw staleOperatorLink();
  return {
    shelfName: link.shelf_name as string,
    email: link.email as string | null,
    companyAdmin: link.company_admin === true,
  };
}

/** Spends a link: a full session of its account (it may link sign-in methods). */
export async function consumeOperatorLink(token: string, ip: string) {
  await limitAttempts(`operator-link-ip:${ip}`, 20);
  if (!TOKEN.test(token)) throw staleOperatorLink();
  const entered = await transaction(async (c) => {
    const {
      rows: [link],
    } = await c.query(`${LIVE_LINK} FOR UPDATE OF link`, [sha256(token)]);
    if (!link) throw staleOperatorLink();
    const spent = await c.query(
      "UPDATE operator_sign_in_links SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL",
      [link.token_hash],
    );
    if (!spent.rowCount) throw staleOperatorLink();
    const session = randomBytes(32).toString("base64url");
    await c.query("INSERT INTO sessions VALUES($1,$2,now()+$3*interval '1 day')", [
      sha256(session),
      link.account_id,
      SESSION_DAYS,
    ]);
    return { session, accountId: link.account_id as string };
  });
  // The operator's journal: who came in by a printed link. Never the token.
  log.info({ event: "auth.operator_link_used", accountId: entered.accountId });
  return { session: entered.session, maxAge: SESSION_DAYS * 86_400 };
}
