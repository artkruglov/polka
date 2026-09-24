// Claiming a provisional shelf when the person turns out to own another one
// (docs/specs/SIGN_IN_PROVIDERS.md § 8).
//
//   GET  /api/account/claim          is this shelf provisional; a collision waiting?
//   POST /api/account/claim/merge    «Объединить»: move this shelf into the other one
//   POST /api/account/claim/switch   open the other shelf, keep this one as it is
//   POST /api/account/claim/cancel   stay here, forget the other sign-in
//
// A collision is recorded by the sign-in that found it (a provider link in
// sign-in-routes.ts, a code or a password in app.ts): the other shelf's id,
// a session for it when one was already issued, and a provider identity to
// link, all in memory (sign-in-pending.ts) behind a sealed cookie.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ClaimCollision,
  completeProviderSignIn,
} from "./account-identities.ts";
import { mergeAccounts, MergeRefusal } from "./account-merge.ts";
import { trackShelfClaimed } from "./analytics.ts";
import { assertStrongSession, identity, limitAttempts } from "./auth.ts";
import { db, transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { peekPending, takePending } from "./sign-in-pending.ts";
import { IdpError, PROVIDER_NAMES } from "./sign-in-providers.ts";
import {
  CLAIM_COOKIE,
  CLAIM_COOKIE_PATH,
  holdCollision,
  sessionCookie,
} from "./sign-in-routes.ts";
import { sha256 } from "./storage.ts";
import { provisionalHasContent } from "./provisional.ts";

const gone = () =>
  new Problem(
    410,
    "expired",
    "Прошло больше 10 минут или вход открыт в другом браузере. Войдите ещё раз.",
  );

const METHOD_NAMES: Record<string, () => string> = {
  email: () => "код на почту",
  password: () => "логин и пароль",
  yandex: PROVIDER_NAMES.yandex,
  vk: PROVIDER_NAMES.vk,
  oidc: PROVIDER_NAMES.oidc,
};

async function issueSession(accountId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
    [sha256(token), accountId],
  );
  return token;
}

/**
 * The browser (signed in to a provisional shelf) just proved it owns another
 * shelf by a code or a password. With something worth keeping on the
 * provisional shelf, the session is held back and /claim asks; otherwise the
 * browser simply moves on. Returns whether the collision was recorded.
 */
export async function holdSignInCollision(
  req: FastifyRequest,
  reply: FastifyReply,
  target: { accountId: string; session: string },
  method: "email" | "password",
) {
  let current;
  try {
    current = await identity(req);
  } catch {
    return false;
  }
  if (
    !current.provisional ||
    current.id === target.accountId ||
    !(await provisionalHasContent(db, current.id))
  )
    return false;
  holdCollision(reply, {
    provisionalId: current.id,
    targetId: target.accountId,
    targetSession: target.session,
    profile: null,
    method,
  });
  return true;
}

export function registerClaimRoutes(app: FastifyInstance) {
  const clear = (reply: FastifyReply) =>
    reply.clearCookie(CLAIM_COOKIE, { path: CLAIM_COOKIE_PATH });

  app.get("/api/account/claim", async (req) => {
    const actor = await identity(req);
    const entry = peekPending(req.cookies[CLAIM_COOKIE], "collision");
    if (!entry || entry.provisionalId !== actor.id)
      return {
        provisional: actor.provisional,
        weak: actor.weak,
        collision: null,
      };
    const {
      rows: [row],
    } = await db.query(
      `SELECT COALESCE(t.display_name,t.name) AS target,
              (SELECT count(*) FROM artifacts a JOIN tenants s ON s.id=a.tenant_id
                WHERE s.owner_id=$2 AND a.trashed_at IS NULL) AS works
         FROM accounts t WHERE t.id=$1`,
      [entry.targetId, actor.id],
    );
    // Every agent that would move, one line each: the person ticks the
    // ones that are theirs (none by default).
    const { rows: connections } = await db.query(
      `SELECT id,name,oauth_client_id IS NOT NULL AS oauth,last_seen_at,created_at
         FROM agent_connections
        WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now()
        ORDER BY created_at`,
      [actor.id],
    );
    return {
      provisional: actor.provisional,
      weak: actor.weak,
      collision: {
        method: entry.method,
        methodName: METHOD_NAMES[entry.method]?.() ?? entry.method,
        targetName: row?.target ?? "",
        works: Number(row?.works ?? 0),
        connections: connections.map((item) => ({
          id: item.id as string,
          name: item.name as string,
          kind: item.oauth ? ("oauth" as const) : ("token" as const),
          createdAt: new Date(item.created_at).toISOString(),
          lastSeenAt: item.last_seen_at
            ? new Date(item.last_seen_at).toISOString()
            : null,
        })),
      },
    };
  });

  app.post(
    "/api/account/claim/merge",
    { bodyLimit: 1024 },
    async (req, reply) => {
      const actor = await identity(req);
      await limitAttempts(`claim-merge:${actor.id}`, 10);
      const { connections } = z
        .object({ connections: z.array(z.string().uuid()).max(100).default([]) })
        .strict()
        .parse(req.body ?? {});
      const entry = takePending(req.cookies[CLAIM_COOKIE], "collision");
      clear(reply);
      if (!entry || entry.provisionalId !== actor.id) throw gone();
      // A session from an agent's link merges only into a shelf this browser
      // has just signed in to for real (a code, a password, a provider).
      if (actor.weak && !entry.targetSession) assertStrongSession(actor);
      let report;
      try {
        report = await mergeAccounts({
          from: actor.id,
          into: entry.targetId,
          actor: "signup",
          reason: "claim",
          keepConnections: connections,
        });
      } catch (error) {
        if (error instanceof MergeRefusal)
          throw new Problem(409, "conflict", error.message);
        throw error;
      }
      // The provider that found the other shelf opens it from now on.
      if (entry.profile)
        try {
          await completeProviderSignIn(entry.profile, entry.targetId, req.ip);
        } catch (error) {
          if (!(error instanceof IdpError || error instanceof ClaimCollision))
            throw error;
        }
      await transaction(async (c) => {
        trackShelfClaimed(c, entry.targetId, "merge");
      });
      const session = entry.targetSession ?? (await issueSession(entry.targetId));
      reply.setCookie("polka_session", session, sessionCookie());
      return {
        ok: true,
        into: report.into.name,
        moved: {
          artifacts: report.counts.artifacts,
          agentConnections: report.counts.activeAgentConnections,
        },
      };
    },
  );

  app.post(
    "/api/account/claim/switch",
    { bodyLimit: 1024 },
    async (req, reply) => {
      const actor = await identity(req);
      const entry = takePending(req.cookies[CLAIM_COOKIE], "collision");
      clear(reply);
      if (!entry || entry.provisionalId !== actor.id) throw gone();
      if (entry.profile)
        try {
          await completeProviderSignIn(entry.profile, entry.targetId, req.ip);
        } catch (error) {
          if (!(error instanceof IdpError || error instanceof ClaimCollision))
            throw error;
        }
      const session = entry.targetSession ?? (await issueSession(entry.targetId));
      reply.setCookie("polka_session", session, sessionCookie());
      return { ok: true };
    },
  );

  app.post(
    "/api/account/claim/cancel",
    { bodyLimit: 1024 },
    async (req, reply) => {
      const entry = takePending(req.cookies[CLAIM_COOKIE], "collision");
      clear(reply);
      if (entry?.targetSession)
        await db.query("DELETE FROM sessions WHERE hash=$1", [
          sha256(entry.targetSession),
        ]);
      return { ok: true };
    },
  );
}

