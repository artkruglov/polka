// Comments and reactions on the text of a shared work (docs/specs/COMMENTS.md).
//
// A thread belongs to one link (share). A recipient reaches the threads of
// the link they opened with its token (never another link's); writing needs
// a signed-in account. The owner reaches the threads of every link of their
// work. Every query is scoped by tenant and share; the locks follow
// /api/resolve and shares.ts: owner tenant → owner account → artifact →
// share, read locks for readers and writers alike (a comment changes no
// shelf state), then the writer's own account.
//
// Bodies are plain text. Nothing here renders HTML; the web app shows the
// text as text and links as text. Authors are shown by display name only.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ANCHOR_CONTEXT_CHARS,
  COMMENT_ACTIONS_PER_AUTHOR_PER_HOUR,
  COMMENTS_PER_SHARE_PER_DAY,
  type CommentAnchor,
  type CommentThread,
  type CommentView,
  type Reaction,
  type ReactionGroup,
  type ShareDiscussion,
  type SharedComments,
  type WorkComments,
} from "../../packages/contracts/comments.ts";
import type { Actor } from "./artifacts.ts";
import { limitAttempts } from "./auth.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import { isSuspicious, SignalCollector } from "./phishing-signals.ts";
import { authorStanding } from "./share-moderation.ts";
import { sha256 } from "./storage.ts";
import {
  dispatchCommentNotices,
  type CommentNotice,
} from "./comment-mail.ts";

export type Viewer = { id: string; name: string; tenant: string };

type Queryable = Pick<PoolClient, "query">;

/** The link and whose it is, locked for the rest of the transaction. */
type ShareContext = {
  share: {
    id: string;
    tenant_id: string;
    artifact_id: string;
    revision_id: string;
    revoked: boolean;
    expires_at: Date;
  };
  ownerId: string;
  title: string;
  /** The link is open: not revoked, not expired, not held or paused. */
  open: boolean;
};

export const signInToComment = () =>
  new Problem(
    401,
    "unauthorized",
    "Войдите по почте, чтобы оставить комментарий.",
  );

const closed = () =>
  new Problem(
    410,
    "expired",
    "Ссылка закрыта: обсуждение по ней больше не принимает комментарии.",
  );

// ---------------------------------------------------------------------------
// Anchors and signals

/** The one fragment signature: reactions group and deduplicate by it. */
export function anchorSignature(anchor: CommentAnchor | null | undefined) {
  if (!anchor) return "";
  return createHash("sha256")
    .update(`${anchor.prefix ?? ""}\u0000${anchor.exact}\u0000${anchor.suffix ?? ""}`)
    .digest("hex");
}

/** Context beyond what the viewer needs is cut; the quote itself is kept. */
function storedAnchor(anchor: CommentAnchor | null | undefined) {
  if (!anchor) return null;
  return {
    exact: anchor.exact,
    prefix: [...(anchor.prefix ?? "")].slice(-ANCHOR_CONTEXT_CHARS).join(""),
    suffix: [...(anchor.suffix ?? "")].slice(0, ANCHOR_CONTEXT_CHARS).join(""),
  };
}

// An address in a comment: a scheme, "www." or a host with a common
// top-level domain. Shown as text only, but it is also a phishing signal.
const LINK =
  /(?:[a-z][a-z0-9+.-]{1,20}:\/\/|www\.|(?<![\p{L}\p{N}@])[a-z0-9-]{2,63}\.(?:ru|рф|com|net|org|io|app|me|info|online|site|xyz|top|su|by|kz|ua|cc|link|page|shop)(?![\p{L}\p{N}]))/iu;

/** The phishing signals of a comment: those of a page, plus links. */
export function commentSignals(body: string) {
  const collector = new SignalCollector();
  collector.secret(body);
  collector.context(body);
  if (LINK.test(body)) collector.add("link:address");
  const signals = collector.list();
  const secret = signals.some((signal) => signal.startsWith("secret:"));
  return {
    signals,
    // A request for a secret next to a brand, urgency or a link.
    suspicious:
      isSuspicious(signals) || (secret && signals.includes("link:address")),
  };
}

// ---------------------------------------------------------------------------
// Locks

