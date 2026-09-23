import { z } from "zod";
import { uuid } from "./index.ts";

/**
 * Comments and reactions on the text of a shared work
 * (docs/specs/COMMENTS.md). Shared by the server, the web app and the
 * agent tools: limits, the fixed reaction set and the wire shapes.
 */

/** A comment body, in characters (code points). */
export const COMMENT_MAX_CHARS = 2000;
/** New comments on one link per day. */
export const COMMENTS_PER_SHARE_PER_DAY = 200;
/** Comments and reactions of one author per hour. */
export const COMMENT_ACTIONS_PER_AUTHOR_PER_HOUR = 60;
/** Letters about comments to one address per day. */
export const COMMENT_MAIL_PER_ADDRESS_PER_DAY = 30;
/** Characters of a comment quoted in a letter. */
export const COMMENT_MAIL_EXCERPT = 300;
/** Context kept on each side of a quote. */
export const ANCHOR_CONTEXT_CHARS = 32;
export const ANCHOR_EXACT_MAX = 2000;

export const REACTIONS = ["👍", "👎", "🎉", "🤔", "❤️", "👀", "✅"] as const;
export type Reaction = (typeof REACTIONS)[number];

const noControl = (value: string) =>
  // Tabs and newlines are text; other control and bidi-override characters
  // are not, and could disguise a comment.
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(
    value,
  );

export const anchorSchema = z
  .object({
    exact: z.string().min(1).max(ANCHOR_EXACT_MAX).refine(noControl),
    prefix: z.string().max(ANCHOR_CONTEXT_CHARS * 2).refine(noControl).default(""),
    suffix: z.string().max(ANCHOR_CONTEXT_CHARS * 2).refine(noControl).default(""),
  })
  .strict()
  .refine((anchor) => anchor.exact.trim().length > 0, {
    message: "The quote is empty",
  });
export type CommentAnchor = z.infer<typeof anchorSchema>;

export const commentBody = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .refine((value) => value.length > 0, { message: "Напишите комментарий." })
  .refine((value) => [...value].length <= COMMENT_MAX_CHARS, {
    message: `Комментарий \u2014 до ${COMMENT_MAX_CHARS} символов.`,
  })
  .refine(noControl, { message: "Уберите управляющие символы." });

const shareToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * The name shown under a person's comments, chosen before the first one:
 * everyone with the link sees it. Not an address.
 */
export const commentName = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .refine((value) => value.length >= 1 && [...value].length <= 40, {
    message: "Имя — от 1 до 40 символов.",
  })
  .refine(noControl, { message: "Уберите управляющие символы." })
  .refine((value) => !value.includes("@"), {
    message: "Имя не должно быть адресом почты.",
  });
export const commentSettingsSchema = z
  .object({
    displayName: commentName.optional(),
    commentMail: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.displayName !== undefined || value.commentMail !== undefined,
  );
export const commentMailOffSchema = z
  .object({ token: z.string().max(400) })
  .strict();

/** A recipient's request: the link's own token identifies the thread set. */
export const sharedCommentsSchema = z.object({ token: shareToken }).strict();
const commentFields = {
  body: commentBody,
  /** Required before an account's first comment (see commentName). */
  displayName: commentName.optional(),
  anchor: anchorSchema.nullable().optional(),
  parentId: uuid.optional(),
};
const replyHasNoQuote = (value: { parentId?: string; anchor?: unknown }) =>
  !(value.parentId && value.anchor);
const noQuoteMessage = { message: "A reply has no quote of its own" };
/** A recipient writes in the thread set of the link they opened. */
export const sharedCreateCommentSchema = z
  .object({ token: shareToken, ...commentFields })
  .strict()
  .refine(replyHasNoQuote, noQuoteMessage);
/** The owner writes in the thread set of one of the work's links. */
export const ownerCreateCommentSchema = z
  .object({ shareId: uuid, ...commentFields })
  .strict()
  .refine(replyHasNoQuote, noQuoteMessage);
const reactFields = {
  emoji: z.enum(REACTIONS),
  anchor: anchorSchema.nullable().optional(),
};
export const sharedReactSchema = z
  .object({ token: shareToken, ...reactFields })
  .strict();
export const ownerReactSchema = z
  .object({ shareId: uuid, ...reactFields })
  .strict();
export const sharedCommentActionSchema = z
  .object({ token: shareToken, commentId: uuid })
  .strict();
export const sharedResolveSchema = z
  .object({
    token: shareToken,
    commentId: uuid,
    resolved: z.boolean().default(true),
  })
  .strict();
export const resolveSchema = z
  .object({ resolved: z.boolean().default(true) })
  .strict();

export type CommentAuthor = {
  /** Display name; never an address. */
  name: string;
  /** The work's owner (the shelf the link belongs to). */
  owner: boolean;
  /** The person asking. */
  me: boolean;
};

export type CommentView = {
  id: string;
  parentId: string | null;
  author: CommentAuthor | null;
  /** Plain text: shown as text, never as HTML; links are not clickable. */
  body: string;
  anchor: CommentAnchor | null;
  /** The fragment signature (reactions on the same fragment share it); "" without a quote. */
  sig: string;
  revisionId: string;
  revisionNumber: number;
  createdAt: string;
  resolvedAt: string | null;
  deleted: boolean;
  /** Waits for the operator: visible to its author and the owner only. */
  held: boolean;
  canDelete: boolean;
  canResolve: boolean;
};

export type CommentThread = CommentView & { replies: CommentView[] };

export type ReactionGroup = {
  /** '' for the whole work, else the fragment's signature. */
  sig: string;
  anchor: CommentAnchor | null;
  emoji: Reaction;
  count: number;
  mine: boolean;
};

export type ShareDiscussion = {
  shareId: string;
  /** The version the link shows now; anchors of other versions may be lost. */
  revisionId: string;
  revisionNumber: number;
  state: "active" | "revoked" | "expired";
  threads: CommentThread[];
  reactions: ReactionGroup[];
};

/** The person asking, as far as comments are concerned. */
export type CommentViewer = {
  signedIn: boolean;
  name: string | null;
  owner: boolean;
  /** The name under comments was chosen; until then a comment asks for it. */
  nameChosen: boolean;
  /** Letters about comments are on. */
  commentMail: boolean;
};

/** What a link's recipient gets. */
export type SharedComments = ShareDiscussion & { viewer: CommentViewer };

/** What the owner gets on the work page: every link of the work. */
export type WorkComments = {
  artifactId: string;
  unread: number;
  shares: ShareDiscussion[];
  viewer: CommentViewer;
};

/** Structured refusal of a patch edit (HTTP 422 / tool error). */
export type EditFailure = {
  code: "edit_failed";
  editIndex: number;
  otherEditIndex?: number;
  reason:
    | "empty_old_text"
    | "not_found"
    | "ambiguous"
    | "overlap"
    | "no_change";
  occurrences?: number;
  message: string;
};

export const editSchema = z
  .object({
    oldText: z.string().max(1_000_000),
    newText: z.string().max(1_000_000),
  })
  .strict();
export const editsSchema = z.array(editSchema).min(1).max(50);
