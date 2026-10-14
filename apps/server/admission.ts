import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";
import { isPreauthenticated, isPublishApiPath, preauthenticateBearer } from "./publish-api.ts";

/**
 * Admission of request bodies, before Fastify reads one. A parsed body (JSON,
 * or application/octet-stream as one Buffer) is held whole in memory, so:
 *
 * 1. A bearer-only route (the HTTP API and agent sessions; /mcp checks its
 *    own token, mcp-transport.ts) checks the token
 *    first. Without a valid one the answer is 401 and the body is never read:
 *    twenty anonymous 64 MiB transcripts no longer take 1.3 GB.
 * 2. One server-wide budget of body bytes in flight (BODY_BYTES_IN_FLIGHT_MB).
 *    A request whose token was checked before its body (point 1, or /mcp)
 *    reserves its Content-Length (or its route's bodyLimit when the length is
 *    not declared) until its response ends; past the budget the answer is 503
 *    with Retry-After, before the body is read.
 * 3. Any other request (a browser's, with a cookie checked only after its
 *    body, or one to no route at all) reserves nothing: its bytes are counted
 *    as they arrive, until its response ends. They may take a quarter of the
 *    budget all together and a sixteenth from one client address; a chunk
 *    past either, or past the whole budget, ends the request with 503. So
 *    slow senders that declare large bodies and send a few bytes hold only
 *    those bytes, and anonymous bodies never take the room of checked ones.
 *
 * A request alone in a budget is always let in: the budgets bound many, not
 * one. A route that streams its body to the store (config.streamedBody, a
 * project's video) holds no buffer and is not counted. A refused request's
 * connection is closed, so the rest of its body is not waited for.
 */
let budget = config.BODY_BYTES_IN_FLIGHT_MB * 1024 * 1024;
let inFlight = 0;
let anonymousInFlight = 0;
let refused = 0;
const byAddress = new Map<string, number>();

const anonymousBudget = () => Math.max(1, Math.floor(budget / 4));
const addressBudget = () => Math.max(1, Math.floor(budget / 16));

/** The body bytes now admitted; `bytes` changes the budget (tests). */
export function bodyBudget(bytes?: number) {
  if (bytes !== undefined) budget = Math.max(1, bytes);
  return {
    budget,
    inFlight,
    refused,
    anonymous: { budget: anonymousBudget(), perAddress: addressBudget(), inFlight: anonymousInFlight },
    addresses: byAddress.size,
  };
}

/** Requests whose token was checked before their body (mcp-transport.ts). */
const authenticated = new WeakSet<object>();
export const markAuthenticated = (req: FastifyRequest) => void authenticated.add(req.raw);

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

const busy = () => {
  refused++;
  return new Problem(
    503,
    "busy",
    "Полка сейчас принимает много данных одновременно. Повторите запрос через несколько секунд.",
  ).retryIn(5);
};

/** A checked request: its whole declared size, before a byte is read. */
function reserve(req: FastifyRequest, reply: FastifyReply, declared: number | null) {
  const limit = req.routeOptions.bodyLimit ?? 0;
  const bytes = Math.max(1, declared === null ? limit : Math.min(declared, limit || declared));
  if (inFlight > 0 && inFlight + bytes > budget) throw busy();
  inFlight += bytes;
  reply.raw.once("close", () => {
    inFlight -= bytes;
  });
}

/** Any other request: its bytes as they arrive, under the anonymous budgets. */
function meter(req: FastifyRequest, reply: FastifyReply, payload: NodeJS.ReadableStream) {
  const address = req.ip ?? "";
  let held = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = chunk.length;
      const fromAddress = byAddress.get(address) ?? 0;
      if (
        (inFlight > held && inFlight + bytes > budget) ||
        (anonymousInFlight > held && anonymousInFlight + bytes > anonymousBudget()) ||
        (fromAddress > held && fromAddress + bytes > addressBudget())
      ) {
        reply.header("connection", "close");
        return callback(busy());
      }
      held += bytes;
      inFlight += bytes;
      anonymousInFlight += bytes;
      byAddress.set(address, fromAddress + bytes);
      callback(null, chunk);
    },
  });
  reply.raw.once("close", () => {
    inFlight -= held;
    anonymousInFlight -= held;
    const left = (byAddress.get(address) ?? 0) - held;
    if (left > 0) byAddress.set(address, left);
    else byAddress.delete(address);
    held = 0;
  });
  payload.on("error", (error) => counter.destroy(error));
  payload.pipe(counter);
  return counter;
}

export function registerAdmission(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (declaredLength(req) === 0) return;
    try {
      const pathname = new URL(req.raw.url ?? "/", config.APP_ORIGIN).pathname;
      if (bearerOnly(pathname)) await preauthenticateBearer(req, reply);
    } catch (error) {
      // Do not sit through the rest of a body that will never be read.
      reply.header("connection", "close");
      throw error;
    }
  });
  // After every onRequest hook (a route's own token check included), before the body is read.
  app.addHook("preParsing", async (req, reply, payload) => {
    const declared = declaredLength(req);
    if (declared === 0 || req.routeOptions.config?.streamedBody) return payload;
    if (!isPreauthenticated(req) && !authenticated.has(req.raw)) return meter(req, reply, payload);
    try {
      reserve(req, reply, declared);
    } catch (error) {
      reply.header("connection", "close");
      throw error;
    }
    return payload;
  });
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route streams its body (no buffering parser): not counted by admission.ts. */
    streamedBody?: boolean;
  }
}
