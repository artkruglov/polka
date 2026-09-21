import type { FastifyInstance, FastifyRequest } from "fastify";
import { uuid } from "../../packages/contracts/index.ts";
import type { Actor } from "./artifacts.ts";
import {
  changeTemplateLibraryMemberRole,
  acceptTemplateLibraryInvitation,
  createTemplateLibraryInvitation,
  createTemplateLibrary,
  listTemplateLibraries,
  listTemplateLibraryMembers,
  listTemplateLibraryPublications,
  listTemplateLibraryInvitations,
  listTemplateLibraryEvents,
  publishTemplateLibraryRelease,
  revokeTemplateLibraryMember,
  revokeTemplateLibraryInvitation,
  withdrawTemplateLibraryPublication,
} from "./template-libraries.ts";
import {
  issueLibraryLiveView,
  prepareLibraryLiveView,
} from "./template-library-viewer.ts";

export function registerTemplateLibraryRoutes(
  app: FastifyInstance,
  identity: (request: FastifyRequest) => Promise<Actor>,
) {
  const params = (request: FastifyRequest) => {
    const value = request.params as Record<string, unknown>;
    return {
      libraryId: uuid.parse(value.libraryId),
      accountId:
        value.accountId === undefined ? undefined : uuid.parse(value.accountId),
      publicationId:
        value.publicationId === undefined
          ? undefined
          : uuid.parse(value.publicationId),
      invitationId:
        value.invitationId === undefined
          ? undefined
          : uuid.parse(value.invitationId),
    };
  };
  app.post("/api/template-libraries", { bodyLimit: 2048 }, (request) =>
    identity(request).then((actor) =>
      createTemplateLibrary(actor, request.body),
    ),
  );
  app.get("/api/template-libraries", (request) =>
    identity(request).then(listTemplateLibraries),
  );
  app.get("/api/template-libraries/:libraryId/members", (request) =>
    identity(request).then((actor) =>
      listTemplateLibraryMembers(actor, params(request).libraryId),
    ),
  );
  app.get("/api/template-libraries/:libraryId/events", (request) =>
    identity(request).then((actor) =>
      listTemplateLibraryEvents(
        actor,
        params(request).libraryId,
        request.query,
      ),
    ),
  );
  app.patch(
    "/api/template-libraries/:libraryId/members/:accountId",
    { bodyLimit: 2048 },
    (request) => {
      const p = params(request);
      return identity(request).then((actor) =>
        changeTemplateLibraryMemberRole(
          actor,
          p.libraryId,
          p.accountId!,
          request.body,
        ),
      );
    },
  );
  app.post(
    "/api/template-libraries/:libraryId/members/:accountId/revoke",
    (request) => {
      const p = params(request);
      return identity(request).then((actor) =>
        revokeTemplateLibraryMember(actor, p.libraryId, p.accountId!),
      );
    },
  );
  app.get("/api/template-libraries/:libraryId/publications", (request) =>
    identity(request).then((actor) =>
      listTemplateLibraryPublications(actor, params(request).libraryId),
    ),
  );
  app.post(
    "/api/template-libraries/:libraryId/invitations",
    { bodyLimit: 2048 },
    (request) =>
      identity(request).then((actor) =>
        createTemplateLibraryInvitation(
          actor,
          params(request).libraryId,
          request.body,
        ),
      ),
  );
  app.get("/api/template-libraries/:libraryId/invitations", (request) =>
    identity(request).then((actor) =>
      listTemplateLibraryInvitations(actor, params(request).libraryId),
    ),
  );
  app.post(
    "/api/template-libraries/:libraryId/invitations/:invitationId/revoke",
    (request) => {
      const p = params(request);
      return identity(request).then((actor) =>
        revokeTemplateLibraryInvitation(actor, p.libraryId, p.invitationId!),
      );
    },
  );
  app.post(
    "/api/template-libraries/:libraryId/invitations/accept",
    { bodyLimit: 2048 },
    (request) =>
      identity(request).then((actor) =>
        acceptTemplateLibraryInvitation(
          actor,
          params(request).libraryId,
          request.body,
        ),
      ),
  );
  app.post(
    "/api/template-libraries/:libraryId/publications",
    { bodyLimit: 2048 },
    (request) =>
      identity(request).then((actor) =>
        publishTemplateLibraryRelease(
          actor,
          params(request).libraryId,
          request.body,
        ),
      ),
  );
  app.post(
    "/api/template-libraries/:libraryId/publications/:publicationId/prepare-live-view",
    { bodyLimit: 2048 },
    async (request, reply) => {
      const p = params(request);
      const body = request.body as Record<string, unknown>;
      const result = await prepareLibraryLiveView(await identity(request), {
        libraryId: p.libraryId,
        publicationId: p.publicationId!,
        artifactId: uuid.parse(body?.artifactId),
        revisionId: uuid.parse(body?.revisionId),
      });
      if (result.concurrent) reply.code(202);
      return result;
    },
  );
  app.post(
    "/api/template-libraries/:libraryId/publications/:publicationId/live-view",
    { bodyLimit: 2048 },
    async (request, reply) => {
      const p = params(request);
      const body = request.body as Record<string, unknown>;
      const result = await issueLibraryLiveView(
        await identity(request),
        request.cookies.polka_session ?? "",
        {
          libraryId: p.libraryId,
          publicationId: p.publicationId!,
          artifactId: uuid.parse(body?.artifactId),
          revisionId: uuid.parse(body?.revisionId),
        },
      );
      if (result.status === "preparation_required") reply.code(409);
      return result;
    },
  );
  app.post(
    "/api/template-libraries/:libraryId/publications/:publicationId/withdraw",
    { bodyLimit: 2048 },
    (request) => {
      const p = params(request);
      return identity(request).then((actor) =>
        withdrawTemplateLibraryPublication(
          actor,
          p.libraryId,
          p.publicationId!,
          request.body,
        ),
      );
    },
  );
}
