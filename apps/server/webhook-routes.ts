import type { FastifyInstance } from "fastify";
import { SHELF, id, strongIdentity } from "./route-helpers.ts";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
  rotateWebhookSecret,
  updateWebhook,
} from "./webhooks.ts";

/** Webhooks of the open shelf (docs/specs/WEBHOOKS.md): its owner, or an admin of a department shelf. */
export function registerWebhookRoutes(app: FastifyInstance) {
  app.get("/api/webhooks", async (req) => listWebhooks(await strongIdentity(req, SHELF)));
  app.post("/api/webhooks", { bodyLimit: 8192 }, async (req) =>
    createWebhook(await strongIdentity(req, SHELF), req.body),
  );
  app.patch("/api/webhooks/:id", { bodyLimit: 8192 }, async (req) =>
    updateWebhook(await strongIdentity(req, SHELF), id(req), req.body),
  );
  app.delete("/api/webhooks/:id", async (req) => deleteWebhook(await strongIdentity(req, SHELF), id(req)));
  app.post("/api/webhooks/:id/rotate", async (req) => rotateWebhookSecret(await strongIdentity(req, SHELF), id(req)));
  app.post("/api/webhooks/:id/ping", async (req) => pingWebhook(await strongIdentity(req, SHELF), id(req)));
  app.get("/api/webhooks/:id/deliveries", async (req) =>
    listWebhookDeliveries(await strongIdentity(req, SHELF), id(req)),
  );
}
