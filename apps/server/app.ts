import { registerAgentContext } from "./agent-context.ts";
import { connectGuide } from "./connect-guide.ts";
import { authorizeOpsStatus, opsStatus } from "./ops-status.ts";
import { POLKA_VERSION } from "./mcp-server.ts";
import { registerTemplateLibraryRoutes } from "./template-library-routes.ts";
import { registerUrlImports } from "./url-import/routes.ts";
import { beginEmailLogin, verifyEmailLogin } from "./email-auth.ts";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { identity, limitAttempts, signIn } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import { reportShare } from "./reports.ts";
import { issueShareGrant } from "./share-grants.ts";
import { registerModerationRoutes } from "./moderation-routes.ts";
import { registerCommentRoutes } from "./comment-routes.ts";
import { STATIC_HTML_CSP, withNewTabLinks } from "./html.ts";
import {
  isStaticSingleFileBundle,
  staticSingleFileBundleSql,
} from "./revision-manifest.ts";
import { verifyAwayToken, withSignedAwayLinks } from "./away-links.ts";
import {
  issueOwnerStaticView,
  issueRecipientStaticView,
} from "./static-viewer.ts";
import {
  issueOwnerLiveView,
  issueRecipientLiveView,
  LIVE_HTML_PROFILE,
} from "./live-viewer.ts";
import {
  abortUpload,
  beginBundleUpload,
  beginUpload,
  exportRevision,
  finalizeBundleUpload,
  finalizeUpload,
  getArtifact,
  getArtifacts,
  revisionDTO,
  uploadBundleFile,
  uploadBytes,
  uploadStatus,
} from "./artifacts.ts";
import { readBlob, sha256 } from "./storage.ts";
import {
  buildInlineRevision,
  getInlineBuildStatus,
  inlineBuildSelect,
} from "./bundle-derivatives.ts";
import {
  SERVED_BUILDER_VERSIONS_SQL,
  SERVED_RUNTIME_PROFILES_SQL,
  isServedBuilderVersion,
  isServedRuntimeProfile,
} from "./bundle-runtime-contract.ts";
import { MAX_BYTES, MIME, uuid } from "../../packages/contracts/index.ts";
import {
  issueAgentConnection,
  issueConnectionCsrf,
  listAgentConnections,
  revokeAgentConnection,
} from "./service-auth.ts";
import { registerMcpTransport } from "./mcp-transport.ts";
import { OAUTH_MACHINE_PATHS, registerOAuthRoutes } from "./oauth.ts";
import { isPublishApiPath, registerPublishApi } from "./publish-api.ts";
import {
  enableOwnerShare,
  publishOwnerShare,
  revokeOwnerShare,
} from "./shares.ts";
import { updateArtifactMetadata } from "./artifact-metadata.ts";
import { transitionOwnerArtifactLifecycle } from "./artifact-trash.ts";
import {
  assertEditorialShareAccessible,
  getEditorial,
  listEditorial,
} from "./editorial.ts";
import {
  accountDeletionStatus,
  confirmAccountDeletion,
  createAccountDeletionPlan,
  issueAccountDeletionCsrf,
} from "./account-deletion.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";

/** Share resolutions per client IP per 10 minutes; each view resolves once per grant. */
export const RESOLVE_LIMIT_PER_IP = 600;
/** Concurrent upload bodies: server-wide and per shelf. */
export const TRANSFER_SLOTS = { total: 4, perTenant: 3 };

// Shelf and trash pages continue from a microsecond (timestamp,id) pair.
const pageCursor = z.object({ date: z.string().datetime(), id: uuid });
function decodeCursor(value: string | undefined, message: string) {
  if (!value) return null;
  try {
    return pageCursor.parse(
      JSON.parse(Buffer.from(value, "base64url").toString()),
    );
  } catch {
    throw new Problem(400, "invalid", message);
  }
}
const encodeCursor = (date: string, id: string) =>
  Buffer.from(JSON.stringify({ date, id })).toString("base64url");

const viewOptions = z.object({ comments: z.boolean().optional() }).strict();