async function lockShareByToken(c: PoolClient, token: string) {
  const tokenHash = sha256(token);
  const candidate = (
    await c.query(
      `SELECT share.id,share.tenant_id,share.artifact_id,account.id AS owner_id
       FROM shares share
       JOIN tenants tenant ON tenant.id=share.tenant_id
       JOIN accounts account ON account.id=tenant.owner_id
       WHERE share.token_hash=$1 AND NOT account.disabled
         AND account.deletion_requested_at IS NULL`,
      [tokenHash],
    )
  ).rows[0];
  if (!candidate) throw missing();
  const context = await lockShare(
    c,
    { id: candidate.owner_id, tenant: candidate.tenant_id },
    candidate.artifact_id,
    candidate.id,
    false,
  );
  // A recipient reaches only an open link: revoke, expiry and review close
  // the discussion for them (the owner keeps it).
  if (!context.open) throw missing();
  const bound = await c.query(
    "SELECT 1 FROM shares WHERE id=$1 AND token_hash=$2",
    [candidate.id, tokenHash],
  );
  if (!bound.rowCount) throw missing();
  return context;
}

async function lockShare(
  c: PoolClient,
  owner: Actor,
  artifactId: string,
  shareId: string,
  allowTrashed: boolean,
): Promise<ShareContext> {
  await lockActiveOwnerTenant(c, owner, missing, "SHARE");
  const artifact = (
    await c.query(
      `SELECT title,trashed_at FROM artifacts
       WHERE id=$1 AND tenant_id=$2 FOR SHARE`,
      [artifactId, owner.tenant],
    )
  ).rows[0];
  if (!artifact || (artifact.trashed_at && !allowTrashed)) throw missing();
  const share = (
    await c.query(
      `SELECT id,tenant_id,artifact_id,revision_id,revoked,expires_at,moderation,
         expires_at>now() AS unexpired
       FROM shares WHERE id=$1 AND tenant_id=$2 AND artifact_id=$3 FOR SHARE`,
      [shareId, owner.tenant, artifactId],
    )
  ).rows[0];
  if (!share) throw missing();
  // Links of the editorial catalogue are read by everyone: no comments.
  const editorial = (
    await c.query("SELECT 1 FROM editorial_publications WHERE share_id=$1", [
      share.id,
    ])
  ).rowCount;
  if (editorial) throw missing();
  return {
    share,
    ownerId: owner.id,
    title: artifact.title ?? "Работа",
    open:
      !share.revoked &&
      share.unexpired &&
      share.moderation === "none" &&
      !artifact.trashed_at,
  };
}

/** The writer's account must still be able to act. */
async function lockWriter(c: PoolClient, viewer: Viewer) {
  const account = (
    await c.query(
      `SELECT id FROM accounts
       WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL
       FOR SHARE`,
      [viewer.id],
    )
  ).rows[0];
  if (!account) throw signInToComment();
}

// ---------------------------------------------------------------------------
// Reading

/** Hidden: authors disabled by the operator or deleting their account. */
const VISIBLE_AUTHOR = "NOT author.disabled AND author.deletion_requested_at IS NULL";

