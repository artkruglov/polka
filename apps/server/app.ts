import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { identity, signIn } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import {
  audit,
  beginUpload,
  finalizeUpload,
  getArtifact,
  revisionDTO,
  tokenFor,
  uploadBytes,
} from "./artifacts.ts";
import { readBlob, sha256 } from "./storage.ts";
import {
  MAX_BYTES,
  MIME,
  uuid,
  publishSchema,
  shareSchema,
} from "../../packages/contracts/index.ts";

export async function createApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BYTES,
    requestTimeout: 30000,
    connectionTimeout: 30000,
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
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (
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
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  app.get("/api/capabilities", async () => ({
    profile: "file-v1",
    formats: MIME,
    maxBytes: MAX_BYTES,
    audiences: ["private", "unlisted"],
    htmlRuntime: false,
    identity: "operator-provisioned-local-account",
  }));
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
      await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [
        actor.tenant,
      ]);
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
      `SELECT id,updated_at FROM artifacts WHERE tenant_id=$1 AND ($2::uuid IS NULL OR folder_id=$2) AND title ILIKE $3 AND ($4::timestamptz IS NULL OR (updated_at,id)<($4,$5::uuid)) ORDER BY updated_at DESC,id DESC LIMIT 25`,
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
    return {
      items: await Promise.all(page.map((a) => getArtifact(actor, a.id))),
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              date: last.updated_at.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
    };
  });
  app.get("/api/artifacts/:id", async (req) =>
    getArtifact(await identity(req), id(req)),
  );
  app.get("/api/artifacts/:id/revisions", async (req) => {
    const actor = await identity(req);
    await getArtifact(actor, id(req));
    return (
      await db.query(
        "SELECT * FROM revisions WHERE artifact_id=$1 ORDER BY number DESC LIMIT 100",
        [id(req)],
      )
    ).rows.map(revisionDTO);
  });
  app.post("/api/uploads", async (req) =>
    beginUpload(await identity(req), req.body),
  );
  let transfers = 0;
  app.put(
    "/api/uploads/:id/bytes",
    {
      onRequest: async (_req, reply) => {
        if (transfers >= 4)
          throw new Problem(
            429,
            "quota",
            "Сервер принимает несколько файлов. Повторите через минуту.",
          );
        transfers++;
        reply.raw.once("close", () => transfers--);
      },
    },
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
    const actor = await identity(req);
    const {
      rows: [u],
    } = await db.query(
      "SELECT id,receipt,aborted,expires_at FROM uploads WHERE id=$1 AND tenant_id=$2",
      [id(req), actor.tenant],
    );
    if (!u) throw missing();
    return u;
  });
  app.delete("/api/uploads/:id", async (req) => {
    const actor = await identity(req);
    await db.query(
      "UPDATE uploads SET aborted=true WHERE id=$1 AND tenant_id=$2 AND receipt IS NULL",
      [id(req), actor.tenant],
    );
    return { ok: true };
  });
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
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
      );
    return readBlob(r.object_key, r.object_version);
  });
  app.post("/api/artifacts/:id/share", async (req) => {
    const actor = await identity(req),
      input = shareSchema.parse(req.body),
      artifactId = id(req);
    await transaction(async (c) => {
      const {
        rows: [a],
      } = await c.query(
        "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [artifactId, actor.tenant],
      );
      if (!a) throw missing();
      if (a.latest_revision_id !== input.expectedRevisionId)
        throw new Problem(
          409,
          "conflict",
          "Работа изменилась. Проверьте текущую версию перед отправкой.",
        );
      const existing = (
        await c.query(
          "SELECT * FROM shares WHERE artifact_id=$1 AND NOT revoked AND expires_at>now()",
          [artifactId],
        )
      ).rows[0];
      if (existing) return; // Retrying enable never publishes a newer revision.
      await c.query("UPDATE shares SET revoked=true WHERE artifact_id=$1", [
        artifactId,
      ]);
      const shareId = randomUUID();
      await c.query(
        "INSERT INTO shares(id,tenant_id,artifact_id,revision_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 day')",
        [
          shareId,
          actor.tenant,
          artifactId,
          a.latest_revision_id,
          sha256(tokenFor(shareId)),
          input.expiresInDays,
        ],
      );
      await audit(c, actor, "share.enabled", shareId);
    });
    return getArtifact(actor, artifactId);
  });
  app.post("/api/shares/:id/revoke", async (req) => {
    const actor = await identity(req),
      shareId = id(req);
    await transaction(async (c) => {
      const {
        rows: [s],
      } = await c.query(
        "UPDATE shares SET revoked=true WHERE id=$1 AND tenant_id=$2 AND NOT revoked RETURNING id",
        [shareId, actor.tenant],
      );
      if (s) await audit(c, actor, "share.revoked", shareId);
    });
    return { ok: true };
  });
  app.post("/api/shares/:id/publish", async (req) => {
    const actor = await identity(req),
      input = publishSchema.parse(req.body),
      shareId = id(req);
    return transaction(async (c) => {
      const {
        rows: [s],
      } = await c.query(
        "SELECT * FROM shares WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [shareId, actor.tenant],
      );
      if (!s) throw missing();
      if (s.revoked || new Date(s.expires_at).getTime() <= Date.now())
        throw new Problem(410, "expired", "Ссылка уже закрыта или истекла.");
      if (s.revision_id !== input.expectedPublishedRevisionId)
        throw new Problem(
          409,
          "conflict",
          "Ссылка уже обновлена. Проверьте отправленную версию.",
        );
      if (
        !(
          await c.query(
            "SELECT 1 FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3",
            [input.revisionId, s.artifact_id, actor.tenant],
          )
        ).rowCount
      )
        throw missing();
      await c.query("UPDATE shares SET revision_id=$2 WHERE id=$1", [
        shareId,
        input.revisionId,
      ]);
      await audit(c, actor, "share.published", shareId);
      return { ok: true };
    });
  });
  app.post("/api/resolve", async (req) => {
    const { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    const {
      rows: [s],
    } = await db.query(
      "SELECT s.id,s.revision_id,a.title FROM shares s JOIN artifacts a ON a.id=s.artifact_id WHERE s.token_hash=$1 AND NOT s.revoked AND s.expires_at>now()",
      [sha256(token)],
    );
    if (!s) throw missing();
    const {
      rows: [r],
    } = await db.query("SELECT * FROM revisions WHERE id=$1", [s.revision_id]);
    const grant = randomBytes(32).toString("base64url");
    const {
      rows: [g],
    } = await db.query(
      "INSERT INTO grants VALUES($1,$2,$3,now()+interval '60 seconds') RETURNING expires_at",
      [sha256(grant), s.id, r.id],
    );
    return {
      title: s.title,
      revision: revisionDTO(r),
      grant,
      expiresAt: g.expires_at.toISOString(),
    };
  });
  app.get("/api/view/bytes", async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const {
      rows: [r],
    } = await db.query(
      "SELECT r.* FROM grants g JOIN shares s ON s.id=g.share_id JOIN revisions r ON r.id=g.revision_id WHERE g.hash=$1 AND g.expires_at>now() AND NOT s.revoked AND s.expires_at>now()",
      [sha256(token)],
    );
    if (!r) throw missing();
    reply.type(r.mime);
    return readBlob(r.object_key, r.object_version);
  });
  return app;
}
