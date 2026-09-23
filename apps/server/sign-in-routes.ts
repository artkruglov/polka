// Routes of external sign-in (docs/specs/SIGN_IN_PROVIDERS.md § 1).
//
//   GET  /api/auth/idp/:provider/start?next=…   leave for the provider
//   POST /api/auth/idp/:provider/link           the same, to link (session)
//   GET  /api/auth/idp/:provider/callback       back from the provider
//   GET  /api/account/identities                linked providers
//   POST /api/account/identities/:provider/unlink
//
// Failures come back to /signup?idp_error=<code>; nothing a provider sent is
// echoed. The callback answers 303, so the URL with the code does not stay in
// the browser's history.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { completeProviderSignIn, listIdentities, unlinkIdentity } from "./account-identities.ts";
import { identity, limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { missing, Problem } from "./errors.ts";
import {
  FLOW_COOKIE,
  FLOW_COOKIE_PATH,
  FLOW_TTL_SECONDS,
  IdpError,
  PROVIDER_IDS,
  finishFlow,
  openFlow,
  providerEnabled,
  safeReturnPath,
  startFlow,
  type ProviderId,
} from "./sign-in-providers.ts";

const providerParam = z.object({ provider: z.enum(PROVIDER_IDS) });

function enabledProvider(req: FastifyRequest): ProviderId {
  const parsed = providerParam.safeParse(req.params);
  if (!parsed.success || !providerEnabled(parsed.data.provider)) throw missing();
  return parsed.data.provider;
}

const flowCookie = {
  httpOnly: true,
  // Lax: the provider's redirect back is a cross-site top-level GET.
  sameSite: "lax" as const,
  path: FLOW_COOKIE_PATH,
};

function failure(reply: FastifyReply, code: string, next: string | null) {
  const query = new URLSearchParams({ idp_error: code });
  if (next && next !== "/start") query.set("next", next);
  return reply.redirect(`/signup?${query}`, 303);
}

export function registerSignInRoutes(app: FastifyInstance) {
  const secure = () => config.COOKIE_SECURE === "true";

  app.get("/api/auth/idp/:provider/start", async (req, reply) => {
    const provider = enabledProvider(req);
    await limitAttempts(`idp-start-ip:${req.ip}`, 60);
    const next =
      safeReturnPath((req.query as Record<string, unknown>)?.next) ?? "/start";
    try {
      const { location, cookie } = await startFlow(provider, next, null);
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
  app.post("/api/auth/idp/:provider/link", { bodyLimit: 1024 }, async (req, reply) => {
    const provider = enabledProvider(req);
    const actor = await identity(req);
    await limitAttempts(`idp-link:${actor.id}`, 20);
    try {
      const { location, cookie } = await startFlow(
        provider,
        "/settings/agents?linked=1#sign-in",
        actor.id,
      );
      reply.setCookie(FLOW_COOKIE, cookie, {
        ...flowCookie,
        secure: secure(),
        maxAge: FLOW_TTL_SECONDS,
      });
      return { location };
    } catch {
      throw new Problem(503, "invalid", "Поставщик входа сейчас недоступен. Попробуйте позже.");
    }
  });

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
      return failure(reply, "provider", failTo);
    }
    if (!flow || flow.provider !== provider) return failure(reply, "state", null);
    try {
      const profile = await finishFlow(
        flow,
        (req.query ?? {}) as Record<string, unknown>,
      );
      const result = await completeProviderSignIn(profile, flow.link, req.ip);
      if (result.session) {
        // A Strict session cookie is not sent on this cross-site return,
        // so there is no earlier session of this browser to end here.
        reply.setCookie("polka_session", result.session, {
          httpOnly: true,
          sameSite: "strict",
          secure: secure(),
          path: "/",
          maxAge: 604800,
        });
      }
      return reply.redirect(flow.next, 303);
    } catch (error) {
      if (error instanceof IdpError) {
        if (flow.link) {
          const query = new URLSearchParams({ idp_error: error.code });
          return reply.redirect(`/settings/agents?${query}#sign-in`, 303);
        }
        return failure(reply, error.code, failTo);
      }
      console.error(
        JSON.stringify({ event: "idp.callback_failed", provider }),
      );
      return failure(reply, "provider", failTo);
    }
  });

  app.get("/api/account/identities", async (req) =>
    listIdentities(await identity(req)),
  );
  app.post(
    "/api/account/identities/:provider/unlink",
    { bodyLimit: 1024 },
    async (req) => {
      const { provider } = providerParam.parse(req.params);
      return unlinkIdentity(await identity(req), provider);
    },
  );
}
