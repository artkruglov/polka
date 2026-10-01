import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  HTML_PROFILES,
  MAX_BYTES,
  PROJECT_MAX_FILES,
  PROJECT_VIDEO_MAX_FILE_BYTES,
  uuid,
} from "../../packages/contracts/index.ts";
import {
  beginProjectUpload,
  finalizeProjectUpload,
  reuseProjectFiles,
  putProjectFile,
  putProjectMedia,
} from "./project-upload.ts";
import { prepareInteractive, publishFromAgent } from "./agent-publish.ts";
import { reviseWithEdits } from "./agent-edits.ts";
import { workFileForAgent, workFilesForAgent } from "./work-files.ts";
import { editsSchema } from "../../packages/contracts/comments.ts";
import { db } from "./db.ts";
import { moveShareFromAgent } from "./shares.ts";
import { issueSignInLink } from "./agent-sign-in-links.ts";
import { createTaskToken } from "./service-principals.ts";
import { listEventsForAgent } from "./agent-events.ts";
import { artifactStatusForAgent, listArtifactsForAgent } from "./agent-management.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
  PROJECT_UPLOAD_AUDIENCE,
  recheckServiceActor,
  type ServiceActor,
} from "./service-auth.ts";

/**
 * Plain HTTP publishing for anything that can send a request: company agents,
 * CI jobs, the CLI in scripts/polka-publish.mjs. The same agent tokens and
 * scopes as /mcp, the same publishFromAgent, no cookies.
 */
export const PUBLISH_API_PATHS = new Set([
  "/api/v1/publish",
  "/api/v1/sign-in-link",
  "/api/v1/task-token",
]);
/** The machine routes of this API: bearer only, exempt from the browser Origin rule. */
export const isPublishApiPath = (pathname: string) =>
  PUBLISH_API_PATHS.has(pathname) ||
  pathname === "/api/v1/projects" ||
  /^\/api\/v1\/projects\/[0-9a-f-]{36}\/(?:files\/\d{1,3}|media\/\d{1,3}|finalize|reuse)$/i.test(pathname) ||
  /^\/api\/v1\/works\/[0-9a-f-]{36}\/edits$/i.test(pathname);

/** A video file's stream (docs/specs/PROJECT_VIDEO.md): it alone may take minutes to arrive. */
export const MEDIA_UPLOAD_MS = 20 * 60 * 1000;
export const isMediaUploadPath = (url: string) =>
  /^\/api\/v1\/projects\/[0-9a-f-]{36}\/media\/\d{1,3}(?:\?|$)/i.test(url);

export const editsBodySchema = z
  .object({
    key: uuid,
    baseRevisionId: uuid,
    edits: editsSchema,
    path: z.string().min(1).max(200).optional(),
    /** Point the work's open link at the new version (needs link permission). */
    moveLink: z.boolean().default(false),
  })
  .strict();
export const PUBLISH_API_LIMITS = {
  perIp: 300,
  perConnection: 120,
  projectFilesPerConnection: 2 * PROJECT_MAX_FILES,
};
export const PUBLISH_BODY_LIMIT = 8 * 1024 * 1024;

/**
 * Response shapes. /openapi.json is generated from these and from the input
 * schemas the routes parse; tests/publish-api.test.ts checks real responses
 * against them, so the published spec cannot drift from the routes.
 */
export const problemSchema = z
  .object({ code: z.string(), message: z.string() })
  .strict();

export const publishResponseSchema = z
  .object({
    artifactId: uuid,
    revisionId: uuid,
    state: z.enum(["shared", "saved"]),
    url: z.string().url().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    shelfUrl: z.string().url(),
    interactiveReady: z.boolean(),
    scriptsRunForRecipients: z.boolean(),
    moderation: z.enum(["held", "paused", "blocked"]).optional(),
    moderationMessage: z.string().optional(),
    expiresNote: z.string().optional(),
    // a new version (artifactId + baseRevisionId): the work's open link moved to it.
    linkMoved: z.boolean().optional(),
    linkUnavailableReason: z.string().optional(),
    interactiveUnavailableReason: z.string().optional(),
    // saved on a provisional shelf: where the owner claims it to share.
    claimUrl: z.string().url().optional(),
  })
  .strict();

