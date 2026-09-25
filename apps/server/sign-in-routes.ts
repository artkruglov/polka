// Routes of external sign-in (docs/specs/SIGN_IN_PROVIDERS.md § 1).
//
//   GET  /api/auth/idp/:provider/start?next=…[&ref=…&referrer=…][&known=1]  leave for the provider
//   POST /api/auth/idp/:provider/link           the same, to link (session)
//   GET  /api/auth/idp/:provider/callback       back from the provider
//   GET  /api/auth/idp/pending                  a sign-in waiting for «войти или создать»
//   POST /api/auth/idp/pending/create           … open the new shelf after all
//   POST /api/auth/idp/pending/link             … link it to the shelf just signed in to
//   POST /api/auth/idp/pending/cancel           … forget it
//   GET  /api/account/identities                linked providers
//   GET  /login?next=…                          303 to /signup (an alias)
//   POST /api/account/identities/:provider/unlink
//
// Failures come back to /signup?idp_error=<code>; nothing a provider sent is
// echoed. The callback answers 303, so the URL with the code does not stay in
// the browser's history.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ClaimCollision,
  completeProviderSignIn,
  listIdentities,
  unlinkIdentity,
  wouldOpenNewShelf,
} from "./account-identities.ts";
import { sanitizeSource } from "./analytics.ts";
import { assertStrongSession, identity, limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { missing, Problem } from "./errors.ts";
import {
  holdPending,
  PENDING_TTL_SECONDS,
  peekPending,
  takePending,
} from "./sign-in-pending.ts";
import {
  FLOW_COOKIE,
  FLOW_COOKIE_PATH,
  FLOW_TTL_SECONDS,
  IdpError,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  finishFlow,
  linkOnly,
  openFlow,
  providerEnabled,
  safeReturnPath,
  startFlow,
  type ProviderId,
  type ProviderProfile,
} from "./sign-in-providers.ts";
import { sha256 } from "./storage.ts";

const providerParam = z.object({ provider: z.enum(PROVIDER_IDS) });

/** The sealed name of a sign-in waiting on /signup/choose. */
export const PENDING_COOKIE = "polka_idp_pending";
/** The sealed name of a claim collision waiting on /claim. */
export const CLAIM_COOKIE = "polka_claim";
export const CLAIM_COOKIE_PATH = "/api/account/claim";

/** The attributes of every session cookie (7 days unless stated). */
export const sessionCookie = (maxAge = 604800) => ({
  httpOnly: true,
  sameSite: "strict" as const,
  secure: config.COOKIE_SECURE === "true",
  path: "/",
  maxAge,
});

/** A sealed pending entry: HttpOnly, Lax (set on a return from a provider). */
export const pendingCookie = (path: string) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.COOKIE_SECURE === "true",
  path,
  maxAge: PENDING_TTL_SECONDS,
});

/** Holds a claim collision (claim-routes.ts) and sets its cookie. */
export function holdCollision(
  reply: FastifyReply,
  entry: {
    provisionalId: string;
    targetId: string;
    targetSession: string | null;
    profile: ProviderProfile | null;
    method: string;
  },
) {
  reply.setCookie(
    CLAIM_COOKIE,
    holdPending({ kind: "collision", ...entry }),
    pendingCookie(CLAIM_COOKIE_PATH),
  );
}

function enabledProvider(req: FastifyRequest): ProviderId {
  const parsed = providerParam.safeParse(req.params);
  if (!parsed.success || !providerEnabled(parsed.data.provider))
    throw missing();
  return parsed.data.provider;
}

const flowCookie = {
  httpOnly: true,
  // Lax: the provider's redirect back is a cross-site top-level GET.
  sameSite: "lax" as const,
  path: FLOW_COOKIE_PATH,
};

const pendingGone = () =>
  new Problem(
    410,
    "expired",
    "Вход не завершён: прошло больше 10 минут или он открыт в другом браузере. Войдите ещё раз.",
  );

/** GOOGLE_SIGNUP=link-only, in the words of the sign-in page. */
export const LINK_ONLY_MESSAGE =
  "Через Google можно войти только в полку, к которой он уже привязан. Войдите через Яндекс ID, VK ID или по почте и привяжите Google в «Способах входа».";

const IDP_PROBLEMS: Partial<Record<IdpError["code"], string>> = {
  linked:
    "Этот аккаунт уже привязан к другой полке. Войдите через него, чтобы открыть ту полку.",
  blocked: "Эта полка заблокирована или удаляется.",
  signup:
    "Новые полки сейчас не открываются: регистрация закрыта на сегодня или только по приглашению.",
  domain: "Вход разрешён только сотрудникам компании с почтой её домена.",
  link_only: LINK_ONLY_MESSAGE,
};

function idpProblem(error: IdpError) {
  return new Problem(
    error.code === "signup" ? 429 : 409,
    error.code === "signup" ? "quota" : "conflict",
    IDP_PROBLEMS[error.code] ??
      "Не удалось завершить вход. Попробуйте ещё раз.",
    { reason: error.code },
  );
}

