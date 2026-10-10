import { readShelfCard, setShelfCard } from "./shelf-card.ts";
import { createTeamShelfInTransaction, shelvesOf } from "./shelves.ts";
import { type FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { assertStrongSession, identity } from "./auth.ts";
import { uuid } from "../../packages/contracts/index.ts";
import {
  adminCompanyShelf,
  findEmployee,
  listCompanyShelfMembers,
  listCompanyShelves,
  offboardEmployee,
} from "./company-admin.ts";
import {
  addShelfMember,
  changeShelfMemberRole,
  listShelfEvents,
  listShelfMembers,
  renameShelf,
  revokeShelfMember,
} from "./shelf-members.ts";
import {
  acceptShelfInvitation,
  createShelfInvitation,
  listShelfInvitations,
  revokeShelfInvitation,
} from "./shelf-invitations.ts";
import { createFolderInTransaction, folderNameSchema } from "./folders.ts";
import type { FastifyInstance } from "fastify";
import { SHELF } from "./route-helpers.ts";

/** Shelves, company administration, members, invitations, the shelf card and folders. */
export function registerShelfRoutes(app: FastifyInstance) {
  // Shelves the account may open (docs/specs/TEAM_SHELVES.md): its own, then
  // department shelves while TEAM_SHELVES is on.
  app.get("/api/shelves", async (req) => {
    const actor = await identity(req);
    const {
      rows: [account],
    } = await db.query("SELECT company_admin FROM accounts WHERE id=$1", [actor.id]);
    return {
      items: await shelvesOf(actor.id),
      // A company admin opens department shelves (TEAM_SHELVES on).
      canCreate: config.TEAM_SHELVES === "on" && Boolean(account?.company_admin),
    };
  });
  app.post("/api/shelves", async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    const input = z
      .object({ name: z.string().max(200) })
      .strict()
      .parse(req.body);
    return transaction((c) => createTeamShelfInTransaction(c, actor, input.name));
  });
  // The company admin's page (company-admin.ts): 404 for everyone else.
  app.get("/api/company/shelves", async (req) => listCompanyShelves(await identity(req)));
  app.get("/api/company/shelves/:shelfId/members", async (req) =>
    listCompanyShelfMembers(await identity(req), uuid.parse((req.params as any).shelfId)),
  );
  app.post("/api/company/shelves/:shelfId/admin", async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return adminCompanyShelf(actor, uuid.parse((req.params as any).shelfId));
  });
  app.get("/api/company/people", async (req) => findEmployee(await identity(req), req.query));
  app.post("/api/company/people/:accountId/offboard", async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return offboardEmployee(actor, uuid.parse((req.params as any).accountId));
  });
  // Members of a department shelf (shelf-members.ts).
  const shelfId = (req: FastifyRequest) => uuid.parse((req.params as any).shelfId);
  app.get("/api/shelves/:shelfId/members", async (req) => listShelfMembers(await identity(req), shelfId(req)));
  app.post("/api/shelves/:shelfId/members", { bodyLimit: 2048 }, async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return addShelfMember(actor, shelfId(req), req.body);
  });
  app.patch("/api/shelves/:shelfId/members/:accountId", { bodyLimit: 2048 }, async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return changeShelfMemberRole(actor, shelfId(req), uuid.parse((req.params as any).accountId), req.body);
  });
  app.post("/api/shelves/:shelfId/members/:accountId/revoke", async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return revokeShelfMember(actor, shelfId(req), uuid.parse((req.params as any).accountId));
  });
  // Invitation links (shelf-invitations.ts): issued by the admin or a
  // curator, accepted by whoever opens the link signed in.
  app.get("/api/shelves/:shelfId/invitations", async (req) => listShelfInvitations(await identity(req), shelfId(req)));
  app.post("/api/shelves/:shelfId/invitations", { bodyLimit: 2048 }, async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return createShelfInvitation(actor, shelfId(req), req.body);
  });
  app.post("/api/shelves/:shelfId/invitations/:invitationId/revoke", async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return revokeShelfInvitation(actor, shelfId(req), uuid.parse((req.params as any).invitationId));
  });
  app.post("/api/shelves/:shelfId/invitations/accept", { bodyLimit: 2048 }, async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return acceptShelfInvitation(actor, shelfId(req), req.body);
  });
  app.patch("/api/shelves/:shelfId", { bodyLimit: 2048 }, async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return renameShelf(actor, shelfId(req), req.body);
  });
  // "How we do things here": the shelf's card, given to agents in polka_context.
  app.get("/api/shelf/card", async (req) => readShelfCard(await identity(req, SHELF)));
  app.put("/api/shelf/card", { bodyLimit: 32768 }, async (req) => {
    const actor = await identity(req, SHELF);
    assertStrongSession(actor);
    return setShelfCard(actor, req.body);
  });
  app.get("/api/shelves/:shelfId/events", async (req) => listShelfEvents(await identity(req), shelfId(req)));
  app.post("/api/folders", async (req) => {
    const actor = await identity(req, SHELF),
      input = z.object({ name: folderNameSchema }).strict().parse(req.body);
    return transaction((c) => createFolderInTransaction(c, actor, input.name));
  });
}
