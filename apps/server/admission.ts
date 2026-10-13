import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
import { isPublishApiPath, preauthenticateBearer } from "./publish-api.ts";

/**
 * Admission of request bodies, before Fastify reads one. A parsed body (JSON,
 * or application/octet-stream as one Buffer) is held whole in memory, so two
 * things are decided while only the headers have arrived:
 *
 * 1. A bearer-only route (the HTTP API and agent sessions; /mcp checks its
 *    own token, mcp-transport.ts) checks the token
 *    first. Without a valid one the answer is 401 and the body is never read:
 *    twenty anonymous 64 MiB transcripts no longer take 1.3 GB.
 * 2. One server-wide budget of body bytes in flight (BODY_BYTES_IN_FLIGHT_MB).
 *    A request reserves its Content-Length (or its route's bodyLimit when the
 *    length is not declared) until its response ends; past the budget the
 *    answer is 503 with Retry-After. A route that streams its body to the
 *    store (config.streamedBody, a project's video) holds no buffer and is
 *    not counted.
 *
 * A refused request's connection is closed, so the rest of its body is not
 * waited for.
 */
let budget = config.BODY_BYTES_IN_FLIGHT_MB * 1024 * 1024;
let inFlight = 0;
let refused = 0;

/** The body bytes now admitted; `bytes` changes the budget (tests). */
export function bodyBudget(bytes?: number) {
  if (bytes !== undefined) budget = Math.max(1, bytes);
  return { budget, inFlight, refused };
}

const declaredLength = (req: FastifyRequest) => {
  const header = req.headers["content-length"];
  if (header !== undefined) {
    const length = Number(header);
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
  }
  // Chunked: the size is known only once it has arrived; its route's limit bounds it.
  return req.headers["transfer-encoding"] !== undefined ? null : 0;
};

/** Bearer-only routes: their token is checked before the body is read. */
// Not an extension's machine routes: they may authenticate otherwise (SCIM has its own token).
const bearerOnly = (pathname: string) => isPublishApiPath(pathname);

function admitBody(req: FastifyRequest, reply: FastifyReply, declared: number | null) {
  const limit = req.routeOptions.bodyLimit ?? 0;
  const bytes = Math.max(1, declared === null ? limit : Math.min(declared, limit || declared));
  // A request alone is always let in: the budget bounds many, not one.
  if (inFlight > 0 && inFlight + bytes > budget) {
    refused++;
    throw new Problem(
      503,
      "busy",
      "Полка сейчас принимает много данных одновременно. Повторите запрос через несколько секунд.",
    ).retryIn(5);
  }
  inFlight += bytes;
  reply.raw.once("close", () => {
    inFlight -= bytes;
  });
}

export function registerAdmission(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    const declared = declaredLength(req);
    if (declared === 0) return;
    try {
      const pathname = new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname;
      if (bearerOnly(pathname)) await preauthenticateBearer(req, reply);
      if (!req.routeOptions.config?.streamedBody) admitBody(req, reply, declared);
    } catch (error) {
      // Do not sit through the rest of a body that will never be read.
      reply.header("connection", "close");
      throw error;
    }
  });
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route streams its body (no buffering parser): not counted by admission.ts. */
    streamedBody?: boolean;
  }
}
