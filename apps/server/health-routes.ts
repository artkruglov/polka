import type { FastifyInstance, FastifyReply } from "fastify";

export type HealthRouteCoordinator = {
  alive: () => boolean;
  ready: () => Promise<boolean>;
};

function statusHeaders(reply: FastifyReply) {
  reply.headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
  });
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  health: HealthRouteCoordinator,
) {
  app.get("/healthz", async (_request, reply) => {
    statusHeaders(reply);
    if (!health.alive()) return reply.code(503).send({ status: "stopping" });
    return reply.send({ status: "alive" });
  });

  app.get("/readyz", async (_request, reply) => {
    statusHeaders(reply);
    let ready = false;
    try {
      ready = health.alive() && (await health.ready());
    } catch {
      // Dependency details remain private; the public endpoint is fail closed.
    }
    if (!ready) return reply.code(503).send({ status: "not_ready" });
    return reply.send({ status: "ready" });
  });
}
