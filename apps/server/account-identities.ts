// Accounts behind external sign-in (docs/specs/SIGN_IN_PROVIDERS.md § 1–2).
//
// A provider account is found by (provider, subject). A new one links to an
// existing shelf only when the provider vouches for the address; otherwise it
// gets a shelf of its own, and an unverified address is never given to it.
// Organisation access is decided here too, on every sign-in, from verified
// addresses and the installation's settings only.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { passwordHash } from "./auth.ts";
import { trackSignup, type VisitSource } from "./analytics.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { emailInvited, signupRoomLeft } from "./email-auth.ts";
import { missing, Problem } from "./errors.ts";
import { emailDomain } from "./mail-domains.ts";
import { sha256 } from "./storage.ts";
import { joinLibraryByOrganisation } from "./template-libraries.ts";
import {
  GENERATED_LOGIN,
  IdpError,
  linkOnly,
  PROVIDER_NAMES,
  type ProviderId,
  type ProviderProfile,
} from "./sign-in-providers.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import { isUnclaimed, markClaimed } from "./provisional.ts";

/**
 * A provisional shelf tried to take a provider identity (or its verified
 * address) that already belongs to another shelf: the person owns both, and
 * /claim offers to merge the provisional one into `targetId`.
 */
export class ClaimCollision extends Error {
  constructor(readonly targetId: string) {
    super("claim collision");
  }
}

/**
 * Whether signing in with this profile would open a NEW shelf (no linked
 * identity, no shelf with the verified address). Read-only: the sign-in
 * itself decides again under its locks.
 */
export async function wouldOpenNewShelf(profile: ProviderProfile) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT EXISTS(SELECT 1 FROM account_identities
                    WHERE provider=$1 AND subject=$2)
         OR ($3::text IS NOT NULL AND $4::boolean
             AND EXISTS(SELECT 1 FROM accounts WHERE email=$3)) AS known`,
    [profile.provider, profile.subject, profile.email, profile.emailVerified],
  );
  return !row?.known;
}

type Account = { id: string; tenant: string };

/** Tenant, then account, as email-auth.ts and signIn lock them. */
async function lockActiveAccount(
  c: PoolClient,
  accountId: string,
): Promise<Account | null> {
  const tenant = (
    await c.query("SELECT id FROM tenants WHERE owner_id=$1 FOR UPDATE", [
      accountId,
    ])
  ).rows[0];
  const account = (
    await c.query(
      `SELECT id FROM accounts WHERE id=$1
         AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
      [accountId],
    )
  ).rows[0];
  return tenant && account ? { id: account.id, tenant: tenant.id } : null;
}

async function createShelf(
  c: PoolClient,
  profile: ProviderProfile,
  ip: string,
  source: VisitSource | null,
): Promise<Account> {
  // New shelves by providers share the email sign-up budget and invite mode.
  if (
    config.EMAIL_SIGNUP === "invite" &&
    !(profile.email && profile.emailVerified && emailInvited(profile.email))
  )
    throw new IdpError("signup");
  const email = profile.email && profile.emailVerified ? profile.email : null;
  try {
    // The same caps as an email sign-up: installation, address, network and
    // the address's domain.
    await signupRoomLeft(c, ip, true, email);
  } catch (error) {
    if (error instanceof Problem) throw new IdpError("signup");
    throw error;
  }
  const taken =
    email &&
    (await c.query("SELECT 1 FROM accounts WHERE email=$1", [email])).rowCount;
  const id = randomUUID(),
    tenant = randomUUID();
  // An unused random password keeps password login apart, as for email.
  const password = await passwordHash(randomBytes(32).toString("hex"));
  await c.query(
    `INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at)
     VALUES($1,$2,$3,$4,$5,CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`,
    [
      id,
      `${profile.provider}-${id}`,
      password,
      taken ? null : email,
      (
        profile.name ??
        profile.email?.split("@")[0] ??
        PROVIDER_NAMES[profile.provider]()
      ).slice(0, 40),
    ],
  );
  await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [tenant, id]);
  trackSignup(c, id, profile.provider, source);
  return { id, tenant };
}

