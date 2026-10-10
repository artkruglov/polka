import { beginEmailLogin, verifyEmailLogin } from "./email-auth.ts";
import { z } from "zod";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { identity, limitAttempts, signIn } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import { sessionCookie } from "./sign-in-routes.ts";
import { holdSignInCollision } from "./claim-routes.ts";
import { consumeSignInLink, describeShelfHint, previewSignInLink } from "./agent-sign-in-links.ts";
import { PROVISIONAL_IDLE_DAYS, PROVISIONAL_SESSION_SECONDS, renewProvisionalSession } from "./provisional.ts";
import { sha256 } from "./storage.ts";
import { uuid } from "../../packages/contracts/index.ts";
import {
  issueAgentConnection,
  issueConnectionCsrf,
  listAgentConnections,
  revokeAgentConnection,
  setConnectionSignInLinks,
} from "./service-auth.ts";
import {
  accountDeletionStatus,
  confirmAccountDeletion,
  createAccountDeletionPlan,
  issueAccountDeletionCsrf,
} from "./account-deletion.ts";
import type { FastifyInstance } from "fastify";
import { SHELF, anonymous, id, strongIdentity } from "./route-helpers.ts";

/** Sign-in, the session, account deletion and the person's agent connections. */
export function registerAccountRoutes(app: FastifyInstance) {
  app.get("/api/auth/email/current", async (req) => {
    if (config.MAIL_MODE === "disabled" || !req.cookies.polka_email_challenge) return null;
    const {
      rows: [pending],
    } = await db.query(
      `SELECT id,email,delivery,expires_at,created_at,attempts FROM login_challenges WHERE browser_hash=$1 AND consumed_at IS NULL AND expires_at>now() AND delivery=$2`,
      [sha256(req.cookies.polka_email_challenge), config.MAIL_MODE],
    );
    if (!pending) return null;
    return {
      id: pending.id,
      email: pending.email,
      delivery: pending.delivery,
      expiresAt: pending.expires_at,
      retryAfter: Math.max(0, Math.ceil((new Date(pending.created_at).getTime() + 60000 - Date.now()) / 1000)),
      locked: pending.attempts >= 5,
    };
  });
  app.post("/api/auth/email/start", { bodyLimit: 2048 }, async (req, reply) => {
    const { email } = z
      .object({
        email: z
          .string()
          .trim()
          .email()
          .max(254)
          .transform((s) => s.toLowerCase()),
      })
      .strict()
      .parse(req.body);
    const result = await beginEmailLogin(email, req.ip);
    reply.setCookie("polka_email_challenge", result.browser, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.COOKIE_SECURE === "true",
      path: "/api/auth/email",
      maxAge: 600,
    });
    return {
      id: result.id,
      delivery: result.delivery,
      expiresInSeconds: result.expiresInSeconds,
    };
  });
  app.post("/api/auth/email/verify", { bodyLimit: 2048 }, async (req, reply) => {
    const input = z
      .object({
        id: uuid,
        code: z.string().regex(/^\d{8}$/),
        // Where the visitor came from (a sign-up's source in analytics):
        // the tab's own record, sanitised again by analytics.ts.
        source: z
          .object({
            ref: z.string().max(200).optional(),
            referrer: z.string().max(300).optional(),
          })
          .strict()
          .optional(),
        // The browser remembers another shelf (docs/specs/
        // SIGN_IN_PROVIDERS.md § 1): ask before opening a new one.
        knownShelf: z.boolean().optional(),
        createNew: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    // A provisional shelf in this browser is claimed by an address that
    // has no shelf yet (provisional.ts).
    let current: Awaited<ReturnType<typeof identity>> | null = null;
    try {
      current = await identity(req);
    } catch {
      current = null;
    }
    const result = await verifyEmailLogin(
      input.id,
      input.code,
      req.cookies.polka_email_challenge ?? "",
      req.ip,
      input.source,
      {
        // An agent-link session never attaches an address to its shelf.
        provisionalId: current?.provisional && !current.weak ? current.id : null,
        knownShelf: input.knownShelf,
        createNew: input.createNew,
      },
    );
    if (result.kind === "new-shelf")
      throw new Problem(
        409,
        "conflict",
        "На этот адрес полки ещё нет. Похоже, у вас уже есть полка: войдите в неё или создайте новую.",
        { reason: "new_shelf" },
      );
    reply.clearCookie("polka_email_challenge", { path: "/api/auth/email" });
    if (result.kind === "claimed") return { ok: true, claimed: true };
    if (await holdSignInCollision(req, reply, { accountId: result.accountId, session: result.session }, "email"))
      return { ok: true, collision: true };
    if (req.cookies.polka_session)
      await db.query("DELETE FROM sessions WHERE hash=$1", [sha256(req.cookies.polka_session)]);
    reply.setCookie("polka_session", result.session, sessionCookie());
    return { ok: true, created: result.created };
  });
  app.post("/api/login", { bodyLimit: 2048 }, async (req, reply) => {
    const input = z
      .object({
        name: z.string().min(3).max(40),
        password: z.string().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    const token = await signIn(input.name, input.password, req.ip);
    const {
      rows: [signedIn],
    } = await db.query("SELECT account_id FROM sessions WHERE hash=$1", [sha256(token)]);
    if (
      signedIn &&
      (await holdSignInCollision(req, reply, { accountId: signedIn.account_id, session: token }, "password"))
    )
      return { ok: true, collision: true };
    if (req.cookies.polka_session)
      await db.query("DELETE FROM sessions WHERE hash=$1", [sha256(req.cookies.polka_session)]);
    reply.setCookie("polka_session", token, sessionCookie());
    return { ok: true };
  });
  app.post("/api/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE hash=$1", [sha256(req.cookies.polka_session ?? "")]);
    reply.clearCookie("polka_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (req) => {
    const a = await identity(req);
    return { id: a.id, name: a.name };
  });
  // The web app's «who is here»: 200 for a guest too (account null), so a
  // guest's every page load is not a 401 in the console. /api/me keeps its
  // 401 for clients that need the session to be there.
  app.get("/api/session", async (req, reply) => {
    try {
      const a = await identity(req);
      // A provisional shelf lives while its browser comes back: its session
      // (and cookie) move 30 days ahead on a visit.
      if (a.provisional && !a.weak && (await renewProvisionalSession(req.cookies.polka_session ?? "")))
        reply.setCookie("polka_session", req.cookies.polka_session!, sessionCookie(PROVISIONAL_SESSION_SECONDS));
      // createdAt lets the app tell a shelf made a minute ago from an old
      // one (the «Полка создана» note after a sign-up from a shared link).
      return {
        account: {
          id: a.id,
          name: a.name,
          createdAt: a.createdAt ? a.createdAt.toISOString() : null,
          ...(a.provisional ? { provisional: true, idleDays: PROVISIONAL_IDLE_DAYS } : {}),
          ...(a.weak ? { assurance: "agent_link" as const } : {}),
        },
      };
    } catch (error) {
      if (error instanceof Problem && error.status === 401) return { account: null };
      throw error;
    }
  });
  app.post("/api/account/deletion-csrf", async (req) =>
    issueAccountDeletionCsrf(await strongIdentity(req), req.cookies.polka_session ?? ""),
  );
  app.post("/api/account/deletion-plan", async (req) =>
    createAccountDeletionPlan(
      await strongIdentity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
    ),
  );
  app.post("/api/account/deletion", async (req, reply) => {
    const result = await confirmAccountDeletion(
      await strongIdentity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
      req.body,
    );
    reply.clearCookie("polka_session", { path: "/" }).code(202);
    return result;
  });
  app.post("/api/account/deletion-status", async (req) => {
    const parsed = z
      .object({ capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) throw missing();
    return accountDeletionStatus(parsed.data.capability, req.ip);
  });
  app.post("/api/agent-connections/csrf", async (req) =>
    issueConnectionCsrf(await strongIdentity(req), req.cookies.polka_session ?? ""),
  );
  app.post("/api/agent-connections", async (req) =>
    issueAgentConnection(
      await strongIdentity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
      req.body,
    ),
  );
  app.get("/api/agent-connections", async (req) => listAgentConnections(await identity(req)));
  app.post("/api/agent-connections/:id/revoke", async (req) =>
    revokeAgentConnection(
      await strongIdentity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
      id(req),
    ),
  );
  // /signin?shelf=…: which shelf and its ways in (no secret in the hint).
  app.get("/api/auth/shelf-hint", async (req) => {
    const { h } = z.object({ h: z.string().min(10).max(1024) }).parse(req.query);
    await limitAttempts(`shelf-hint-ip:${req.ip}`, 60);
    return describeShelfHint(h);
  });
  // «Может выдавать ссылки для входа» (agent-sign-in-links.ts).
  app.post("/api/agent-connections/:id/sign-in-links", { bodyLimit: 1024 }, async (req) =>
    setConnectionSignInLinks(
      await strongIdentity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
      id(req),
      req.body,
    ),
  );
  // /enter#<token>: the page posts the fragment here (Origin-checked like
  // every browser POST). The token never appears in a URL we receive.
  // Looking spends nothing: the page shows the shelf and the agent first.
  app.post("/api/auth/enter/preview", { bodyLimit: 1024 }, async (req) => {
    const { token } = z
      .object({ token: z.string().max(64) })
      .strict()
      .parse(req.body);
    const link = await previewSignInLink(token, req.ip);
    const current = await identity(req).catch(anonymous);
    return { ...link, current: current ? { name: current.name } : null };
  });
  // After the click. A browser already signed in keeps its session unless
  // the person chose to switch (replace: true).
  app.post("/api/auth/enter", { bodyLimit: 1024 }, async (req, reply) => {
    const { token, replace } = z
      .object({ token: z.string().max(64), replace: z.boolean().optional() })
      .strict()
      .parse(req.body);
    const current = await identity(req).catch(anonymous);
    if (current && !replace)
      throw new Problem(
        409,
        "conflict",
        `Этот браузер уже вошёл в полку «${current.name}». Выберите, остаться в ней или перейти.`,
        { reason: "signed_in" },
      );
    const entered = await consumeSignInLink(token, req.ip);
    if (req.cookies.polka_session)
      await db.query("DELETE FROM sessions WHERE hash=$1", [sha256(req.cookies.polka_session)]);
    reply.setCookie("polka_session", entered.session, sessionCookie(entered.maxAge));
    return { ok: true, clientName: entered.clientName };
  });
  app.get(
    "/api/folders",
    async (req) =>
      (
        await db.query("SELECT id,name FROM folders WHERE tenant_id=$1 ORDER BY name LIMIT 100", [
          (await identity(req, SHELF)).tenant,
        ])
      ).rows,
  );
}
