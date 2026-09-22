import {
  createMcpHandler,
  type AuthInfo,
  type McpHandlerRequestOptions,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance } from "fastify";
import { config } from "./config.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
  type ServiceActor,
} from "./service-auth.ts";
import { createReadonlyMcpServer } from "./mcp-readonly.ts";
import { PROTECTED_RESOURCE_METADATA_URL } from "./oauth.ts";

const endpoint = new URL(MCP_AUDIENCE);
const MCP_BODY_LIMIT = 8 * 1024 * 1024;
// RFC 9728 §5.1: point OAuth clients at the protected resource metadata.
const challenge = (error?: string) =>
  `Bearer ${error ? `error="${error}", ` : ""}resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`;

function actorFromAuth(authInfo?: AuthInfo) {
  const actor = authInfo?.extra?.serviceActor as ServiceActor | undefined;
  if (!actor) throw new Error("MCP service actor is missing");
  return actor;
}

export async function registerMcpTransport(app: FastifyInstance) {
  const handler = createMcpHandler(
    ({ authInfo }) => createReadonlyMcpServer(actorFromAuth(authInfo)),
    { legacy: "stateless" },
  );
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
    onerror: () =>
      console.error(JSON.stringify({ event: "mcp.transport.failed" })),
  });
  await app.register(async (mcp) => {
    mcp.all("/mcp", { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
      if (request.headers.host !== endpoint.host)
        return reply.code(403).send({ code: "forbidden" });
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== config.APP_ORIGIN)
        return reply.code(403).send({ code: "forbidden" });
      const authorization = request.headers.authorization ?? "";
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match)
        return reply
          .header("www-authenticate", challenge())
          .code(401)
          .send({ code: "unauthorized" });
      let actor: ServiceActor;
      try {
        actor = await authenticateServiceToken(match[1], MCP_AUDIENCE);
      } catch {
        return reply
          .header("www-authenticate", challenge("invalid_token"))
          .code(401)
          .send({ code: "unauthorized" });
      }
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