async function organisationAccess(
  c: PoolClient,
  account: Account,
  profile: ProviderProfile,
) {
  const grants: Array<{ libraryId: string; role: "reader" | "curator" }> = [];
  if (profile.email && profile.emailVerified) {
    const domain = emailDomain(profile.email);
    for (const rule of config.ORG_DOMAINS)
      if (rule.domain === domain) grants.push(rule);
  }
  if (profile.provider === "oidc" && config.OIDC_ORG_LIBRARY)
    grants.push(config.OIDC_ORG_LIBRARY);
  // One library at a time, in a stable order (library locks never interleave).
  grants.sort((a, b) => a.libraryId.localeCompare(b.libraryId));
  const seen = new Set<string>();
  for (const grant of grants) {
    if (seen.has(grant.libraryId)) continue;
    seen.add(grant.libraryId);
    await joinLibraryByOrganisation(c, account, grant.libraryId, grant.role);
  }
}

/**
 * Signs the person in and returns a new session token, or links the provider
 * to `linkAccountId` (session null). Every refusal is an IdpError with a code the sign-in
 * page explains.
 */
export async function completeProviderSignIn(
  profile: ProviderProfile,
  linkAccountId: string | null,
  ip: string,
  source: VisitSource | null = null,
) {
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `idp:${profile.provider}:${profile.subject}`,
    ]);
    // Serialises with email sign-in of the same address (email-auth.ts).
    if (profile.email)
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        profile.email,
      ]);
    const linked = (
      await c.query(
        "SELECT id,account_id FROM account_identities WHERE provider=$1 AND subject=$2",
        [profile.provider, profile.subject],
      )
    ).rows[0];
    let account: Account | null = null;
    // Linking to a provisional shelf claims it (provisional.ts).
    const claiming = !!linkAccountId && (await isUnclaimed(c, linkAccountId));
    // GOOGLE_SIGNUP=link-only: only a link made by a signed-in (claimed)
    // owner, then sign-in through that link. No new shelf, no link by
    // address, no claim of a provisional shelf.
    if (linkOnly(profile.provider) && (linkAccountId ? claiming : !linked))
      throw new IdpError("link_only");
    if (linkAccountId) {
      if (linked && linked.account_id !== linkAccountId) {
        // The person owns the other shelf too: offer to merge.
        if (claiming) throw new ClaimCollision(linked.account_id);
        throw new IdpError("linked");
      }
      if (claiming && !linked && profile.email && profile.emailVerified) {
        const owner = (
          await c.query("SELECT id FROM accounts WHERE email=$1 AND id<>$2", [
            profile.email,
            linkAccountId,
          ])
        ).rows[0];
        if (owner) throw new ClaimCollision(owner.id);
      }
      account = await lockActiveAccount(c, linkAccountId);
      if (!account) throw new IdpError("blocked");
    } else if (linked) {
      account = await lockActiveAccount(c, linked.account_id);
      if (!account) throw new IdpError("blocked");
    } else if (profile.email && profile.emailVerified) {
      const owner = (
        await c.query("SELECT id FROM accounts WHERE email=$1", [profile.email])
      ).rows[0];
      if (owner) {
        account = await lockActiveAccount(c, owner.id);
        if (!account) throw new IdpError("blocked");
      }
    }
    account ??= await createShelf(c, profile, ip, source);
    // hosted_domain: the Google Workspace domain as Google reports it now.
    const hostedDomain =
      profile.provider === "google" ? (profile.hostedDomain ?? null) : null;
    if (linked)
      await c.query(
        `UPDATE account_identities SET last_used_at=clock_timestamp(),
                hosted_domain=CASE WHEN provider='google' THEN $2
                                   ELSE hosted_domain END
          WHERE id=$1`,
        [linked.id, hostedDomain],
      );
    else
      await c.query(
        `INSERT INTO account_identities(id,account_id,provider,subject,email,email_verified,hosted_domain)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          account.id,
          profile.provider,
          profile.subject,
          profile.email,
          !!profile.email && profile.emailVerified,
          hostedDomain,
        ],
      );
    // A verified provider address confirms the shelf's own matching address.
    if (profile.email && profile.emailVerified)
      await c.query(
        `UPDATE accounts SET email_verified_at=COALESCE(email_verified_at,now())
          WHERE id=$1 AND email=$2`,
        [account.id, profile.email],
      );
    if (claiming) {
      // The provider's verified address becomes the shelf's own when free.
      if (profile.email && profile.emailVerified)
        await c.query(
          `UPDATE accounts SET email=$2,email_verified_at=now()
            WHERE id=$1 AND email IS NULL
              AND NOT EXISTS(SELECT 1 FROM accounts WHERE email=$2)`,
          [account.id, profile.email],
        );
      await markClaimed(
        c,
        account.id,
        profile.provider,
        profile.name ?? profile.email?.split("@")[0] ?? null,
      );
    }
    await organisationAccess(c, account, profile);
    // Linking keeps the person's current session (their Strict cookie stays
    // in the browser); signing in issues a new one.
    if (linkAccountId) return { session: null, accountId: account.id };
    const session = randomBytes(32).toString("base64url");
    await c.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
      [sha256(session), account.id],
    );
    return { session, accountId: account.id };
  });
}


/**
 * Which shelf a browser is in and how its owner signs in to it: the consent
 * page shows it so a connector lands in the shelf the person means.
 */
export async function shelfSummary(accountId: string) {
  const [
    {
      rows: [account],
    },
    { rows: identities },
  ] = await Promise.all([
    db.query(
      `SELECT COALESCE(display_name,name) AS display,name,email,
              provisional_at IS NOT NULL AND claimed_at IS NULL AS provisional
         FROM accounts WHERE id=$1`,
      [accountId],
    ),
    db.query(
      "SELECT provider FROM account_identities WHERE account_id=$1 ORDER BY created_at",
      [accountId],
    ),
  ]);
  const methods: string[] = [];
  if (account?.email) methods.push(`почта ${account.email}`);
  for (const { provider } of identities)
    methods.push(PROVIDER_NAMES[provider as ProviderId]?.() ?? provider);
  if (account && !GENERATED_LOGIN.test(account.name))
    methods.push(`логин ${account.name}`);
  return {
    name: (account?.display as string) ?? "",
    methods,
    provisional: !!account?.provisional,
  };
}

/** Linked providers of the signed-in person (settings). */
export async function listIdentities(actor: Account) {
  const [
    { rows },
    {
      rows: [account],
    },
  ] = await Promise.all([
    db.query(
      `SELECT provider,email,created_at,last_used_at FROM account_identities
        WHERE account_id=$1 ORDER BY created_at`,
      [actor.id],
    ),
    db.query("SELECT email FROM accounts WHERE id=$1", [actor.id]),
  ]);
  return {
    email: (account?.email as string | null) ?? null,
    identities: rows.map((row) => ({
      provider: row.provider as ProviderId,
      name: PROVIDER_NAMES[row.provider as ProviderId]?.() ?? row.provider,
      email: row.email as string | null,
      linkedAt: new Date(row.created_at).toISOString(),
      lastUsedAt: new Date(row.last_used_at).toISOString(),
    })),
    available: config.SIGN_IN_PROVIDERS.map((provider) => ({
      provider,
      name: PROVIDER_NAMES[provider](),
      signup: !linkOnly(provider),
    })),
  };
}

/** Unlinks a provider when another way to sign in remains. */
export async function unlinkIdentity(actor: Account, provider: ProviderId) {
  return transaction(async (c) => {
    await lockActiveOwnerTenant(c, actor);
    const { rows } = await c.query(
      "SELECT id,provider FROM account_identities WHERE account_id=$1 FOR UPDATE",
      [actor.id],
    );
    const target = rows.find((row) => row.provider === provider);
    if (!target) throw missing();
    const {
      rows: [account],
    } = await c.query("SELECT email FROM accounts WHERE id=$1", [actor.id]);
    if (!account?.email && rows.length < 2)
      throw new Problem(
        409,
        "conflict",
        "Это единственный способ войти в полку. Сначала привяжите другой.",
      );
    await c.query("DELETE FROM account_identities WHERE id=$1", [target.id]);
    return { ok: true };
  });
}