export const statusResponseSchema = z
  .object({
    id: uuid,
    title: z.string(),
    kind: z.enum(["page", "link", "image", "text", "file"]),
    linkHost: z.string().optional(),
    folderId: uuid.nullable(),
    folderName: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    trashedAt: z.iso.datetime().nullable(),
    lifecycleVersion: z.number().int(),
    shelfId: uuid,
    ownerAccountId: uuid.nullable(),
    acceptedRevisionId: uuid.nullable(),
    revision: z
      .object({
        id: uuid,
        number: z.number().int(),
        filename: z.string(),
        mime: z.string(),
        size: z.number().int(),
        totalSize: z.number().int(),
        storageKind: z.enum(["single", "bundle"]),
        htmlProfile: z.enum(HTML_PROFILES).nullable(),
        inlineBuild: z
          .object({
            state: z.enum(["pending", "ready", "unsupported", "failed"]),
            runtimeProfile: z.string().nullable(),
          })
          .strict()
          .nullable(),
        createdAt: z.iso.datetime(),
      })
      .strict(),
    shelfUrl: z.string().url(),
  })
  .strict();
export const signInLinkResponseSchema = z
  .object({
    /** hint: /signin?shelf=… without a secret; link: /enter#token (provisional). */
    kind: z.enum(["hint", "link"]),
    url: z.string().url(),
    expiresAt: z.iso.datetime(),
    expiresInSeconds: z.number().int(),
    instructions: z.string(),
  })
  .strict();