async function endSession(token: string) {
  await db.query("DELETE FROM sessions WHERE hash=$1", [sha256(token)]);
}

function failure(reply: FastifyReply, code: string, next: string | null) {
  const query = new URLSearchParams({ idp_error: code });
  if (next && next !== "/start") query.set("next", next);
  return reply.redirect(`/signup?${query}`, 303);
}

/**
 * Every failed return from a provider leaves one line for the operator: the
 * provider and the refusal code, never tokens, addresses or the query.
 */
function logCallbackFailure(provider: ProviderId, code: string) {
  console.error(JSON.stringify({ event: "idp.callback_failed", provider, code }));
}

export function registerSignInRoutes(app: FastifyInstance) {
  const secure = () => config.COOKIE_SECURE === "true";

  // People type /login: the sign-in page is /signup. Only a path of this
  // installation is carried over as `next`.
  app.get("/login", async (req, reply) => {
    const next = safeReturnPath((req.query as Record<string, unknown>)?.next);
    return reply.redirect(
      next ? `/signup?${new URLSearchParams({ next })}` : "/signup",
      303,
    );
  });

  app.get("/api/auth/idp/:provider/start", async (req, reply) => {
    const provider = enabledProvider(req);
    await limitAttempts(`idp-start-ip:${req.ip}`, 60);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const next = safeReturnPath(query.next) ?? "/start";
    // The tab's record of where the visitor came from (analytics.ts):
    // only a sanitised ref and referrer host travel in the sealed flow.
    const source = sanitizeSource({ ref: query.ref, referrer: query.referrer });
    // known=1: this browser remembers a shelf (a localStorage hint that
    // never leaves it); only the flag travels, sealed in the flow.
    const known = query.known === "1";
    // A browser in a provisional shelf by an agent's link (a weak session)
    // signs in for real here; afterwards /claim offers to carry that
    // shelf's works over, never attaching this identity to it.
    const current = await identity(req).catch(() => null);
    const carry = current?.provisional && current.weak ? current.id : null;
    try {
      const { location, cookie } = await startFlow(
        provider,
        next,
        null,
        source,
        known,
        carry,
      );
      reply.setCookie(FLOW_COOKIE, cookie, {
        ...flowCookie,
        secure: secure(),
        maxAge: FLOW_TTL_SECONDS,
      });
      return reply.redirect(location, 303);
    } catch {
      return failure(reply, "provider", next);
    }
  });

  // Linking needs the session and the Origin check (a POST); the browser
  // then leaves for the provider itself.
  app.post(
    "/api/auth/idp/:provider/link",
    { bodyLimit: 1024 },
    async (req, reply) => {
      const provider = enabledProvider(req);
      const actor = await identity(req);
      assertStrongSession(actor);
      // A link-only provider never claims a provisional shelf.
      if (linkOnly(provider) && actor.provisional)
        throw new Problem(403, "forbidden", LINK_ONLY_MESSAGE, {
          reason: "link_only",
        });
      await limitAttempts(`idp-link:${actor.id}`, 20);
      try {
        // Linking claims a provisional shelf (provisional.ts): back to the
        // shelf with a note, not to the settings.
        const { location, cookie } = await startFlow(
          provider,
          actor.provisional
            ? "/?claimed=1"
            : "/settings/agents?linked=1#sign-in",
          actor.id,
        );
        reply.setCookie(FLOW_COOKIE, cookie, {
          ...flowCookie,
          secure: secure(),
          maxAge: FLOW_TTL_SECONDS,
        });
        return { location };
      } catch {
        throw new Problem(
          503,
          "invalid",
          "Поставщик входа сейчас недоступен. Попробуйте позже.",
        );
      }
    },
  );

  app.get("/api/auth/idp/:provider/callback", async (req, reply) => {
    const provider = enabledProvider(req);
    const flow = openFlow(req.cookies[FLOW_COOKIE]);
    // One use: whatever happens next, this browser's flow is over.
    reply.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
    const next = flow?.next ?? null;
    const failTo = flow?.link ? "/settings/agents#sign-in" : next;
    try {
      await limitAttempts(`idp-callback-ip:${req.ip}`, 60);
    } catch {
      logCallbackFailure(provider, "rate_limited");
      return failure(reply, "provider", failTo);
    }
    if (!flow || flow.provider !== provider) {
      logCallbackFailure(provider, "state");
      return failure(reply, "state", null);
    }
    let profile: ProviderProfile | null = null;
    try {
      profile = await finishFlow(
        flow,
        (req.query ?? {}) as Record<string, unknown>,
      );
      // «Похоже, у вас уже есть полка»: nothing is created yet. The profile
      // waits in memory for ten minutes; the URL carries only `next`.
      if (
        !flow.link &&
        !flow.carry &&
        flow.known &&
        // A link-only provider opens no shelf: nothing to choose.
        !linkOnly(provider) &&
        (await wouldOpenNewShelf(profile))
      ) {
        reply.setCookie(
          PENDING_COOKIE,
          holdPending({
            kind: "choice",
            profile,
            next: flow.next,
            source: flow.source ?? null,
          }),
          pendingCookie(FLOW_COOKIE_PATH),
        );
        return reply.redirect(
          `/signup/choose?${new URLSearchParams({ next: flow.next })}`,
          303,
        );
      }
      const result = await completeProviderSignIn(
        profile,
        flow.link,
        req.ip,
        flow.source ?? null,
      );
      // Signed in for real from a provisional shelf opened by an agent's
      // link: the session is held back and /claim asks what to carry over.
      if (flow.carry && result.session && result.accountId !== flow.carry) {
        holdCollision(reply, {
          provisionalId: flow.carry,
          targetId: result.accountId,
          targetSession: result.session,
          profile: null,
          method: provider,
        });
        return reply.redirect("/claim?collision=1", 303);
      }
      if (result.session) {
        // A Strict session cookie is not sent on this cross-site return,
        // so there is no earlier session of this browser to end here.
        reply.setCookie("polka_session", result.session, sessionCookie());
      }
      return reply.redirect(flow.next, 303);
    } catch (error) {
      if (error instanceof ClaimCollision && flow.link) {
        // A provisional shelf met the person's existing one: /claim asks
        // whether to merge. The identity waits in memory, not in the URL.
        holdCollision(reply, {
          provisionalId: flow.link,
          targetId: error.targetId,
          targetSession: null,
          profile,
          method: provider,
        });
        return reply.redirect("/claim?collision=1", 303);
      }
      if (error instanceof IdpError) {
        logCallbackFailure(provider, error.code);
        if (flow.link) {
          const query = new URLSearchParams({ idp_error: error.code });
          // A claim of a provisional shelf explains itself on /claim.
          if (flow.next.startsWith("/?claimed=1"))
            return reply.redirect(`/claim?${query}`, 303);
          return reply.redirect(`/settings/agents?${query}#sign-in`, 303);
        }
        return failure(reply, error.code, failTo);
      }
      logCallbackFailure(provider, "internal");
      return failure(reply, "provider", failTo);
    }
  });

  // The sign-in waiting on /signup/choose: which provider, nothing else.
  app.get("/api/auth/idp/pending", async (req) => {
    const entry = peekPending(req.cookies[PENDING_COOKIE], "choice");
    if (!entry) throw pendingGone();
    return {
      provider: entry.profile.provider,
      providerName: PROVIDER_NAMES[entry.profile.provider](),
      next: entry.next,
    };
  });
  // «Создать новую полку»: what the callback would have done.
  app.post(
    "/api/auth/idp/pending/create",
    { bodyLimit: 1024 },
    async (req, reply) => {
      await limitAttempts(`idp-pending-ip:${req.ip}`, 30);
      const entry = takePending(req.cookies[PENDING_COOKIE], "choice");
      reply.clearCookie(PENDING_COOKIE, { path: FLOW_COOKIE_PATH });
      if (!entry) throw pendingGone();
      let result;
      try {
        result = await completeProviderSignIn(
          entry.profile,
          null,
          req.ip,
          entry.source,
        );
      } catch (error) {
        if (error instanceof IdpError) throw idpProblem(error);
        throw error;
      }
      if (req.cookies.polka_session)
        await endSession(req.cookies.polka_session);
      reply.setCookie("polka_session", result.session!, sessionCookie());
      return { next: entry.next };
    },
  );
  // «Войти в существующую полку»: after that sign-in, the provider is linked
  // to the shelf this browser is now signed in to. The ordinary link rules
  // apply: a provider account already linked elsewhere is refused.
  app.post(
    "/api/auth/idp/pending/link",
    { bodyLimit: 1024 },
    async (req, reply) => {
      const actor = await identity(req);
      assertStrongSession(actor);
      await limitAttempts(`idp-link:${actor.id}`, 20);
      const entry = takePending(req.cookies[PENDING_COOKIE], "choice");
      reply.clearCookie(PENDING_COOKIE, { path: FLOW_COOKIE_PATH });
      if (!entry) throw pendingGone();
      try {
        await completeProviderSignIn(entry.profile, actor.id, req.ip);
      } catch (error) {
        if (error instanceof IdpError) throw idpProblem(error);
        if (error instanceof ClaimCollision)
          throw idpProblem(new IdpError("linked"));
        throw error;
      }
      return {
        providerName: PROVIDER_NAMES[entry.profile.provider](),
        next: entry.next,
      };
    },
  );
  app.post(
    "/api/auth/idp/pending/cancel",
    { bodyLimit: 1024 },
    async (req, reply) => {
      takePending(req.cookies[PENDING_COOKIE], "choice");
      reply.clearCookie(PENDING_COOKIE, { path: FLOW_COOKIE_PATH });
      return { ok: true };
    },
  );

  app.get("/api/account/identities", async (req) =>
    listIdentities(await identity(req)),
  );
  app.post(
    "/api/account/identities/:provider/unlink",
    { bodyLimit: 1024 },
    async (req) => {
      const { provider } = providerParam.parse(req.params);
      const actor = await identity(req);
      assertStrongSession(actor);
      return unlinkIdentity(actor, provider);
    },
  );
}
