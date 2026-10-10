import { readFile } from "node:fs/promises";
import { openFileForExtension, revisionForExtension } from "./extension-content.ts";
import { auditFeedHead, readAuditFeed } from "./extension-feed.ts";
import { pdfConfigured, pdfForExtension } from "./renderer-pdf.ts";
import {
  extensions,
  extensionsConfigured,
  isExtensionMachinePath,
  loadExtensions,
  redactForExtension,
} from "./extensions.ts";
import { registerAgentContext } from "./agent-context.ts";
import { registerAgentSessions, sessionsForExtension } from "./agent-sessions.ts";
import { indexable } from "./indexing.ts";
import { runInChannel } from "./analytics.ts";
import { registerTemplateLibraryRoutes } from "./template-library-routes.ts";
import { registerUrlImports } from "./url-import/routes.ts";
import Fastify, { type FastifyBaseLogger } from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { identity } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import { reportShare } from "./reports.ts";
import { registerEnterpriseRequests } from "./enterprise-requests.ts";
import { registerRecipientCta } from "./recipient-cta.ts";
import { registerModerationRoutes } from "./moderation-routes.ts";
import { registerCommentRoutes } from "./comment-routes.ts";
import { registerSignInRoutes } from "./sign-in-routes.ts";
import { registerClaimRoutes } from "./claim-routes.ts";
import { MAX_BYTES } from "../../packages/contracts/index.ts";
import { withServiceActorTransaction } from "./service-auth.ts";
import { registerMcpTransport } from "./mcp-transport.ts";
import { OAUTH_MACHINE_PATHS, registerOAuthRoutes } from "./oauth.ts";
import {
  MEDIA_UPLOAD_MS,
  bearerActor,
  isMediaUploadPath,
  isPublishApiPath,
  registerPublishApi,
} from "./publish-api.ts";
import { strongIdentity } from "./route-helpers.ts";
import { registerSiteRoutes } from "./site-routes.ts";
import { registerAccountRoutes } from "./account-routes.ts";
import { registerShelfRoutes } from "./shelf-routes.ts";
import { registerWorkRoutes } from "./work-routes.ts";
import { registerViewRoutes } from "./view-routes.ts";
import { registerServiceAccountRoutes } from "./service-account-routes.ts";
import { log } from "./log.ts";

/** The first frame of a stack below its message: where it was thrown. */
export function firstStackFrame(error: unknown) {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== "string") return null;
  const frame = stack.split("\n").find((line) => /^\s+at /.test(line));
  return frame ? frame.trim().slice(0, 300) : null;
}

export { sourceStars } from "./site-routes.ts";
export { RESOLVE_LIMIT_PER_IP } from "./view-routes.ts";
export { TRANSFER_SLOTS } from "./work-routes.ts";
export { anonymous } from "./route-helpers.ts";

