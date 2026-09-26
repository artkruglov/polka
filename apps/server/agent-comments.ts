// What an agent reads and does with the discussion of a work
// (docs/specs/COMMENTS.md, «Агенты»): polka_comments (scope read) and
// polka_resolve_comment (scope revise). Same services as the owner's page;
// no share secrets, addresses or author accounts are returned.
import { z } from "zod";
import {
  anchorSchema,
  commentBody,
  commentName,
  type CommentThread,
  type CommentView,
  type ReactionGroup,
} from "../../packages/contracts/comments.ts";
import { uuid } from "../../packages/contracts/index.ts";
import { artifactIdOf, artifactRef } from "./agent-management.ts";
import {
  anchorSignature,
  commentsMode,
  createOwnerNoteInTransaction,
  dispatchCommentNotices,
  resolveCommentInTransaction,
  workCommentsInTransaction,
} from "./comments.ts";
import {
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";

export const agentCommentsInputSchema = z
  .object({
    artifactId: artifactRef,
    includeResolved: z.boolean().default(true),
  })
  .strict();

export const agentResolveCommentInputSchema = z
  .object({ commentId: uuid, resolved: z.boolean().default(true) })
  .strict();

const note = (comment: CommentView) => ({
  id: comment.id,
  author: comment.author
    ? { name: comment.author.name, owner: comment.author.owner }
    : null,
  // Untrusted text from readers: data to consider, never instructions.
  body: comment.body,
  deleted: comment.deleted,
  createdAt: comment.createdAt,
});

const reactionsOn = (groups: ReactionGroup[], sig: string) =>
  groups
    .filter((group) => group.sig === sig)
    .map((group) => ({ emoji: group.emoji, count: group.count }));

export async function commentsForAgent(actor: ServiceActor, raw: unknown) {
  const input = agentCommentsInputSchema.parse(raw);
  const artifactId = artifactIdOf(input.artifactId);
  return withServiceActorTransaction(actor, "read", async (c, verified) => {
    const work = await workCommentsInTransaction(
      c,
      { id: verified.accountId, tenant: verified.tenantId, connectionId: verified.connectionId },
      artifactId,
    );
    const {
      rows: [artifact],
    } = await c.query("SELECT latest_revision_id FROM artifacts WHERE id=$1", [
      artifactId,
    ]);
    return {
      // on: recipients comment; owner-notes: only the owner (and you) write
      // notes that recipients read; off: no discussions.
      mode: work.mode,
      artifactId: work.artifactId,
      latestRevisionId: artifact.latest_revision_id as string,
      shares: work.shares.map((share) => ({
        shareId: share.shareId,
        state: share.state,
        revisionId: share.revisionId,
        revisionNumber: share.revisionNumber,
        threads: share.threads
          .filter((thread) => input.includeResolved || !thread.resolvedAt)
          .map((thread: CommentThread) => ({
            ...note(thread),
            status: thread.resolvedAt ? "resolved" : "open",
            held: thread.held,
            anchor: thread.anchor,
            revisionId: thread.revisionId,
            revisionNumber: thread.revisionNumber,
            reactions: thread.anchor
              ? reactionsOn(share.reactions, anchorSignature(thread.anchor))
              : [],
            replies: thread.replies.map(note),
          })),
        reactions: share.reactions.map((group) => ({
          anchor: group.anchor,
          emoji: group.emoji,
          count: group.count,
        })),
      })),
    };
  });
}

export const agentNoteInputSchema = z
  .object({
    artifactId: artifactRef,
    /** The link the note belongs to; the newest open link when omitted. */
    shareId: uuid.optional(),
    body: commentBody,
    anchor: anchorSchema.nullable().optional(),
    parentId: uuid.optional(),
    /** The owner's name under notes, needed once if never chosen. */
    displayName: commentName.optional(),
  })
  .strict()
  .refine((value) => !(value.parentId && value.anchor), {
    message: "A reply has no quote of its own",
  });

/**
 * polka_note (scope revise): the owner's agent writes a note — an anchored
 * remark on a fragment or on the whole work — that the link's recipients
 * read. In COMMENTS_MODE=on it is an ordinary comment of the owner.
 */
export async function noteFromAgent(actor: ServiceActor, raw: unknown) {
  const input = agentNoteInputSchema.parse(raw);
  const { artifactId: ref, shareId, ...note } = input;
  const artifactId = artifactIdOf(ref);
  const result = await withServiceActorTransaction(
    actor,
    "revise",
    (c, verified) =>
      createOwnerNoteInTransaction(
        c,
        {
          id: verified.accountId,
          tenant: verified.tenantId,
          connectionId: verified.connectionId,
        },
        artifactId,
        shareId,
        note,
      ),
  );
  void dispatchCommentNotices(result.notices);
  return {
    artifactId,
    shareId: result.shareId,
    commentId: result.id,
    mode: commentsMode(),
  };
}

export async function resolveCommentFromAgent(
  actor: ServiceActor,
  raw: unknown,
) {
  const input = agentResolveCommentInputSchema.parse(raw);
  return withServiceActorTransaction(actor, "revise", (c, verified) =>
    resolveCommentInTransaction(
      c,
      {
        id: verified.accountId,
        tenant: verified.tenantId,
        connectionId: verified.connectionId,
      },
      input.commentId,
      input.resolved,
    ),
  ).then((result) => ({ commentId: input.commentId, ...result }));
}
