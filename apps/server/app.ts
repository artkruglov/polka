import { registerAgentContext } from "./agent-context.ts";
import { registerTemplateLibraryRoutes } from "./template-library-routes.ts";
import { registerUrlImports } from "./url-import/routes.ts";
import { beginEmailLogin, verifyEmailLogin } from "./email-auth.ts";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { identity, signIn } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import { reportShare } from "./reports.ts";
import { STATIC_HTML_CSP, withNewTabLinks } from "./html.ts";
import {
  isStaticSingleFileBundle,
  staticSingleFileBundleSql,
} from "./revision-manifest.ts";
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
  BUNDLE_RUNTIME_PROFILE,
  SERVED_BUILDER_VERSIONS_SQL,
  isServedBuilderVersion,
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
      "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'self'${config.HTML_LIVE_ENABLED ? ` ${config.VIEWER_ORIGIN}` : ""}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    });
    const pathname = new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname;
    // /mcp and the OAuth machine endpoints are cookie-less server-to-server
    // surfaces with their own authentication; browser routes keep this check.
    if (
      pathname !== "/mcp" &&
      !OAUTH_MACHINE_PATHS.has(pathname) &&
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
        .send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        code: "invalid",
        message: "Проверьте формат и обязательные поля.",
      });
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
  registerUrlImports(app, identity);
  registerAgentContext(app, identity);
  registerTemplateLibraryRoutes(app, identity);
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
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
        .object({ id: uuid, code: z.string().regex(/^\d{6}$/) })
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
    let cursor: { date: string; id: string } | null = null;
    if (q.cursor) {
      try {
        cursor = z
          .object({ date: z.string().datetime(), id: uuid })
          .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
      } catch {
        throw new Problem(
          400,
          "invalid",
          "Обновите список: указатель страницы некорректен.",
        );
      }
    }
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
      await Promise.all(page.map((artifact) => getArtifact(actor, artifact.id)))
    ).filter((artifact) => artifact.trashedAt === null);
    return {
      items,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              date: last.cursor_updated_at,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
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
    let cursor: { date: string; id: string } | null = null;
    if (query.cursor) {
      try {
        cursor = z
          .object({ date: z.string().datetime(), id: uuid })
          .parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
      } catch {
        throw new Problem(
          400,
          "invalid",
          "Обновите корзину: указатель страницы некорректен.",
        );
      }
    }
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
      await Promise.all(page.map((artifact) => getArtifact(actor, artifact.id)))
    ).filter((artifact) => artifact.trashedAt !== null);
    return {
      items,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({ date: last.cursor_trashed_at, id: last.id }),
            ).toString("base64url")
          : null,
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
  let transfers = 0;
  const transferGuard = async (_req: any, reply: any) => {
    if (transfers >= 4)
      throw new Problem(
        429,
        "quota",
        "Сервер принимает несколько файлов. Повторите через минуту.",
      );
    transfers++;
    reply.raw.once("close", () => transfers--);
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
  // Saved HTML is never rendered in the app origin: the response itself carries
  // a sandbox CSP, so even a direct navigation runs no scripts and has no network.
  const sendHtml = async (reply: any, r: any) => {
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
    return withNewTabLinks(await readBlob(r.object_key, r.object_version));
  };
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
    return sendHtml(reply, r);
  });
  app.post("/api/revisions/:id/live-view", async (req) => {
    const actor = await identity(req);
    return issueOwnerLiveView(actor, req.cookies.polka_session ?? "", id(req));
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
    return transaction(async (c) => {
      const tokenHash = sha256(token);
      const candidate = (
        await c.query(
          `SELECT share.id,share.tenant_id,share.artifact_id,
                  account.id AS account_id
           FROM shares share
           JOIN tenants tenant ON tenant.id=share.tenant_id
           JOIN accounts account ON account.id=tenant.owner_id
           WHERE share.token_hash=$1 AND NOT account.disabled
             AND account.deletion_requested_at IS NULL`,
          [tokenHash],
        )
      ).rows[0];
      if (!candidate) throw missing();
      await lockActiveOwnerTenant(c, {
        id: candidate.account_id,
        tenant: candidate.tenant_id,
      });
      const artifact = (
        await c.query(
          "SELECT title FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR UPDATE",
          [candidate.artifact_id, candidate.tenant_id],
        )
      ).rows[0];
      if (!artifact) throw missing();
      const s = (
        await c.query(
          `SELECT * FROM shares
           WHERE id=$1 AND token_hash=$2 AND artifact_id=$3
             AND tenant_id=$4 AND NOT revoked AND expires_at>now()
           FOR UPDATE`,
          [candidate.id, tokenHash, candidate.artifact_id, candidate.tenant_id],
        )
      ).rows[0];
      if (!s) throw missing();
      await assertEditorialShareAccessible(c, s.id);
      const r = (
        await c.query(
          `SELECT r.*,
             CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
               'state',d.state,'runtimeProfile',d.runtime_profile,'reason',NULL,'path',NULL
             ) END AS inline_build,
             d.state AS derivative_state,d.source_manifest_sha256 AS derivative_source,
             d.builder_version AS derivative_builder,d.runtime_profile AS derivative_profile
           FROM revisions r
           LEFT JOIN revision_derivatives d ON d.id=$2 AND d.revision_id=r.id
           WHERE r.id=$1 AND r.artifact_id=$3`,
          [s.revision_id, s.derivative_id, candidate.artifact_id],
        )
      ).rows[0];
      // A bundle (other than a lone static page) and any share bound to an
      // interactive version open only through that ready derivative.
      const needsDerivative =
        r?.storage_kind === "bundle"
          ? !(isStaticSingleFileBundle(r) && !s.derivative_id)
          : !!s.derivative_id;
      if (
        !r ||
        (needsDerivative &&
          (!config.HTML_LIVE_ENABLED ||
            !s.derivative_id ||
            r.derivative_state !== "ready" ||
            r.derivative_source !== r.manifest_sha256 ||
            !isServedBuilderVersion(r.derivative_builder) ||
            r.derivative_profile !== BUNDLE_RUNTIME_PROFILE))
      )
        throw missing();
      const grant = randomBytes(32).toString("base64url");
      const g = (
        await c.query(
          "INSERT INTO grants(hash,share_id,revision_id,derivative_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '60 seconds') RETURNING expires_at",
          [sha256(grant), s.id, r.id, s.derivative_id],
        )
      ).rows[0];
      return {
        title: artifact.title ?? "Работа",
        revision: revisionDTO(r),
        grant,
        expiresAt: g.expires_at.toISOString(),
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
               AND d.runtime_profile=$3)
           )`,
        [sha256(grant), config.HTML_LIVE_ENABLED, BUNDLE_RUNTIME_PROFILE],
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
    ),
  );
  // An iframe cannot send Authorization, so the short-lived (60 s), revision-bound
  // grant travels in the path. It is not the share token and dies with revoke.
  app.get("/api/view/:grant/document", async (req, reply) => {
    const { grant } = z
      .object({ grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(req.params);
    return sendHtml(reply, await granted(grant));
  });
  app.post("/api/reports", { bodyLimit: 4096 }, async (req) =>
    reportShare(req.body, req.ip),
  );
  await registerOAuthRoutes(app);
  await registerMcpTransport(app);
  return app;
}