export async function createApp() {
  const app = Fastify({
    // The server's log (log.ts); no line per request: URLs carry tokens.
    loggerInstance: log as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: MAX_BYTES,
    // A video upload (publish-api.ts) is streamed and may take minutes; every
    // other request has 30 s to arrive (the onRequest hook below).
    requestTimeout: MEDIA_UPLOAD_MS,
    connectionTimeout: 30000,
    trustProxy: config.TRUST_PROXY.length ? config.TRUST_PROXY : false,
  });
  await app.register(cookie);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.addHook("onRequest", async (req) => {
    if (req.raw.complete || isMediaUploadPath(req.raw.url ?? "")) return;
    setTimeout(() => {
      if (!req.raw.complete) req.raw.destroy();
    }, 30000).unref();
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // frame-src is load-bearing: it is what keeps a saved page from
      // navigating the reader's tab to a look-alike site. Do not widen it.
      // With a viewer every frame (static and interactive) comes from it and
      // the app frames nothing of its own.
      "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src ${config.HTML_LIVE_ENABLED ? config.VIEWER_ORIGIN : "'self'"}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    });
    const pathname = new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname;
    // Public pages may be indexed (indexing.ts); everything else stays out.
    if (!indexable(pathname)) reply.header("x-robots-tag", "noindex, nofollow, noarchive");
    // /mcp, the OAuth machine endpoints and the HTTP publish API are
    // cookie-less server-to-server surfaces with their own authentication;
    // browser routes keep this check.
    if (
      pathname !== "/mcp" &&
      !OAUTH_MACHINE_PATHS.has(pathname) &&
      !isPublishApiPath(pathname) &&
      !isExtensionMachinePath(pathname) &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.APP_ORIGIN
    )
      throw new Problem(403, "forbidden", "Запрос должен быть отправлен из Полки.");
  });
  // Which surface an action came through (analytics.ts: work_saved via).
  // A preHandler, not onRequest: the context must survive body parsing.
  app.addHook("preHandler", (req, _reply, done) => {
    const pathname = new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname;
    runInChannel(pathname === "/mcp" ? "mcp" : isPublishApiPath(pathname) ? "api" : "web", done);
  });
  app.setErrorHandler((error: any, req, reply) => {
    if (error instanceof Problem) {
      if (error.retryAfter) reply.header("retry-after", String(error.retryAfter));
      return reply.code(error.status).send({ code: error.code, message: error.message, ...error.details });
    }
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        code: "invalid",
        message: "Проверьте формат и обязательные поля.",
      });
    // Deadlock or serialization victim: nothing was committed, retrying is safe.
    if (error.code === "40P01" || error.code === "40001")
      return reply.code(503).header("retry-after", "1").send({
        code: "conflict",
        message: "Действие пересеклось с другим. Повторите его.",
      });
    // A statement cancelled while it waited for a row another request holds
    // (statement_timeout counts lock waits). Nothing was committed.
    if (error.code === "57014" || error.code === "55P03") {
      req.log.error({ event: "request.busy", code: error.code });
      return reply.code(503).header("retry-after", "5").send({
        code: "busy",
        message: "Полка сейчас занята другим действием с этими работами. Повторите через несколько секунд.",
      });
    }
    if (error.code === "23505")
      return reply.code(409).send({
        code: "conflict",
        message: "Такое имя или действие уже существует.",
      });
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({
        code: "invalid",
        message: "Запрос не соответствует поддержанному формату или размеру.",
      });
    // The route pattern (never the URL with its ids or tokens), the request
    // id, the error's kind and where it was thrown; no body, credentials or
    // provider diagnostics.
    req.log.error({
      event: "request.failed",
      code: typeof error.code === "string" ? error.code : "internal",
      route: req.routeOptions?.url ?? null,
      method: req.method,
      requestId: req.id,
      error: typeof error?.name === "string" ? error.name : typeof error,
      at: firstStackFrame(error),
    });
    return reply.code(500).send({
      code: "internal",
      message: "Не удалось завершить действие. Сохранённые данные остаются на полке.",
    });
  });
  registerUrlImports(app, identity);
  registerAgentContext(app, identity);
  registerTemplateLibraryRoutes(app, strongIdentity);
  registerSignInRoutes(app);
  registerClaimRoutes(app);
  registerSiteRoutes(app);
  registerAccountRoutes(app);
  registerShelfRoutes(app);
  registerWorkRoutes(app);
  registerViewRoutes(app);
  registerServiceAccountRoutes(app);
  app.post("/api/reports", { bodyLimit: 4096 }, async (req) => reportShare(req.body, req.ip));
  registerModerationRoutes(app);
  registerCommentRoutes(app);
  registerEnterpriseRequests(app);
  registerRecipientCta(app);
  await registerOAuthRoutes(app);
  await registerMcpTransport(app);
  await registerPublishApi(app);
  // A person's agent sessions (docs/specs/AGENT_SESSIONS.md).
  registerAgentSessions(app);
  // Extensions register after the core (docs/specs/EXTENSIONS.md).
  if (!extensionsConfigured()) await loadExtensions(config.POLKA_EXTENSIONS);
  // Their web modules, read once: /ext/<name>.js from this origin (script-src 'self').
  const webModules = new Map<string, Buffer>();
  for (const extension of extensions())
    if (extension.web?.script) webModules.set(extension.name, await readFile(extension.web.script));
  app.get("/ext/:file", async (req, reply) => {
    const match = /^([a-z][a-z0-9-]{1,30})\.js$/.exec((req.params as { file: string }).file);
    const module = match && webModules.get(match[1]!);
    if (!module) throw missing();
    return reply
      .type("text/javascript; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .send(module);
  });
  for (const extension of extensions())
    await extension.register?.(app, {
      identity: (req, options) => {
        // A machine route has no Origin check: a cookie there would be forgeable.
        if (isExtensionMachinePath(new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname))
          throw new Problem(403, "forbidden", "Этот адрес принимает только токен агента.");
        return identity(req, options ?? {});
      },
      agent: async (req, reply, scope) => {
        const actor = await bearerActor(req, reply, scope === "sessions" ? "sessions" : "calls");
        return withServiceActorTransaction(actor, scope, async (_c, verified) => ({
          connectionId: verified.connectionId,
          accountId: verified.accountId,
          tenantId: verified.tenantId,
        }));
      },
      transaction,
      fail: (status, code, message) => new Problem(status, code, message),
      settings: { appOrigin: config.APP_ORIGIN, teamShelves: config.TEAM_SHELVES === "on" },
      log: (event) => log.info({ extension: extension.name, ...event }),
      content: {
        revision: revisionForExtension,
        openFile: openFileForExtension,
        pdf: pdfConfigured() ? pdfForExtension : null,
      },
      auditFeed: { read: readAuditFeed, head: auditFeedHead },
      sessions: sessionsForExtension,
      redact: redactForExtension,
    });
  return app;
}
