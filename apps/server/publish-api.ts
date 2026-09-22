import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { publishFromAgent } from "./agent-publish.ts";
import { artifactStatusForAgent } from "./agent-management.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
  type ServiceActor,
} from "./service-auth.ts";

/**
 * Plain HTTP publishing for anything that can send a request: company agents,
 * CI jobs, the CLI in scripts/polka-publish.mjs. The same agent tokens and
 * scopes as /mcp, the same publishFromAgent, no cookies.
 */
export const PUBLISH_API_PATHS = new Set(["/api/v1/publish"]);
export const PUBLISH_API_LIMITS = { perIp: 300, perConnection: 120 };
const PUBLISH_BODY_LIMIT = 8 * 1024 * 1024;
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

/** Bearer only: cookies are never read, and a browser Origin other than Полка is refused. */
async function bearerActor(req: FastifyRequest, reply: FastifyReply) {
  // Counted before authentication, so guessing tokens is limited too.
  await limitAttempts(`api-v1:ip:${req.ip}`, PUBLISH_API_LIMITS.perIp);
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== config.APP_ORIGIN)
    throw new Problem(
      403,
      "forbidden",
      "API вызывается с сервера, а не со страницы в браузере.",
    );
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
    req.headers.authorization ?? "",
  );
  if (!match) throw unauthorized(reply);
  let actor: ServiceActor;
  try {
    actor = await authenticateServiceToken(match[1], MCP_AUDIENCE);
  } catch {
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
    ...("linkUnavailableReason" in result && result.linkUnavailableReason
      ? { linkUnavailableReason: result.linkUnavailableReason }
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