export const editsResponseSchema = z
  .object({
    artifactId: uuid,
    previousRevisionId: uuid,
    revisionId: uuid,
    number: z.number().int(),
    htmlProfile: z.enum(HTML_PROFILES).nullable(),
    shelfUrl: z.string().url(),
    interactiveReady: z.boolean().optional(),
    interactiveUnavailableReason: z.string().optional(),
    link: z
      .object({
        moved: z.boolean(),
        reason: z.string().optional(),
        shareId: uuid.optional(),
        artifactId: uuid.optional(),
        revisionId: uuid.optional(),
        derivativeId: uuid.nullable().optional(),
        expiresAt: z.iso.datetime().optional(),
        state: z.enum(["active", "closed"]).optional(),
        url: z.string().url().nullable().optional(),
        moderation: z.enum(["held", "paused", "blocked"]).optional(),
        moderationMessage: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 422: the patch cannot be applied; editIndex names the failing edit. */
export const editProblemSchema = z
  .object({
    code: z.literal("edit_failed"),
    message: z.string(),
    editIndex: z.number().int().min(0),
    otherEditIndex: z.number().int().min(0).optional(),
    reason: z.enum([
      "empty_old_text",
      "not_found",
      "ambiguous",
      "overlap",
      "no_change",
    ]),
    occurrences: z.number().int().optional(),
  })
  .strict();

/** 409: the edits were written against an older version. */
export const baseMismatchSchema = z
  .object({
    code: z.literal("conflict"),
    message: z.string(),
    currentRevisionId: uuid,
  })
  .strict();

const CLI_SOURCE = new URL("../../scripts/polka-publish.mjs", import.meta.url);
const PROJECT_CLI_SOURCE = new URL("../../scripts/polka-publish-project.mjs", import.meta.url);
const PULL_CLI_SOURCE = new URL("../../scripts/polka-pull.mjs", import.meta.url);

const unauthorized = (reply: FastifyReply, error?: "invalid_token") => {
  reply.header(
    "www-authenticate",
    `Bearer realm="polka"${error ? `, error="${error}"` : ""}`,
  );
  return new Problem(
    401,
    "unauthorized",
    error
      ? "Токен агента недействителен, истёк или отозван."
      : "Нужен заголовок Authorization: Bearer <токен агента>.",
  );
};

/**
 * A browser extension's own pages and service worker (the «На Полку»
 * extension, extensions/chrome): Chrome sends this Origin on their requests.
 * They are not web pages, hold the token themselves and read no cookies of
 * Полка, so the rule against pages on other sites does not apply to them.
 */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * Bearer only: cookies are never read, and a browser Origin other than Полка
 * (or an extension) is refused. A project's files are counted apart: one
 * project may hold PROJECT_MAX_FILES of them (docs/specs/PROJECTS.md).
 */
async function bearerActor(
  req: FastifyRequest,
  reply: FastifyReply,
  bucket: "calls" | "project-files" = "calls",
  // The project routes also take a one-time project upload token.
  audiences: readonly string[] = [MCP_AUDIENCE],
) {
  // Only requests without a valid token count per address: agents on hosted
  // platforms share addresses. A valid token has its connection's cap.
  const unauthenticated = () =>
    limitAttempts(`api-v1:ip:${req.ip}`, PUBLISH_API_LIMITS.perIp);
  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    origin !== config.APP_ORIGIN &&
    !EXTENSION_ORIGIN.test(origin)
  )
    throw new Problem(
      403,
      "forbidden",
      "API вызывается с сервера, а не со страницы в браузере.",
    );
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
    req.headers.authorization ?? "",
  );
  if (!match) {
    await unauthenticated();
    throw unauthorized(reply);
  }
  let actor: ServiceActor | null = null;
  for (const audience of audiences) {
    actor = await authenticateServiceToken(
      match[1],
      audience,
      undefined,
      "http",
    ).catch(() => null);
    if (actor) break;
  }
  if (!actor) {
    await unauthenticated();
    throw unauthorized(reply, "invalid_token");
  }
  await limitAttempts(
    bucket === "calls"
      ? `api-v1:connection:${actor.rootConnectionId ?? actor.connectionId}`
      : `api-v1:project-files:${actor.connectionId}`,
    bucket === "calls"
      ? PUBLISH_API_LIMITS.perConnection
      : PUBLISH_API_LIMITS.projectFilesPerConnection,
  );
  return actor;
}

/** Name the fields that failed instead of the generic form message. */
function invalidFields(error: z.ZodError) {
  const fields = [
    ...new Set(error.issues.map((issue) => issue.path.join(".") || "body")),
  ];
  return new Problem(
    400,
    "invalid",
    `Проверьте поля запроса: ${fields.join(", ")}.`,
  );
}

async function withFieldErrors<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidFields(error);
    throw error;
  }
}

type PublishResult = Awaited<ReturnType<typeof publishFromAgent>>;

function publishResponse(result: PublishResult) {
  const shared = "expiresAt" in result ? result : null;
  return {
    artifactId: result.artifactId,
    revisionId: result.revisionId,
    state: result.state,
    url: result.url,
    expiresAt: shared?.expiresAt ?? null,
    shelfUrl: result.shelfUrl,
    interactiveReady:
      "interactiveReady" in result ? !!result.interactiveReady : false,
    scriptsRunForRecipients: result.scriptsRunForRecipients,
    // "held": the link exists, recipients see a review screen until the
    // Полка moderator approves it; moderationMessage says so to a human.
    ...(shared && "moderation" in shared
      ? {
          moderation: shared.moderation,
          moderationMessage: shared.moderationMessage,
        }
      : {}),
    ...(shared && "expiresNote" in shared && shared.expiresNote
      ? { expiresNote: shared.expiresNote }
      : {}),
    ...(shared && "linkMoved" in shared && shared.linkMoved
      ? { linkMoved: true }
      : {}),
    ...("linkUnavailableReason" in result && result.linkUnavailableReason
      ? { linkUnavailableReason: result.linkUnavailableReason }
      : {}),
    // A provisional shelf: where the owner claims it to hand out links.
    ...("claimUrl" in result && result.claimUrl
      ? { claimUrl: result.claimUrl }
      : {}),
    ...("interactiveUnavailableReason" in result &&
    result.interactiveUnavailableReason
      ? { interactiveUnavailableReason: result.interactiveUnavailableReason }
      : {}),
  };
}

