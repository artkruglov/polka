import {
  createServicePrincipal,
  disableServicePrincipal,
  listServicePrincipals,
  rotateServiceToken,
  setServiceResponsible,
} from "./service-principals.ts";
import type { FastifyInstance } from "fastify";
import { SHELF, id, strongIdentity } from "./route-helpers.ts";

/** Service accounts of the open shelf: cron and CI agents with a person responsible. */
export function registerServiceAccountRoutes(app: FastifyInstance) {
  app.get("/api/service-accounts", async (req) => listServicePrincipals(await strongIdentity(req, SHELF)));
  app.post("/api/service-accounts", { bodyLimit: 4096 }, async (req) =>
    createServicePrincipal(await strongIdentity(req, SHELF), req.body),
  );
  app.post("/api/service-accounts/:id/rotate", { bodyLimit: 1024 }, async (req) =>
    rotateServiceToken(await strongIdentity(req, SHELF), id(req), req.body),
  );
  app.post("/api/service-accounts/:id/disable", async (req) =>
    disableServicePrincipal(await strongIdentity(req, SHELF), id(req)),
  );
  app.put("/api/service-accounts/:id/responsible", { bodyLimit: 1024 }, async (req) =>
    setServiceResponsible(await strongIdentity(req, SHELF), id(req), req.body),
  );
}
