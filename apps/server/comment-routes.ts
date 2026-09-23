import type { FastifyInstance, FastifyRequest } from "fastify";
import { uuid } from "../../packages/contracts/index.ts";
import {
  ownerCreateCommentSchema,
  ownerReactSchema,
  resolveSchema,
  sharedCommentActionSchema,
  sharedCommentsSchema,
  sharedCreateCommentSchema,
  sharedReactSchema,
  sharedResolveSchema,
} from "../../packages/contracts/comments.ts";
import { identity, limitAttempts } from "./auth.ts";
import {
  createOwnerComment,
  createSharedComment,
  deleteOwnerComment,
  deleteSharedComment,
  markCommentsSeen,
  reactOwner,
  reactShared,
  resolveOwnerComment,
  resolveSharedComment,
  sharedComments,
  workComments,
  type Viewer,
} from "./comments.ts";

/** Reads of a link's threads per client IP per 10 minutes (as /api/resolve). */
export const SHARED_COMMENTS_READS_PER_IP = 600;
const BODY_LIMIT = 16 * 1024;

/** Signed in or not: reading a link's threads needs no account. */
async function optionalViewer(req: FastifyRequest): Promise<Viewer | null> {
  if (!req.cookies.polka_session) return null;
  try {
    return await identity(req);
  } catch {
    return null;
  }
}

// A recipient's routes carry the link token in the POST body, never in the
// URL: it must not reach access logs (the share link keeps it in the
// fragment for the same reason). Every POST passes the app's Origin check.
export function registerCommentRoutes(app: FastifyInstance) {
  const options = { bodyLimit: BODY_LIMIT };
  const id = (req: FastifyRequest) =>
    uuid.parse((req.params as { id?: string }).id);

  app.post("/api/shared/comments", options, async (req) => {
    const { token } = sharedCommentsSchema.parse(req.body);
    await limitAttempts(
      `shared-comments:ip:${req.ip}`,
      SHARED_COMMENTS_READS_PER_IP,
    );
    return sharedComments(token, await optionalViewer(req));
  });
  app.post("/api/shared/comments/create", options, async (req) => {
    const { token, ...input } = sharedCreateCommentSchema.parse(req.body);
    return createSharedComment(token, await optionalViewer(req), input);
  });
  app.post("/api/shared/comments/react", options, async (req) => {
    const input = sharedReactSchema.parse(req.body);
    return reactShared(
      input.token,
      await optionalViewer(req),
      input.emoji,
      input.anchor,
    );
  });
  app.post("/api/shared/comments/delete", options, async (req) => {
    const input = sharedCommentActionSchema.parse(req.body);
    return deleteSharedComment(
      input.token,
      await optionalViewer(req),
      input.commentId,
    );
  });
  app.post("/api/shared/comments/resolve", options, async (req) => {
    const input = sharedResolveSchema.parse(req.body);
    return resolveSharedComment(
      input.token,
      await optionalViewer(req),
      input.commentId,
      input.resolved,
    );
  });

  // The owner: every link of the work.
  app.get("/api/artifacts/:id/comments", async (req) =>
    workComments(await identity(req), id(req)),
  );
  app.post("/api/artifacts/:id/comments/seen", options, async (req) =>
    markCommentsSeen(await identity(req), id(req)),
  );
  app.post("/api/artifacts/:id/comments", options, async (req) => {
    const owner = await identity(req);
    const { shareId, ...input } = ownerCreateCommentSchema.parse(req.body);
    return createOwnerComment(owner, id(req), shareId, input);
  });
  app.post("/api/artifacts/:id/reactions", options, async (req) => {
    const owner = await identity(req);
    const input = ownerReactSchema.parse(req.body);
    return reactOwner(owner, id(req), input.shareId, input.emoji, input.anchor);
  });
  app.post("/api/comments/:id/delete", options, async (req) =>
    deleteOwnerComment(await identity(req), id(req)),
  );
  app.post("/api/comments/:id/resolve", options, async (req) =>
    resolveOwnerComment(
      await identity(req),
      id(req),
      resolveSchema.parse(req.body ?? {}).resolved,
    ),
  );
}