export async function registerPublishApi(app: FastifyInstance) {
  // Projects and single pages or components from disk take the short upload
  // token too (polka_project_upload), so an agent never pastes a file into
  // a tool argument.
  const PROJECT_AUDIENCES = [MCP_AUDIENCE, PROJECT_UPLOAD_AUDIENCE];
  app.post(
    "/api/v1/publish",
    { bodyLimit: PUBLISH_BODY_LIMIT },
    async (req, reply) => {
      const actor = await bearerActor(req, reply, "calls", PROJECT_AUDIENCES);
      return publishResponse(
        await withFieldErrors(() => publishFromAgent(actor, req.body ?? {})),
      );
    },
  );
  // A one-time link back into this shelf for the agent's owner
  // (agent-sign-in-links.ts): OAuth connections only, 5 minutes, one use.
  app.post(
    "/api/v1/sign-in-link",
    { bodyLimit: 1024 },
    async (req, reply) => {
      const actor = await bearerActor(req, reply);
      return signInLinkResponseSchema.parse(await issueSignInLink(actor));
    },
  );
  // Projects (docs/specs/PROJECTS.md): a folder of linked pages, file by file.
  app.post("/api/v1/projects", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const actor = await bearerActor(req, reply, "calls", PROJECT_AUDIENCES);
    return withFieldErrors(() => beginProjectUpload(actor, req.body ?? {}));
  });
  app.put(
    "/api/v1/projects/:uploadId/files/:index",
    { bodyLimit: MAX_BYTES },
    async (req, reply) => {
      const actor = await bearerActor(req, reply, "project-files", PROJECT_AUDIENCES);
      const params = z
        .object({
          uploadId: uuid,
          index: z.coerce.number().int().min(0).max(PROJECT_MAX_FILES - 1),
        })
        .parse(req.params);
      if (!Buffer.isBuffer(req.body))
        throw new Problem(415, "invalid", "Send the file as application/octet-stream.");
      return putProjectFile(actor, params.uploadId, params.index, req.body);
    },
  );
  // A video file (docs/specs/PROJECT_VIDEO.md): its bytes are streamed to the
  // store as they arrive, never held whole, so this route takes the body raw.
  await app.register(async (media) => {
    // Encapsulated: the app's buffering parser stays for every other route.
    media.removeContentTypeParser("application/octet-stream");
    media.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
      done(null, payload),
    );
    media.put(
      "/api/v1/projects/:uploadId/media/:index",
      { bodyLimit: PROJECT_VIDEO_MAX_FILE_BYTES },
      async (req, reply) => {
        try {
          const actor = await bearerActor(req, reply, "project-files", PROJECT_AUDIENCES);
          const params = z
            .object({
              uploadId: uuid,
              index: z.coerce.number().int().min(0).max(PROJECT_MAX_FILES - 1),
            })
            .parse(req.params);
          if (!req.headers["content-length"])
            throw new Problem(411, "invalid", "Укажите Content-Length: размер видео известен заранее.");
          return await putProjectMedia(actor, params.uploadId, params.index, req.body as Readable);
        } catch (error) {
          // Refused, maybe before a byte was read: do not sit through the rest of a
          // 200 MB body (this route alone may take 20 minutes to receive one).
          reply.header("connection", "close");
          throw error;
        }
      },
    );
  });
  // polka push: the files a new version keeps unchanged are copied, not sent.
  app.post("/api/v1/projects/:uploadId/reuse", async (req, reply) => {
    const actor = await bearerActor(req, reply, "calls", PROJECT_AUDIENCES);
    return reuseProjectFiles(actor, uuid.parse((req.params as { uploadId: string }).uploadId));
  });
  // The shelf of the token: list, search, and "what changed since" (read scope).
  app.get("/api/v1/works", async (req, reply) => {
    const actor = await bearerActor(req, reply);
    const q = z
      .object({
        query: z.string().optional(),
        since: z.string().optional(),
        cursor: z.string().optional(),
        folderId: z.string().optional(),
        state: z.string().optional(),
        limit: z.coerce.number().optional(),
        // Several shelves: ids separated by commas.
        shelfIds: z.string().optional(),
      })
      .strict()
      .parse(req.query ?? {});
    const { shelfIds, ...rest } = q;
    return withFieldErrors(() =>
      listArtifactsForAgent(actor, { ...rest, ...(shelfIds ? { shelfIds: shelfIds.split(",") } : {}) } as never),
    );
  });
  // A service account asks for a short token for one job.
  app.post("/api/v1/task-token", async (req, reply) => {
    const actor = await bearerActor(req, reply);
    return withFieldErrors(() => createTaskToken(actor, req.body));
  });
  // What happened to the works of the token's shelf, polled by cursor (read).
  app.get("/api/v1/events", async (req, reply) => {
    const actor = await bearerActor(req, reply);
    return withFieldErrors(() => listEventsForAgent(actor, (req.query ?? {}) as never));
  });
  // polka pull: a version's files, listed, then one by one (work-files.ts).
  app.get("/api/v1/works/:artifactId/files", async (req, reply) => {
    const actor = await bearerActor(req, reply, "calls", PROJECT_AUDIENCES);
    const artifactId = uuid.parse((req.params as { artifactId: string }).artifactId);
    const { revisionId } = z
      .object({ revisionId: uuid.optional() })
      .parse(req.query ?? {});
    return withFieldErrors(() => workFilesForAgent(actor, artifactId, revisionId));
  });
  app.get(
    "/api/v1/works/:artifactId/revisions/:revisionId/files/:index",
    async (req, reply) => {
      const actor = await bearerActor(req, reply, "project-files", PROJECT_AUDIENCES);
      const params = z
        .object({
          artifactId: uuid,
          revisionId: uuid,
          index: z.coerce.number().int().min(0).max(PROJECT_MAX_FILES - 1),
        })
        .parse(req.params);
      const file = await workFileForAgent(actor, params.artifactId, params.revisionId, params.index);
      return reply
        .type("application/octet-stream")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("x-polka-sha256", file.sha256)
        .header("content-length", file.size)
        .send("stream" in file ? file.stream : file.bytes);
    },
  );
  app.post("/api/v1/projects/:uploadId/finalize", async (req, reply) => {
    const actor = await bearerActor(req, reply, "calls", PROJECT_AUDIENCES);
    const uploadId = uuid.parse((req.params as { uploadId: string }).uploadId);
    const receipt = await finalizeProjectUpload(actor, uploadId);
    return {
      ...receipt,
      shelfUrl: `${config.APP_ORIGIN}/works/${receipt.artifactId}`,
    };
  });
  app.get("/api/v1/status/:artifactId", async (req, reply) => {
    const actor = await bearerActor(req, reply);
    const artifact = await withFieldErrors(() =>
      artifactStatusForAgent(actor, {
        artifactId: (req.params as { artifactId: string }).artifactId,
      }),
    );
    return {
      ...artifact,
      shelfUrl: `${config.APP_ORIGIN}/works/${artifact.id}`,
    };
  });
  // Patch edits (docs/specs/COMMENTS.md): the same engine and revise path as
  // polka_revise with edits. 422 names the failing edit, 409 the latest
  // version. With moveLink the open link follows, keeping its discussion.
  app.post(
    "/api/v1/works/:artifactId/edits",
    { bodyLimit: PUBLISH_BODY_LIMIT },
    async (req, reply) => {
      const actor = await bearerActor(req, reply);
      const artifactId = uuid.parse(
        (req.params as { artifactId: string }).artifactId,
      );
      const input = await withFieldErrors(async () =>
        editsBodySchema.parse(req.body ?? {}),
      );
      const receipt = await reviseWithEdits(actor, {
        key: input.key,
        artifactId,
        baseRevisionId: input.baseRevisionId,
        edits: input.edits,
        ...(input.path ? { path: input.path } : {}),
      });
      const interactive = await prepareInteractive(
        actor,
        input.key,
        receipt.revisionId,
        receipt.htmlProfile ?? null,
        "revise",
      );
      let link: Record<string, unknown> | null = null;
      if (input.moveLink) {
        const verified = await recheckServiceActor(actor, "context");
        const {
          rows: [open],
        } = await db.query(
          `SELECT id FROM shares WHERE artifact_id=$1 AND tenant_id=$2
             AND NOT revoked AND expires_at>now()`,
          [artifactId, verified.tenantId],
        );
        if (!verified.scopes.includes("share"))
          link = {
            moved: false,
            reason:
              "The token cannot manage links (Управлять ссылками); the link still shows the previous version.",
          };
        else if (!open)
          link = { moved: false, reason: "The work has no open link." };
        else {
          try {
            const moved = await moveShareFromAgent(verified, {
              key: input.key,
              artifactId,
              shareId: open.id,
              expectedRevisionId: receipt.revisionId,
            });
            link = { moved: moved.state === "active", ...moved };
          } catch (error) {
            if (!(error instanceof Problem) || error.status >= 500) throw error;
            link = { moved: false, reason: error.message };
          }
        }
      }
      return {
        artifactId,
        previousRevisionId: input.baseRevisionId,
        revisionId: receipt.revisionId,
        number: receipt.number,
        htmlProfile: receipt.htmlProfile ?? null,
        shelfUrl: `${config.APP_ORIGIN}/works/${artifactId}`,
        ...(interactive
          ? {
              interactiveReady: interactive.ready,
              ...(interactive.reason
                ? { interactiveUnavailableReason: interactive.reason }
                : {}),
            }
          : {}),
        ...(link ? { link } : {}),
      };
    },
  );
  // The dependency-free CLI, downloadable from the installation it talks to
  // and pointed at it by default.
  const cli = (await readFile(CLI_SOURCE, "utf8")).replace(
    /^const DEFAULT_ENDPOINT = ".*";$/m,
    `const DEFAULT_ENDPOINT = ${JSON.stringify(config.APP_ORIGIN)};`,
  );
  app.get("/api/v1/cli/polka-publish.mjs", async (_req, reply) =>
    reply
      .type("text/javascript; charset=utf-8")
      .header("content-disposition", 'attachment; filename="polka-publish.mjs"')
      .send(cli),
  );
  // A folder of linked pages as one project (docs/specs/PROJECTS.md).
  const projectCli = (await readFile(PROJECT_CLI_SOURCE, "utf8")).replace(
    /^const DEFAULT_ENDPOINT = ".*";$/m,
    `const DEFAULT_ENDPOINT = ${JSON.stringify(config.APP_ORIGIN)};`,
  );
  app.get("/api/v1/cli/polka-publish-project.mjs", async (_req, reply) =>
    reply
      .type("text/javascript; charset=utf-8")
      .header("content-disposition", 'attachment; filename="polka-publish-project.mjs"')
      .send(projectCli),
  );
  // A saved version back into a folder (polka pull).
  const pullCli = (await readFile(PULL_CLI_SOURCE, "utf8")).replace(
    /^const DEFAULT_ENDPOINT = ".*";$/m,
    `const DEFAULT_ENDPOINT = ${JSON.stringify(config.APP_ORIGIN)};`,
  );
  app.get("/api/v1/cli/polka-pull.mjs", async (_req, reply) =>
    reply
      .type("text/javascript; charset=utf-8")
      .header("content-disposition", 'attachment; filename="polka-pull.mjs"')
      .send(pullCli),
  );
}