async function discussion(
  c: Queryable,
  context: ShareContext,
  viewerId: string | null,
  isOwner: boolean,
): Promise<ShareDiscussion> {
  const { share } = context;
  const {
    rows: [current],
  } = await c.query("SELECT number FROM revisions WHERE id=$1", [
    share.revision_id,
  ]);
  const { rows } = await c.query(
    `SELECT comment.*,revision.number AS revision_number,
       COALESCE(author.display_name,author.name) AS author_name
     FROM comments comment
     JOIN accounts author ON author.id=comment.author_account_id
     JOIN revisions revision ON revision.id=comment.revision_id
     WHERE comment.share_id=$1 AND comment.tenant_id=$2
       AND ${VISIBLE_AUTHOR}
       AND (comment.held_at IS NULL OR $3::boolean
            OR comment.author_account_id=$4::uuid)
     ORDER BY comment.created_at,comment.id
     LIMIT 5000`,
    [share.id, share.tenant_id, isOwner, viewerId],
  );
  const view = (row: any): CommentView => {
    const deleted = !!row.deleted_at;
    const mine = viewerId !== null && row.author_account_id === viewerId;
    return {
      id: row.id,
      parentId: row.parent_id,
      author: deleted
        ? null
        : {
            name: row.author_name,
            owner: row.author_account_id === context.ownerId,
            me: mine,
          },
      body: deleted ? "" : row.body,
      anchor: row.anchor ?? null,
      sig: anchorSignature(row.anchor),
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      createdAt: new Date(row.created_at).toISOString(),
      resolvedAt: row.resolved_at
        ? new Date(row.resolved_at).toISOString()
        : null,
      deleted,
      held: !!row.held_at,
      canDelete: !deleted && (isOwner || mine),
      canResolve: !deleted && !row.parent_id && (isOwner || mine),
    };
  };
  const roots = new Map<string, CommentThread>();
  for (const row of rows)
    if (!row.parent_id) roots.set(row.id, { ...view(row), replies: [] });
  for (const row of rows) {
    if (!row.parent_id || row.deleted_at) continue;
    roots.get(row.parent_id)?.replies.push(view(row));
  }
  // A deleted root stays as a placeholder only while it has replies.
  const threads = [...roots.values()].filter(
    (thread) => !thread.deleted || thread.replies.length,
  );
  const reactions = await c.query(
    `SELECT reaction.anchor_sig,reaction.emoji,
       (array_agg(reaction.anchor ORDER BY reaction.created_at))[1] AS anchor,
       count(*)::int AS count,
       bool_or(reaction.author_account_id=$3::uuid) AS mine
     FROM comment_reactions reaction
     JOIN accounts author ON author.id=reaction.author_account_id
     WHERE reaction.share_id=$1 AND reaction.tenant_id=$2 AND ${VISIBLE_AUTHOR}
     GROUP BY reaction.anchor_sig,reaction.emoji
     ORDER BY min(reaction.created_at)`,
    [share.id, share.tenant_id, viewerId],
  );
  return {
    shareId: share.id,
    revisionId: share.revision_id,
    revisionNumber: current?.number ?? 0,
    state: share.revoked
      ? "revoked"
      : new Date(share.expires_at).getTime() <= Date.now()
        ? "expired"
        : "active",
    threads,
    reactions: reactions.rows.map(
      (row): ReactionGroup => ({
        sig: row.anchor_sig,
        anchor: row.anchor ?? null,
        emoji: row.emoji,
        count: row.count,
        mine: !!row.mine,
      }),
    ),
  };
}

/** A recipient's view of the link's threads; signed in or not. */
export async function sharedComments(
  token: string,
  viewer: Viewer | null,
): Promise<SharedComments> {
  return transaction(async (c) => {
    const context = await lockShareByToken(c, token);
    const isOwner = viewer?.id === context.ownerId;
    return {
      ...(await discussion(c, context, viewer?.id ?? null, isOwner)),
      viewer: {
        signedIn: !!viewer,
        name: viewer?.name ?? null,
        owner: isOwner,
      },
    };
  });
}

/** Threads of every link of one work; the owner's page and agents read it. */
export async function workCommentsInTransaction(
  c: PoolClient,
  owner: Actor,
  artifactId: string,
): Promise<WorkComments> {
  await lockActiveOwnerTenant(c, owner, missing, "SHARE");
  const artifact = (
    await c.query(
      `SELECT id,title,trashed_at,comments_seen_at FROM artifacts
       WHERE id=$1 AND tenant_id=$2 FOR SHARE`,
      [artifactId, owner.tenant],
    )
  ).rows[0];
  if (!artifact) throw missing();
  const shares = (
    await c.query(
      `SELECT share.id FROM shares share
       WHERE share.artifact_id=$1 AND share.tenant_id=$2
         AND NOT EXISTS(SELECT 1 FROM editorial_publications publication
                        WHERE publication.share_id=share.id)
         AND (EXISTS(SELECT 1 FROM comments comment WHERE comment.share_id=share.id)
           OR EXISTS(SELECT 1 FROM comment_reactions reaction WHERE reaction.share_id=share.id)
           OR (NOT share.revoked AND share.expires_at>now()))
       ORDER BY share.created_at DESC,share.id DESC LIMIT 50`,
      [artifactId, owner.tenant],
    )
  ).rows;
  const result: ShareDiscussion[] = [];
  for (const { id } of shares)
    result.push(
      await discussion(
        c,
        await lockShare(c, owner, artifactId, id, true),
        owner.id,
        true,
      ),
    );
  const {
    rows: [unread],
  } = await c.query(
    `SELECT count(*)::int AS n FROM comments comment
     JOIN accounts author ON author.id=comment.author_account_id
     WHERE comment.artifact_id=$1 AND comment.tenant_id=$2
       AND comment.author_account_id<>$3 AND comment.deleted_at IS NULL
       AND ${VISIBLE_AUTHOR}
       AND comment.created_at>COALESCE($4::timestamptz,'-infinity')`,
    [artifactId, owner.tenant, owner.id, artifact.comments_seen_at],
  );
  return { artifactId, unread: unread.n, shares: result };
}

