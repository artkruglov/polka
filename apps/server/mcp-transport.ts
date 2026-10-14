import { createMcpHandler, type AuthInfo, type McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { markAuthenticated } from "./admission.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { authenticateServiceToken, MCP_AUDIENCE, type ServiceActor } from "./service-auth.ts";
import { createMcpServer } from "./mcp-server.ts";
import { PROTECTED_RESOURCE_METADATA_URL } from "./oauth.ts";
import { log } from "./log.ts";

const endpoint = new URL(MCP_AUDIENCE);
const MCP_BODY_LIMIT = 8 * 1024 * 1024;
/**
 * Requests per 10 minutes, as for the publish API; every MCP message is one
 * request. Claude.ai and ChatGPT call from shared platform addresses, so the
 * address cap counts only requests without a valid token.
 */
export const MCP_LIMITS = { perIp: 600, perConnection: 300 };
// RFC 9728 §5.1: point OAuth clients at the protected resource metadata.
const challenge = (error?: string) =>
  `Bearer ${error ? `error="${error}", ` : ""}resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`;

/** A refusal before the body is read: the connection closes instead of waiting for it. */
function refuse(reply: FastifyReply, status: number, body: object) {
  const declared = Number(reply.request.headers["content-length"] ?? 0);
  if (declared > 0 || reply.request.headers["transfer-encoding"] !== undefined) reply.header("connection", "close");
  return reply.code(status).send(body);
}

function actorFromAuth(authInfo?: AuthInfo) {
  const actor = authInfo?.extra?.serviceActor as ServiceActor | undefined;
  if (!actor) throw new Error("MCP service actor is missing");
  return actor;
}

export async function registerMcpTransport(app: FastifyInstance) {
  const handler = createMcpHandler(({ authInfo }) => createMcpServer(actorFromAuth(authInfo)), { legacy: "stateless" });
  const securedHandler = {
    async fetch(request: Request, options?: McpHandlerRequestOptions) {
      const response = await handler.fetch(request, options);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
  const nodeHandler = toNodeHandler(securedHandler, {
    onerror: () => log.error({ event: "mcp.transport.failed" }),
  });
  // The token is checked before the body is read (onRequest): a request
  // without a valid one is refused unread (admission.ts has the budget).
  const actors = new WeakMap<object, ServiceActor>();
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.host !== endpoint.host) return refuse(reply, 403, { code: "forbidden" });
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.APP_ORIGIN) return refuse(reply, 403, { code: "forbidden" });
    const authorization = request.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    const unauthenticated = () => limitAttempts(`mcp:ip:${request.ip}`, MCP_LIMITS.perIp);
    if (!match) {
      await unauthenticated();
      return refuse(reply.header("www-authenticate", challenge()), 401, { code: "unauthorized" });
    }
    let actor: ServiceActor;
    try {
      actor = await authenticateServiceToken(match[1], MCP_AUDIENCE);
    } catch {
      await unauthenticated();
      return refuse(reply.header("www-authenticate", challenge("invalid_token")), 401, { code: "unauthorized" });
    }
    await limitAttempts(`mcp:connection:${actor.rootConnectionId ?? actor.connectionId}`, MCP_LIMITS.perConnection);
    actors.set(request.raw, actor);
    markAuthenticated(request);
  };
  await app.register(async (mcp) => {
    mcp.all("/mcp", { bodyLimit: MCP_BODY_LIMIT, onRequest: authenticate }, async (request, reply) => {
      const actor = actors.get(request.raw);
      if (!actor) throw new Error("MCP request reached the handler without a checked token");
      const auth: AuthInfo = {
        token: "[redacted]",
        clientId: actor.connectionId,
        scopes: actor.scopes,
        expiresAt: actor.expiresAt,
        resource: endpoint,
        extra: { serviceActor: actor },
      };
      Object.assign(request.raw, { auth });
      reply.hijack();
      await nodeHandler(request.raw, reply.raw, request.body);
    });
  });
  app.addHook("onClose", async () => handler.close());
}
