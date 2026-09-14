import statics from "@fastify/static";
import type { FastifyInstance } from "fastify";
export async function registerFrontend(app: FastifyInstance, root: string) {
  // Resolve files at request time: a rebuilt asset may not have existed at boot.
  await app.register(statics, { root, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    if (
      path === "/" ||
      path === "/s" ||
      path === "/bring" ||
      /^\/works\/[a-f0-9-]{36}$/.test(path) ||
      /^\/discover(?:\/[a-z0-9-]+)?$/.test(path)
    )
      return reply.sendFile("index.html");
    return reply
      .code(404)
      .send({ code: "not_found", message: "Действие недоступно." });
  });
}