export function workComments(owner: Actor, artifactId: string) {
  return transaction((c) => workCommentsInTransaction(c, owner, artifactId));
}

export async function markCommentsSeen(owner: Actor, artifactId: string) {
  return transaction(async (c) => {
    await lockActiveOwnerTenant(c, owner, missing, "SHARE");
    const updated = await c.query(
      `UPDATE artifacts SET comments_seen_at=clock_timestamp()
       WHERE id=$1 AND tenant_id=$2`,
      [artifactId, owner.tenant],
    );
    if (!updated.rowCount) throw missing();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Writing

type CreateInput = {
  body: string;
  anchor?: CommentAnchor | null;
  parentId?: string;
};

async function createInContext(
  c: PoolClient,
  context: ShareContext,
  writer: Viewer,
  input: CreateInput,
  notices: CommentNotice[],
) {
  if (!context.open) throw closed();
  await lockWriter(c, writer);
  const { share } = context;
  // Concurrent comments on one link take turns, so the daily count is exact.
  // An advisory lock, as for reports: the share row is held FOR SHARE only.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `comments:${share.id}`,
  ]);
  const {
    rows: [{ today }],
  } = await c.query(
    `SELECT count(*)::int AS today FROM comments
     WHERE share_id=$1 AND created_at>now()-interval '1 day'`,
    [share.id],
  );
  if (today >= COMMENTS_PER_SHARE_PER_DAY)
    throw new Problem(
      429,
      "quota",
      `По этой ссылке уже ${COMMENTS_PER_SHARE_PER_DAY} комментариев за сутки. Продолжите завтра.`,
    );
  let parent: any = null;
  if (input.parentId) {
    parent = (
      await c.query(
        `SELECT comment.* FROM comments comment
         JOIN accounts author ON author.id=comment.author_account_id
         WHERE comment.id=$1 AND comment.share_id=$2 AND comment.parent_id IS NULL
           AND comment.deleted_at IS NULL AND ${VISIBLE_AUTHOR}
           AND (comment.held_at IS NULL OR comment.author_account_id=$3
                OR $4::boolean)`,
        [input.parentId, share.id, writer.id, writer.id === context.ownerId],
      )
    ).rows[0];
    if (!parent) throw missing();
  }
  const { signals, suspicious } = commentSignals(input.body);
  // As for pages: a suspicious comment of an untrusted author waits for the
  // operator; a trusted author's is shown, and the operator is told.
  const trusted = suspicious
    ? (await authorStanding(c, writer.tenant)).trusted
    : true;
  const id = randomUUID();
  const {
    rows: [created],
  } = await c.query(
    `INSERT INTO comments(
       id,tenant_id,artifact_id,share_id,revision_id,author_account_id,
       parent_id,anchor,body,signals,held_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       CASE WHEN $11::boolean THEN clock_timestamp() ELSE NULL END)
     RETURNING id,created_at`,
    [
      id,
      share.tenant_id,
      share.artifact_id,
      share.id,
      share.revision_id,
      writer.id,
      parent?.id ?? null,
      parent ? null : storedAnchor(input.anchor),
      input.body,
      signals,
      suspicious && !trusted,
    ],
  );
  if (suspicious)
    notices.push({ kind: "suspicious", commentId: id, held: !trusted });
  // Held comments reach no one else until the operator releases them.
  if (!suspicious || trusted)
    notices.push({ kind: "comment", commentId: id });
  return { id: created.id as string };
}

async function reactInContext(
  c: PoolClient,
  context: ShareContext,
  writer: Viewer,
  emoji: Reaction,
  anchor: CommentAnchor | null | undefined,
) {
  if (!context.open) throw closed();
  await lockWriter(c, writer);
  const { share } = context;
  const stored = storedAnchor(anchor);
  const sig = anchorSignature(stored);
  const removed = await c.query(
    `DELETE FROM comment_reactions
     WHERE share_id=$1 AND author_account_id=$2 AND anchor_sig=$3 AND emoji=$4`,
    [share.id, writer.id, sig, emoji],
  );
  if (removed.rowCount) return { active: false };
  await c.query(
    `INSERT INTO comment_reactions(
       id,tenant_id,artifact_id,share_id,revision_id,author_account_id,
       anchor_sig,anchor,emoji
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (share_id,author_account_id,anchor_sig,emoji) DO NOTHING`,
    [
      randomUUID(),
      share.tenant_id,
      share.artifact_id,
      share.id,
      share.revision_id,
      writer.id,
      sig,
      stored,
      emoji,
    ],
  );
  return { active: true };
}

async function lockComment(c: PoolClient, context: ShareContext, id: string) {
  const comment = (
    await c.query(
      `SELECT * FROM comments WHERE id=$1 AND share_id=$2 AND tenant_id=$3
       FOR UPDATE`,
      [id, context.share.id, context.share.tenant_id],
    )
  ).rows[0];
  if (!comment) throw missing();
  return comment;
}

/** The owner deletes any comment of the work, an author their own. */
async function deleteInContext(
  c: PoolClient,
  context: ShareContext,
  actorId: string,
  id: string,
) {
  const comment = await lockComment(c, context, id);
  const isOwner = actorId === context.ownerId;
  if (!isOwner && comment.author_account_id !== actorId) throw missing();
  if (comment.deleted_at) return { ok: true };
  await c.query(
    `UPDATE comments SET body='',signals='{}',held_at=NULL,
       deleted_at=clock_timestamp() WHERE id=$1`,
    [id],
  );
  return { ok: true };
}

/** Roots only; the owner, or the author of the thread. */
async function resolveInContext(
  c: PoolClient,
  context: ShareContext,
  actorId: string,
  id: string,
  resolved: boolean,
) {
  const comment = await lockComment(c, context, id);
  const isOwner = actorId === context.ownerId;
  if (!isOwner && comment.author_account_id !== actorId) throw missing();
  if (comment.parent_id || comment.deleted_at)
    throw new Problem(409, "conflict", "Решённой можно отметить только ветку.");
  await c.query(
    `UPDATE comments SET
       resolved_at=CASE WHEN $2::boolean THEN COALESCE(resolved_at,clock_timestamp()) ELSE NULL END,
       resolved_by=CASE WHEN $2::boolean THEN COALESCE(resolved_by,$3::uuid) ELSE NULL END
     WHERE id=$1`,
    [id, resolved, actorId],
  );
  return { ok: true, resolved };
}

/** 60 comments and reactions per author per hour, across all links. */
const limitAuthor = (writer: Viewer) =>
  limitAttempts(
    `comment-author:${writer.id}`,
    COMMENT_ACTIONS_PER_AUTHOR_PER_HOUR,
    "1 hour",
  );

// Recipients (by the link's token) ------------------------------------------

export async function createSharedComment(
  token: string,
  writer: Viewer | null,
  input: CreateInput,
) {
  if (!writer) throw signInToComment();
  await limitAuthor(writer);
  const notices: CommentNotice[] = [];
  const result = await transaction(async (c) =>
    createInContext(c, await lockShareByToken(c, token), writer, input, notices),
  );
  void dispatchCommentNotices(notices);
  return result;
}

export async function reactShared(
  token: string,
  writer: Viewer | null,
  emoji: Reaction,
  anchor: CommentAnchor | null | undefined,
) {
  if (!writer) throw signInToComment();
  await limitAuthor(writer);
  return transaction(async (c) =>
    reactInContext(c, await lockShareByToken(c, token), writer, emoji, anchor),
  );
}

export async function deleteSharedComment(
  token: string,
  writer: Viewer | null,
  id: string,
) {
  if (!writer) throw signInToComment();
  return transaction(async (c) => {
    const context = await lockShareByToken(c, token);
    await lockWriter(c, writer);
    return deleteInContext(c, context, writer.id, id);
  });
}

export async function resolveSharedComment(
  token: string,
  writer: Viewer | null,
  id: string,
  resolved: boolean,
) {
  if (!writer) throw signInToComment();
  return transaction(async (c) => {
    const context = await lockShareByToken(c, token);
    await lockWriter(c, writer);
    return resolveInContext(c, context, writer.id, id, resolved);
  });
}

// The owner (session or agent) ---------------------------------------------

async function ownerShareContext(
  c: PoolClient,
  owner: Actor,
  shareId: string,
  allowTrashed = false,
  artifactId?: string,
) {
  const row = (
    await c.query("SELECT artifact_id FROM shares WHERE id=$1 AND tenant_id=$2", [
      shareId,
      owner.tenant,
    ])
  ).rows[0];
  if (!row || (artifactId && row.artifact_id !== artifactId)) throw missing();
  return lockShare(c, owner, row.artifact_id, shareId, allowTrashed);
}

async function ownerCommentContext(c: PoolClient, owner: Actor, id: string) {
  const row = (
    await c.query("SELECT share_id FROM comments WHERE id=$1 AND tenant_id=$2", [
      id,
      owner.tenant,
    ])
  ).rows[0];
  if (!row) throw missing();
  return ownerShareContext(c, owner, row.share_id, true);
}

const ownerAsViewer = (owner: Actor & { name?: string }): Viewer => ({
  id: owner.id,
  name: owner.name ?? "",
  tenant: owner.tenant,
});

export async function createOwnerComment(
  owner: Actor & { name: string },
  artifactId: string,
  shareId: string,
  input: CreateInput,
) {
  const writer = ownerAsViewer(owner);
  await limitAuthor(writer);
  const notices: CommentNotice[] = [];
  const result = await transaction(async (c) =>
    createInContext(
      c,
      await ownerShareContext(c, owner, shareId, false, artifactId),
      writer,
      input,
      notices,
    ),
  );
  void dispatchCommentNotices(notices);
  return result;
}

export async function reactOwner(
  owner: Actor & { name: string },
  artifactId: string,
  shareId: string,
  emoji: Reaction,
  anchor: CommentAnchor | null | undefined,
) {
  const writer = ownerAsViewer(owner);
  await limitAuthor(writer);
  return transaction(async (c) =>
    reactInContext(
      c,
      await ownerShareContext(c, owner, shareId, false, artifactId),
      writer,
      emoji,
      anchor,
    ),
  );
}

export async function deleteOwnerComment(owner: Actor, id: string) {
  return transaction(async (c) =>
    deleteInContext(c, await ownerCommentContext(c, owner, id), owner.id, id),
  );
}

export async function resolveCommentInTransaction(
  c: PoolClient,
  owner: Actor,
  id: string,
  resolved: boolean,
) {
  return resolveInContext(
    c,
    await ownerCommentContext(c, owner, id),
    owner.id,
    id,
    resolved,
  );
}

export async function resolveOwnerComment(
  owner: Actor,
  id: string,
  resolved: boolean,
) {
  return transaction((c) =>
    resolveCommentInTransaction(c, owner, id, resolved),
  );
}

// Operator ------------------------------------------------------------------

/** The share a comment belongs to, for audit and the operator's scripts. */
export async function commentShare(c: Queryable, id: string) {
  return (
    await c.query(
      "SELECT share_id,tenant_id,artifact_id FROM comments WHERE id=$1",
      [id],
    )
  ).rows[0] as
    | { share_id: string; tenant_id: string; artifact_id: string }
    | undefined;
}