export async function createApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BYTES,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    trustProxy: config.TRUST_PROXY.length ? config.TRUST_PROXY : false,
  });
  await app.register(cookie);
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "no-referrer",
      // frame-src is load-bearing: it is what keeps a saved page from
      // navigating the reader's tab to a look-alike site. Do not widen it.
      // With a viewer every frame (static and interactive) comes from it and
      // the app frames nothing of its own.
      "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src ${config.HTML_LIVE_ENABLED ? config.VIEWER_ORIGIN : "'self'"}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    });
    const pathname = new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname;
    // /mcp, the OAuth machine endpoints and the HTTP publish API are
    // cookie-less server-to-server surfaces with their own authentication;
    // browser routes keep this check.
    if (
      pathname !== "/mcp" &&
      !OAUTH_MACHINE_PATHS.has(pathname) &&
      !isPublishApiPath(pathname) &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.APP_ORIGIN
    )
      throw new Problem(
        403,
        "forbidden",
        "Запрос должен быть отправлен из Полки.",
      );
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof Problem)
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message, ...error.details });
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
      console.error(JSON.stringify({ event: "request.busy", code: error.code }));
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
    // Intentionally omit request URL, body, credentials and provider diagnostics.
    console.error(
      JSON.stringify({
        event: "request.failed",
        code: typeof error.code === "string" ? error.code : "internal",
      }),
    );
    return reply.code(500).send({
      code: "internal",
      message:
        "Не удалось завершить действие. Сохранённые данные остаются на полке.",
    });
  });
  const id = (req: any) => uuid.parse(req.params.id);
  // The shell asks for the comment overlay when it issues a view grant; the
  // flag lives in the grant, never in a URL anyone could open.
  const withComments = (req: any) =>
    viewOptions.parse(req.body ?? {}).comments === true;
  registerUrlImports(app, identity);
  registerAgentContext(app, identity);
  registerTemplateLibraryRoutes(app, identity);
  // Agent-readable setup: "Connect Полка: <origin>/connect".
  app.get("/connect", async (_req, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send(connectGuide(config.APP_ORIGIN)),
  );
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  // For the operator's monitor only: 404 unless OPS_STATUS_TOKEN is set and
  // presented. 503 when a check fails, so a plain HTTP probe can alert on it.
  app.get("/api/ops/status", async (req, reply) => {
    authorizeOpsStatus(req.headers.authorization);
    const status = await opsStatus(POLKA_VERSION);
    return reply.code(status.ok ? 200 : 503).send(status);
  });
  app.get("/api/capabilities", async () => ({
    profile: "file-v1",
    formats: MIME,
    maxBytes: MAX_BYTES,
    audiences: ["private", "unlisted"],
    // HTML is shown only as a static sandboxed page; ZIP bundles are not accepted yet.
    htmlRuntime: false,
    liveExperimental: config.HTML_LIVE_ENABLED,
    liveMode: config.HTML_LIVE_MODE,
    liveProfile: config.HTML_LIVE_ENABLED ? LIVE_HTML_PROFILE : null,
    // Mirrors /api/imports/capabilities: when disabled, links are only recognised in the browser.
    urlImport: config.URL_IMPORT_ENABLED,
    htmlView: "static-sandbox",
    identity: "operator-provisioned-local-account",
    emailLogin: config.MAIL_MODE,
    emailSignup: config.EMAIL_SIGNUP,
  }));
  app.get("/api/editorial", listEditorial);
  app.get("/api/editorial/:slug", async (req) => {
    const { slug } = z
      .object({
        slug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(80),
      })
      .parse(req.params);
    return getEditorial(slug);
  });
  app.get("/api/auth/email/current", async (req) => {
    if (config.MAIL_MODE === "disabled" || !req.cookies.polka_email_challenge)
      return null;
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
      retryAfter: Math.max(
        0,
        Math.ceil(
          (new Date(pending.created_at).getTime() + 60000 - Date.now()) / 1000,
        ),
      ),
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
  app.post(
    "/api/auth/email/verify",
    { bodyLimit: 2048 },
    async (req, reply) => {
      const input = z
        .object({ id: uuid, code: z.string().regex(/^\d{8}$/) })
        .strict()
        .parse(req.body);
      const token = await verifyEmailLogin(
        input.id,
        input.code,
        req.cookies.polka_email_challenge ?? "",
        req.ip,
      );
      if (req.cookies.polka_session)
        await db.query("DELETE FROM sessions WHERE hash=$1", [
          sha256(req.cookies.polka_session),
        ]);
      reply.setCookie("polka_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.COOKIE_SECURE === "true",
        path: "/",
        maxAge: 604800,
      });
      reply.clearCookie("polka_email_challenge", { path: "/api/auth/email" });
      return { ok: true };
    },
  );
  app.post("/api/login", { bodyLimit: 2048 }, async (req, reply) => {
    const input = z
      .object({
        name: z.string().min(3).max(40),
        password: z.string().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    const token = await signIn(input.name, input.password, req.ip);
    if (req.cookies.polka_session)
      await db.query("DELETE FROM sessions WHERE hash=$1", [
        sha256(req.cookies.polka_session),
      ]);
    reply.setCookie("polka_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.COOKIE_SECURE === "true",
      path: "/",
      maxAge: 604800,
    });
    return { ok: true };
  });
  app.post("/api/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE hash=$1", [
      sha256(req.cookies.polka_session ?? ""),
    ]);
    reply.clearCookie("polka_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (req) => {
    const a = await identity(req);
    return { id: a.id, name: a.name };
  });
  app.post("/api/account/deletion-csrf", async (req) =>
    issueAccountDeletionCsrf(
      await identity(req),
      req.cookies.polka_session ?? "",
    ),
  );
  app.post("/api/account/deletion-plan", async (req) =>
    createAccountDeletionPlan(
      await identity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
    ),
  );
  app.post("/api/account/deletion", async (req, reply) => {
    const result = await confirmAccountDeletion(
      await identity(req),
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
    issueConnectionCsrf(await identity(req), req.cookies.polka_session ?? ""),
  );
  app.post("/api/agent-connections", async (req) =>
    issueAgentConnection(
      await identity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
      req.body,
    ),
  );
  app.get("/api/agent-connections", async (req) =>
    listAgentConnections(await identity(req)),
  );
  app.post("/api/agent-connections/:id/revoke", async (req) =>
    revokeAgentConnection(
      await identity(req),
      req.cookies.polka_session ?? "",
      String(req.headers["x-polka-csrf"] ?? ""),
      id(req),
    ),
  );
  app.get(
    "/api/folders",
    async (req) =>
      (
        await db.query(
          "SELECT id,name FROM folders WHERE tenant_id=$1 ORDER BY name LIMIT 100",
          [(await identity(req)).tenant],
        )
      ).rows,
  );
  app.post("/api/folders", async (req) => {
    const actor = await identity(req),
      input = z
        .object({ name: z.string().trim().min(1).max(80) })
        .strict()
        .parse(req.body);
    return transaction(async (c) => {
      await lockActiveOwnerTenant(c, actor);
      if (
        +(
          await c.query("SELECT count(*) FROM folders WHERE tenant_id=$1", [
            actor.tenant,
          ])
        ).rows[0].count >= 100
      )
        throw new Problem(413, "quota", "В этой сборке доступно до 100 папок.");
      const folder = { id: randomUUID(), name: input.name };
      await c.query("INSERT INTO folders VALUES($1,$2,$3)", [
        folder.id,
        actor.tenant,
        folder.name,
      ]);
      return folder;
    });
  });
  app.get("/api/artifacts", async (req) => {
    const actor = await identity(req);
    const q = z
      .object({
        q: z.string().max(160).default(""),
        folderId: uuid.optional(),
        cursor: z.string().max(200).optional(),
      })
      .parse(req.query);
    const cursor = decodeCursor(
      q.cursor,
      "Обновите список: указатель страницы некорректен.",
    );
    const { rows } = await db.query(
      `SELECT id,updated_at,
              to_char(updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
       FROM artifacts
       WHERE tenant_id=$1 AND trashed_at IS NULL
         AND ($2::uuid IS NULL OR folder_id=$2)
         AND title ILIKE $3
         AND ($4::timestamptz IS NULL OR (updated_at,id)<($4,$5::uuid))
       ORDER BY updated_at DESC,id DESC LIMIT 25`,
      [
        actor.tenant,
        q.folderId ?? null,
        `%${q.q.replace(/[\\%_]/g, "\\$&")}%`,
        cursor?.date ?? null,
        cursor?.id ?? null,
      ],
    );
    const more = rows.length > 24,
      page = rows.slice(0, 24),
      last = page.at(-1);
    const items = (
      await getArtifacts(
        actor,
        page.map((artifact) => artifact.id),
      )
    ).filter((artifact) => artifact.trashedAt === null);
    return {
      items,
      nextCursor: more ? encodeCursor(last.cursor_updated_at, last.id) : null,
    };
  });
  app.get("/api/artifacts/:id", async (req) =>
    getArtifact(await identity(req), id(req)),
  );
  app.get("/api/trash", async (req) => {
    const actor = await identity(req);
    const query = z
      .object({ cursor: z.string().max(200).optional() })
      .strict()
      .parse(req.query);
    const cursor = decodeCursor(
      query.cursor,
      "Обновите корзину: указатель страницы некорректен.",
    );
    const { rows } = await db.query(
      `SELECT id,
              to_char(trashed_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_trashed_at
       FROM artifacts
       WHERE tenant_id=$1 AND trashed_at IS NOT NULL
         AND ($2::timestamptz IS NULL OR (trashed_at,id)<($2,$3::uuid))
       ORDER BY trashed_at DESC,id DESC LIMIT 25`,
      [actor.tenant, cursor?.date ?? null, cursor?.id ?? null],
    );
    const more = rows.length > 24;
    const page = rows.slice(0, 24);
    const last = page.at(-1);
    const items = (
      await getArtifacts(
        actor,
        page.map((artifact) => artifact.id),
      )
    ).filter((artifact) => artifact.trashedAt !== null);
    return {
      items,
      nextCursor:
        more && last ? encodeCursor(last.cursor_trashed_at, last.id) : null,
    };
  });
  app.post("/api/artifacts/:id/trash", async (req) =>
    transitionOwnerArtifactLifecycle(
      await identity(req),
      id(req),
      req.body,
      "trashed",
    ),
  );
  app.post("/api/artifacts/:id/restore", async (req) =>
    transitionOwnerArtifactLifecycle(
      await identity(req),
      id(req),
      req.body,
      "active",
    ),
  );
  app.patch("/api/artifacts/:id", async (req) =>
    updateArtifactMetadata(await identity(req), id(req), req.body),
  );
  app.get("/api/artifacts/:id/revisions", async (req) => {
    const actor = await identity(req);
    await getArtifact(actor, id(req));
    return (
      await db.query(
        `SELECT r.*,${inlineBuildSelect}
         FROM revisions r WHERE artifact_id=$1 ORDER BY number DESC LIMIT 100`,
        [id(req)],
      )
    ).rows.map(revisionDTO);
  });
  app.post("/api/uploads", async (req) =>
    beginUpload(await identity(req), req.body),
  );
  // Runs before the body is read. The session is checked first, so requests
  // without one never hold a slot, and one shelf cannot take all of them.
  let transfers = 0;
  const tenantTransfers = new Map<string, number>();
  const transferGuard = async (req: any, reply: any) => {
    const { tenant } = await identity(req);
    const mine = tenantTransfers.get(tenant) ?? 0;
    if (transfers >= TRANSFER_SLOTS.total || mine >= TRANSFER_SLOTS.perTenant)
      throw new Problem(
        429,
        "quota",
        "Сервер принимает несколько файлов. Повторите через минуту.",
      );
    transfers++;
    tenantTransfers.set(tenant, mine + 1);
    reply.raw.once("close", () => {
      transfers--;
      const left = (tenantTransfers.get(tenant) ?? 1) - 1;
      if (left > 0) tenantTransfers.set(tenant, left);
      else tenantTransfers.delete(tenant);
    });
  };
  app.put(
    "/api/uploads/:id/bytes",
    { onRequest: transferGuard },
    async (req) => {
      if (!Buffer.isBuffer(req.body))
        throw new Problem(
          415,
          "invalid",
          "Файл должен передаваться отдельным двоичным запросом.",
        );
      return uploadBytes(await identity(req), id(req), req.body);
    },
  );
  app.post("/api/uploads/:id/finalize", async (req) =>
    finalizeUpload(await identity(req), id(req)),
  );
  app.get("/api/uploads/:id", async (req) => {
    return uploadStatus(await identity(req), id(req), "single");
  });
  app.delete("/api/uploads/:id", async (req) =>
    abortUpload(await identity(req), id(req), "single"),
  );
  app.post("/api/bundle-uploads", { bodyLimit: 64 * 1024 }, async (req) =>
    beginBundleUpload(await identity(req), req.body),
  );
  app.put(
    "/api/bundle-uploads/:id/files/:index",
    { onRequest: transferGuard },
    async (req) => {
      if (!Buffer.isBuffer(req.body))
        throw new Problem(
          415,
          "invalid",
          "Файл пакета должен передаваться отдельным двоичным запросом.",
        );
      const index = z.coerce
        .number()
        .int()
        .min(0)
        .max(63)
        .parse((req.params as any).index);
      return uploadBundleFile(await identity(req), id(req), index, req.body);
    },
  );
  app.post("/api/bundle-uploads/:id/finalize", async (req) =>
    finalizeBundleUpload(await identity(req), id(req)),
  );
  app.get("/api/bundle-uploads/:id", async (req) =>
    uploadStatus(await identity(req), id(req), "bundle"),
  );
  app.delete("/api/bundle-uploads/:id", async (req) =>
    abortUpload(await identity(req), id(req), "bundle"),
  );
  // Owner download and export stay available in the trash (docs/TRASH_SPEC.md:
  // R17 export); only /document, which renders the page, refuses a trashed one.
  app.get("/api/revisions/:id/bytes", async (req, reply) => {
    const actor = await identity(req);
    const {
      rows: [r],
    } = await db.query("SELECT * FROM revisions WHERE id=$1 AND tenant_id=$2", [
      id(req),
      actor.tenant,
    ]);
    if (!r) throw missing();
    reply
      .type(r.mime)
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
      );
    return readBlob(r.object_key, r.object_version);
  });
  app.get("/api/revisions/:id/export", async (req, reply) => {
    const revisionId = id(req);
    const result = await exportRevision(await identity(req), revisionId);
    reply
      .type("application/json; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${revisionId}.polka-bundle.json`,
      );
    return result;
  });
  app.get("/api/revisions/:id/build-inline", async (req) =>
    getInlineBuildStatus(await identity(req), id(req)),
  );
  app.post("/api/revisions/:id/build-inline", async (req, reply) => {
    const result = await buildInlineRevision(await identity(req), id(req));
    if (result.concurrent) reply.code(202);
    return result.status;
  });
  // Only a single-domain install (no viewer) shows saved HTML on the app
  // origin; with a viewer the static view is served there (static-viewer.ts)
  // and these routes answer 404. Even here the page never runs as the app:
  // the response itself carries a sandbox CSP, so even a direct navigation
  // runs no scripts and has no network.
  // A browser that says it is opening the page top-level is refused too: the
  // page belongs inside Полка's frame, and on its own at a Полка URL it could
  // pose as a Полка screen. Browsers without Fetch Metadata still get the frame.
  const sendHtml = async (req: any, reply: any, r: any) => {
    if (config.HTML_LIVE_ENABLED) throw missing();
    if (req.headers["sec-fetch-dest"] === "document") throw missing();
    if (
      !r ||
      r.mime !== "text/html" ||
      r.html_profile === "unsupported" ||
      (r.storage_kind === "bundle" && !isStaticSingleFileBundle(r))
    )
      throw missing();
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", STATIC_HTML_CSP)
      .header("cross-origin-resource-policy", "same-origin");
    return withNewTabLinks(
      withSignedAwayLinks(
        await readBlob(r.object_key, r.object_version),
        new URL(req.url, config.APP_ORIGIN).href,
      ),
    );
  };
  // Where the static frame loads from: the viewer (a 60-second grant) when
  // there is one, else the app routes below. The web app asks here first.
  app.post("/api/revisions/:id/static-view", async (req) => {
    const actor = await identity(req);
    const revisionId = id(req);
    if (!config.HTML_LIVE_ENABLED)
      return { url: `/api/revisions/${revisionId}/document` };
    return issueOwnerStaticView(
      actor,
      req.cookies.polka_session ?? "",
      revisionId,
      withComments(req),
    );
  });
  app.post("/api/view/static-view", async (req) => {
    const grant = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (config.HTML_LIVE_ENABLED)
      return issueRecipientStaticView(grant, withComments(req));
    if (!/^[A-Za-z0-9_-]{43}$/.test(grant)) throw missing();
    return { url: `/api/view/${grant}/document` };
  });
  // The "you are leaving Полка" page asks what a signed link points to. It
  // never redirects: the page names the address and the reader clicks.
  app.post("/api/away", { bodyLimit: 32 * 1024 }, async (req) => {
    const { token } = z
      .object({ token: z.string().max(20000) })
      .strict()
      .parse(req.body);
    const target = verifyAwayToken(token);
    if (!target)
      throw new Problem(
        404,
        "not_found",
        "Ссылка устарела или повреждена. Полка открывает внешний адрес только по ссылке из страницы на Полке.",
      );
    return target;
  });
  app.get("/api/revisions/:id/document", async (req, reply) => {
    const actor = await identity(req);
    const {
      rows: [r],
    } = await db.query("SELECT * FROM revisions WHERE id=$1 AND tenant_id=$2", [
      id(req),
      actor.tenant,
    ]);
    if (
      r &&
      !(
        await db.query(
          "SELECT 1 FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL",
          [r.artifact_id, actor.tenant],
        )
      ).rowCount
    )
      throw missing();
    return sendHtml(req, reply, r);
  });
  app.post("/api/revisions/:id/live-view", async (req) => {
    const actor = await identity(req);
    return issueOwnerLiveView(
      actor,
      req.cookies.polka_session ?? "",
      id(req),
      withComments(req),
    );
  });
  app.post("/api/artifacts/:id/share", async (req) => {
    return enableOwnerShare(await identity(req), id(req), req.body);
  });
  app.post("/api/shares/:id/revoke", async (req) => {
    return revokeOwnerShare(await identity(req), id(req));
  });
  app.post("/api/shares/:id/publish", async (req) => {
    return publishOwnerShare(await identity(req), id(req), req.body);
  });
  app.post("/api/resolve", async (req) => {
    const { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    await limitAttempts(`resolve:ip:${req.ip}`, RESOLVE_LIMIT_PER_IP);
    // Read locks: resolve only issues a grant, so concurrent views of one
    // shelf do not queue behind each other, while trash, revoke, disable and
    // deletion (which hold these rows FOR UPDATE) still serialize with it and
    // are rechecked once they commit.
    return transaction(async (c) => {
      const tokenHash = sha256(token);
      const candidate = (
        await c.query(
          `SELECT share.id,share.tenant_id,share.artifact_id,
                  account.id AS account_id,
                  (account.created_at IS NOT NULL
                    AND account.created_at>now()-$2*interval '1 day') AS author_is_new
           FROM shares share
           JOIN tenants tenant ON tenant.id=share.tenant_id
           JOIN accounts account ON account.id=tenant.owner_id
           WHERE share.token_hash=$1 AND NOT account.disabled
             AND account.deletion_requested_at IS NULL`,
          [tokenHash, config.NEW_ACCOUNT_DAYS],
        )
      ).rows[0];
      if (!candidate) throw missing();
      await lockActiveOwnerTenant(
        c,
        { id: candidate.account_id, tenant: candidate.tenant_id },
        missing,
        "SHARE",
      );
      const artifact = (
        await c.query(
          "SELECT title FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR SHARE",
          [candidate.artifact_id, candidate.tenant_id],
        )
      ).rows[0];
      if (!artifact) throw missing();
      const s = (
        await c.query(
          `SELECT * FROM shares
           WHERE id=$1 AND token_hash=$2 AND artifact_id=$3
             AND tenant_id=$4 AND NOT revoked AND expires_at>now()
           FOR SHARE`,
          [candidate.id, tokenHash, candidate.artifact_id, candidate.tenant_id],
        )
      ).rows[0];
      if (!s) throw missing();
      await assertEditorialShareAccessible(c, s.id);
      // Held for review or paused after reports: the recipient learns only
      // that, never the title or the content, and gets no grant.
      if (s.moderation !== "none") return { review: true as const };
      const editorial = !!(
        await c.query(
          "SELECT 1 FROM editorial_publications WHERE share_id=$1",
          [s.id],
        )
      ).rowCount;
      const view = await issueShareGrant(c, s, candidate.artifact_id);
      return {
        title: artifact.title ?? "Работа",
        ...view,
        publisher: editorial ? ("editorial" as const) : ("user" as const),
        authorIsNew: !editorial && candidate.author_is_new === true,
      };
    });
  });
  const granted = async (grant: string) => {
    const revision = (
      await db.query(
        `SELECT r.*,
           s.id AS authorized_share_id,
           g.derivative_id AS granted_derivative_id,
           CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
             'state',d.state,'runtimeProfile',d.runtime_profile,'reason',NULL,'path',NULL
           ) END AS inline_build
         FROM grants g
         JOIN shares s ON s.id=g.share_id
         JOIN revisions r ON r.id=g.revision_id
         JOIN artifacts a ON a.id=r.artifact_id AND a.id=s.artifact_id
         JOIN tenants tenant ON tenant.id=s.tenant_id
         JOIN accounts account ON account.id=tenant.owner_id
         LEFT JOIN revision_derivatives d ON d.id=g.derivative_id AND d.revision_id=g.revision_id
         WHERE g.hash=$1 AND g.expires_at>now() AND NOT s.revoked AND s.expires_at>now()
           AND a.trashed_at IS NULL
           AND NOT account.disabled AND account.deletion_requested_at IS NULL
           AND (
             ((r.storage_kind='single' OR ${staticSingleFileBundleSql("r")})
               AND g.derivative_id IS NULL)
             OR
             ($2::boolean AND r.storage_kind IN ('single','bundle') AND d.state='ready'
               AND d.source_manifest_sha256=r.manifest_sha256
               AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
               AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL})
           )`,
        [sha256(grant), config.HTML_LIVE_ENABLED],
      )
    ).rows[0];
    if (revision)
      await assertEditorialShareAccessible(db, revision.authorized_share_id);
    return revision;
  };
  app.get("/api/view/bytes", async (req, reply) => {
    const r = await granted(
      req.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    if (!r) throw missing();
    // A link bound to an interactive version, and a page the static view
    // refuses, never hand the recipient the raw upload (as sendHtml).
    if (
      r.storage_kind === "bundle" ||
      r.granted_derivative_id ||
      r.html_profile === "unsupported"
    )
      throw missing();
    reply
      .type(r.mime)
      .header("content-security-policy", "sandbox; default-src 'none'");
    return readBlob(r.object_key, r.object_version);
  });
  app.post("/api/view/live-view", async (req) =>
    issueRecipientLiveView(
      req.headers.authorization?.replace(/^Bearer /, "") ?? "",
      withComments(req),
    ),
  );
  // An iframe cannot send Authorization, so the short-lived (60 s), revision-bound
  // grant travels in the path. It is not the share token and dies with revoke.
  app.get("/api/view/:grant/document", async (req, reply) => {
    const { grant } = z
      .object({ grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(req.params);
    return sendHtml(req, reply, await granted(grant));
  });
  app.post("/api/reports", { bodyLimit: 4096 }, async (req) =>
    reportShare(req.body, req.ip),
  );
  registerModerationRoutes(app);
  registerCommentRoutes(app);
  await registerOAuthRoutes(app);
  await registerMcpTransport(app);
  await registerPublishApi(app);
  return app;
}
