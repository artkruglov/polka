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
import { assertAuthorisedForPublic } from "./provisional.ts";
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
import { trackNoteAdded, viaFor } from "./analytics.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import { isSuspicious, SignalCollector } from "./phishing-signals.ts";
import { authorStanding } from "./share-moderation.ts";
import {
  blockCommentInTransaction,
  recordEvent,
} from "./content-moderation.ts";
import { decideContent } from "./content-filter/policy.ts";
import { fraudScore, scanText } from "./content-filter/scanner.ts";
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

/** COMMENTS_MODE, read per request so the operator's setting applies at once. */
export const commentsMode = () => config.COMMENTS_MODE;

export const recipientsDoNotComment = () =>
  new Problem(
    403,
    "forbidden",
    "На этой Полке получатели не оставляют комментарии: автор ведёт заметки к работе сам. Напишите ему напрямую — почтой или в мессенджере.",
  );

export const commentsOff = () =>
  new Problem(404, "not_found", "Комментарии на этой Полке выключены.");

/**
 * Who may write under the current mode: anyone signed in (on), the work's
 * owner only (owner-notes), nobody (off). Reactions exist only in `on`.
 */
function assertMayWrite(context: { ownerId: string }, actorId: string) {
  const mode = commentsMode();
  if (mode === "off") throw commentsOff();
  if (mode === "owner-notes" && actorId !== context.ownerId)
    throw recipientsDoNotComment();
}

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
      `SELECT share.id,share.tenant_id,share.artifact_id,account.id AS owner_id,
              tenant.kind
       FROM shares share
       JOIN tenants tenant ON tenant.id=share.tenant_id
       JOIN accounts account ON account.id=COALESCE(tenant.owner_id,share.created_by)
       WHERE share.token_hash=$1 AND NOT account.disabled
         AND account.deletion_requested_at IS NULL`,
      [tokenHash],
    )
  ).rows[0];
  if (!candidate) throw missing();
  // Comments on links out of department shelves come later (TEAM_SHELVES.md):
  // the recipient sees a discussion that is off, not an error.
  if (candidate.kind === "team") throw commentsOff();
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
  const mode = commentsMode();
  const {
    rows: [current],
  } = await c.query("SELECT number FROM revisions WHERE id=$1", [
    share.revision_id,
  ]);
  // owner-notes: what recipients wrote stays in the table, unseen by anyone
  // (switching back to `on` shows it again).
  const { rows } = await c.query(
    `SELECT comment.*,revision.number AS revision_number,
       COALESCE(author.display_name,author.name) AS author_name
     FROM comments comment
     JOIN accounts author ON author.id=comment.author_account_id
     JOIN revisions revision ON revision.id=comment.revision_id
     WHERE comment.share_id=$1 AND comment.tenant_id=$2
       AND ${VISIBLE_AUTHOR}
       AND comment.blocked_at IS NULL
       AND (comment.held_at IS NULL OR comment.author_account_id=$4::uuid
            OR ($3::boolean AND NOT comment.shadow))
       AND ($5::boolean OR comment.author_account_id=$6::uuid)
     ORDER BY comment.created_at,comment.id
     LIMIT 5000`,
    [
      share.id,
      share.tenant_id,
      isOwner,
      viewerId,
      mode === "on",
      context.ownerId,
    ],
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
      canDelete: !deleted && (isOwner || (mine && mode === "on")),
      canResolve:
        !deleted && !row.parent_id && (isOwner || (mine && mode === "on")),
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
  // Reactions exist only in `on`; in other modes they are kept, not shown.
  const reactions =
    mode !== "on"
      ? { rows: [] as any[] }
      : await c.query(
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
    mode,
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
  if (commentsMode() === "off") throw commentsOff();
  return transaction(async (c) => {
    const context = await lockShareByToken(c, token);
    const isOwner = viewer?.id === context.ownerId;
    return {
      ...(await discussion(c, context, viewer?.id ?? null, isOwner)),
      viewer: viewer
        ? { signedIn: true, owner: isOwner, ...(await viewerSettings(c, viewer.id)) }
        : {
            signedIn: false,
            name: null,
            owner: false,
            nameChosen: false,
            commentMail: true,
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
  const mode = commentsMode();
  if (mode === "off")
    return {
      mode,
      artifactId,
      unread: 0,
      shares: [],
      viewer: {
        signedIn: true,
        owner: true,
        ...(await viewerSettings(c, owner.id)),
      },
    };
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
  return {
    mode,
    artifactId,
    // Only others' comments are unread; owner-notes shows none of them.
    unread: mode === "on" ? unread.n : 0,
    shares: result,
    viewer: {
      signedIn: true,
      owner: true,
      ...(await viewerSettings(c, owner.id)),
    },
  };
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
  displayName?: string;
};

export const nameRequired = () =>
  new Problem(
    400,
    "invalid",
    "Выберите имя, которое увидят под вашими комментариями.",
    { nameRequired: true },
  );

/** The writer's name and letters settings, as the rail shows them. */
async function viewerSettings(c: Queryable, accountId: string) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT COALESCE(display_name,name) AS name,
       comment_name_chosen_at IS NOT NULL AS chosen,comment_mail
     FROM accounts WHERE id=$1`,
    [accountId],
  );
  return {
    name: (row?.name as string | undefined) ?? null,
    nameChosen: !!row?.chosen,
    commentMail: row ? !!row.comment_mail : true,
  };
}

/**
 * Everyone with the link sees the name under a comment, so it is chosen by
 * the person before their first one (not taken silently from their address).
 */
async function lockWriterWithName(
  c: PoolClient,
  writer: Viewer,
  displayName: string | undefined,
) {
  const {
    rows: [account],
  } = await c.query(
    "SELECT comment_name_chosen_at IS NOT NULL AS chosen FROM accounts WHERE id=$1",
    [writer.id],
  );
  if (account?.chosen) return lockWriter(c, writer);
  if (!displayName) throw nameRequired();
  const updated = await c.query(
    `UPDATE accounts SET display_name=$2,comment_name_chosen_at=clock_timestamp()
     WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL`,
    [writer.id, displayName],
  );
  if (!updated.rowCount) throw signInToComment();
}

async function createInContext(
  c: PoolClient,
  context: ShareContext,
  writer: Viewer,
  input: CreateInput,
  notices: CommentNotice[],
) {
  assertMayWrite(context, writer.id);
  if (!context.open) throw closed();
  await lockWriterWithName(c, writer, input.displayName);
  const { share } = context;
  // Concurrent comments on one link take turns, so the daily count is exact.
  // An advisory lock, as for reports: the share row is held FOR SHARE only.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `comments:${share.id}`,
  ]);
  const {
    rows: [{ today, retry_after }],
  } = await c.query(
    `SELECT count(*)::int AS today,
       extract(epoch FROM min(created_at)+interval '1 day'-now())::float8 AS retry_after
     FROM comments WHERE share_id=$1 AND created_at>now()-interval '1 day'`,
    [share.id],
  );
  if (today >= COMMENTS_PER_SHARE_PER_DAY)
    throw new Problem(
      429,
      "quota",
      `По этой ссылке уже ${COMMENTS_PER_SHARE_PER_DAY} комментариев за сутки. Продолжите завтра.`,
    ).retryIn(retry_after ?? 86_400);
  let parent: any = null;
  if (input.parentId) {
    parent = (
      await c.query(
        `SELECT comment.* FROM comments comment
         JOIN accounts author ON author.id=comment.author_account_id
         WHERE comment.id=$1 AND comment.share_id=$2 AND comment.parent_id IS NULL
           AND comment.deleted_at IS NULL AND ${VISIBLE_AUTHOR}
           AND comment.blocked_at IS NULL
           AND (comment.held_at IS NULL OR comment.author_account_id=$3
                OR $4::boolean)
           AND ($5::boolean OR comment.author_account_id=$6::uuid)`,
        [
          input.parentId,
          share.id,
          writer.id,
          writer.id === context.ownerId,
          commentsMode() === "on",
          context.ownerId,
        ],
      )
    ).rows[0];
    if (!parent) throw missing();
  }
  const { signals, suspicious } = commentSignals(input.body);
  // The content filter reads the comment like a page (docs/specs/CONTENT_FILTER.md,
  // «Комментарии»), plus comment spam: addresses from a new author, the same
  // text on several links, a burst.
  const standing = await authorStanding(c, writer.tenant);
  const filter = scanText(input.body);
  const fraud = fraudScore(signals);
  if (fraud) filter.hits.fraud = fraud;
  const spam = await commentSpam(c, writer, share.id, input.body, standing.trusted, signals);
  if (spam.length) filter.hits.spam = { score: 6, terms: spam };
  const content = decideContent({
    filter,
    standing,
    mode: config.CONTENT_FILTER_MODE,
    autoblock: config.CONTENT_FILTER_AUTOBLOCK,
    fraud: config.SHARE_MODERATION !== "off",
  });
  // As for pages: a suspicious comment of an untrusted author waits for the
  // operator; a trusted author's is shown, and the operator is told.
  const trusted = suspicious ? standing.trusted : true;
  const held = (suspicious && !trusted) || content.action === "hold";
  const id = randomUUID();
  const {
    rows: [created],
  } = await c.query(
    `INSERT INTO comments(
       id,tenant_id,artifact_id,share_id,revision_id,author_account_id,
       parent_id,anchor,body,signals,held_at,content_filter,shadow
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       CASE WHEN $11::boolean THEN clock_timestamp() ELSE NULL END,$12,$13)
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
      held || content.action === "block",
      filter,
      content.shadow,
    ],
  );
  if (content.action === "block") {
    // CSAM: nobody sees it, the author is disabled, the operator is told
    // without the text.
    await blockCommentInTransaction(c, {
      commentId: id,
      tenantId: share.tenant_id,
      authorAccountId: writer.id,
      authorTenantId: writer.tenant,
      category: content.category ?? "other",
      actor: "filter",
      reason: "фильтр содержимого: комментарий",
      freeze: content.freeze,
    });
    notices.push({ kind: "suspicious", commentId: id, held: true });
    return { id: created.id as string };
  }
  if (content.action !== "none")
    await recordEvent(c, {
      actor: "filter",
      action: content.action === "hold" ? "comment.held" : "comment.flagged",
      category: content.category,
      accountId: writer.id,
      tenantId: share.tenant_id,
      artifactId: share.artifact_id,
      shareId: share.id,
      commentId: id,
      details: {
        findings: content.findings.map((finding) =>
          finding.category === "csam" ? { category: "csam", score: finding.score } : finding,
        ),
        shadow: content.shadow,
      },
    });
  if (suspicious || content.action !== "none")
    notices.push({ kind: "suspicious", commentId: id, held });
  // Held comments reach no one else until the operator releases them.
  // Owner notes send no letters: recipients are not a discussion to notify.
  if (!held && commentsMode() === "on")
    notices.push({ kind: "comment", commentId: id });
  trackNoteAdded(
    c,
    writer.id,
    writer.id === context.ownerId ? "owner" : "reader",
    viaFor(),
  );
  return { id: created.id as string };
}

/**
 * Comment spam of one writer: an address from an author who is not trusted,
 * the same text on other links within a day, or more than 10 comments in 10
 * minutes. The reasons, for the operator; empty when there is none.
 */
async function commentSpam(
  c: PoolClient,
  writer: Viewer,
  shareId: string,
  body: string,
  trusted: boolean,
  signals: readonly string[],
) {
  const reasons: string[] = [];
  if (!trusted && signals.includes("link:address"))
    reasons.push("адрес в комментарии нового автора");
  const {
    rows: [row],
  } = await c.query(
    `SELECT
       count(DISTINCT share_id) FILTER (
         WHERE share_id<>$2 AND md5(body)=md5($3) AND created_at>now()-interval '1 day'
       )::int AS copies,
       count(*) FILTER (WHERE created_at>now()-interval '10 minutes')::int AS burst
     FROM comments WHERE author_account_id=$1 AND created_at>now()-interval '1 day'`,
    [writer.id, shareId, body],
  );
  if (body.trim().length >= 20 && row.copies >= 2)
    reasons.push(`тот же текст ещё на ${row.copies} ссылках за сутки`);
  if (!trusted && row.burst >= 10) reasons.push("больше 10 комментариев за 10 минут");
  return reasons;
}

async function reactInContext(
  c: PoolClient,
  context: ShareContext,
  writer: Viewer,
  emoji: Reaction,
  anchor: CommentAnchor | null | undefined,
) {
  const mode = commentsMode();
  if (mode === "off") throw commentsOff();
  if (mode === "owner-notes")
    throw new Problem(
      403,
      "forbidden",
      "Реакции на этой Полке выключены.",
    );
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
  assertMayWrite(context, actorId);
  const comment = await lockComment(c, context, id);
  const isOwner = actorId === context.ownerId;
  if (!isOwner && comment.author_account_id !== actorId) throw missing();
  if (comment.deleted_at) return { ok: true };
  await c.query(
    `UPDATE comments SET body='',anchor=NULL,signals='{}',held_at=NULL,
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
  assertMayWrite(context, actorId);
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
  if (commentsMode() === "off") throw commentsOff();
  if (!writer)
    throw commentsMode() === "on" ? signInToComment() : recipientsDoNotComment();
  await assertAuthorisedForPublic(db, writer.id);
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
  if (commentsMode() === "off") throw commentsOff();
  if (!writer)
    throw commentsMode() === "on" ? signInToComment() : recipientsDoNotComment();
  await assertAuthorisedForPublic(db, writer.id);
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

/**
 * A note (or a comment in `on`) by the owner's agent: on the given link of
 * the work, or on its newest open link. Returns the notices to send after
 * the transaction commits.
 */
export async function createOwnerNoteInTransaction(
  c: PoolClient,
  owner: Actor,
  artifactId: string,
  shareId: string | undefined,
  input: CreateInput,
) {
  if (commentsMode() === "off") throw commentsOff();
  let target = shareId;
  if (!target) {
    const row = (
      await c.query(
        `SELECT share.id FROM shares share
          WHERE share.artifact_id=$1 AND share.tenant_id=$2
            AND NOT share.revoked AND share.expires_at>now()
            AND share.moderation='none'
            AND NOT EXISTS(SELECT 1 FROM editorial_publications publication
                           WHERE publication.share_id=share.id)
          ORDER BY share.created_at DESC,share.id DESC LIMIT 1`,
        [artifactId, owner.tenant],
      )
    ).rows[0];
    if (!row)
      throw new Problem(
        409,
        "conflict",
        "У работы нет открытой ссылки: заметка живёт на ссылке и видна её получателям. Сначала создайте ссылку (polka_share), затем добавьте заметку.",
      );
    target = row.id as string;
  }
  const notices: CommentNotice[] = [];
  const result = await createInContext(
    c,
    await ownerShareContext(c, owner, target, false, artifactId),
    ownerAsViewer(owner),
    input,
    notices,
  );
  return { ...result, shareId: target, notices };
}

export { dispatchCommentNotices };

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

/** The name under one's comments and letters about them. */
export async function updateCommentSettings(
  actor: Actor,
  input: { displayName?: string; commentMail?: boolean },
) {
  return transaction(async (c) => {
    await lockActiveOwnerTenant(c, actor);
    await c.query(
      `UPDATE accounts SET
         display_name=COALESCE($2,display_name),
         comment_name_chosen_at=CASE WHEN $2::text IS NULL THEN comment_name_chosen_at
           ELSE clock_timestamp() END,
         comment_mail=COALESCE($3,comment_mail)
       WHERE id=$1`,
      [actor.id, input.displayName ?? null, input.commentMail ?? null],
    );
    return viewerSettings(c, actor.id);
  });
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
