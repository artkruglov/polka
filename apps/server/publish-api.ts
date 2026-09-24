import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HTML_PROFILES, uuid } from "../../packages/contracts/index.ts";
import { prepareInteractive, publishFromAgent } from "./agent-publish.ts";
import { reviseWithEdits } from "./agent-edits.ts";
import { editsSchema } from "../../packages/contracts/comments.ts";
import { db } from "./db.ts";
import { moveShareFromAgent } from "./shares.ts";
import { issueSignInLink } from "./agent-sign-in-links.ts";
import { artifactStatusForAgent } from "./agent-management.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
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
]);
/** The machine routes of this API: bearer only, exempt from the browser Origin rule. */
export const isPublishApiPath = (pathname: string) =>
  PUBLISH_API_PATHS.has(pathname) ||
  /^\/api\/v1\/works\/[0-9a-f-]{36}\/edits$/i.test(pathname);

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
export const PUBLISH_API_LIMITS = { perIp: 300, perConnection: 120 };
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
    folderId: uuid.nullable(),
    updatedAt: z.iso.datetime(),
    trashedAt: z.iso.datetime().nullable(),
    lifecycleVersion: z.number().int(),
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

/** Bearer only: cookies are never read, and a browser Origin other than Полка (or an extension) is refused. */
async function bearerActor(req: FastifyRequest, reply: FastifyReply) {
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
  let actor: ServiceActor;
  try {
    actor = await authenticateServiceToken(
      match[1],
      MCP_AUDIENCE,
      undefined,
      "http",
    );
  } catch {
    await unauthenticated();
    throw unauthorized(reply, "invalid_token");
  }
  await limitAttempts(
    `api-v1:connection:${actor.connectionId}`,
    PUBLISH_API_LIMITS.perConnection,
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
  app.post(
    "/api/v1/publish",
    { bodyLimit: PUBLISH_BODY_LIMIT },
    async (req, reply) => {
      const actor = await bearerActor(req, reply);
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
}
