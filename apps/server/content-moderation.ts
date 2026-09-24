// Acting on the content filter (docs/specs/CONTENT_FILTER.md): the journal,
// blocking a revision or a comment, disabling an author, deleting blocked
// content, and the model verdicts gathered before a link is decided.
//
// Blocking happens inside the caller's transaction; deleting the objects and
// writing to the operator happen after it commits (db.ts afterCommit), so a
// rolled-back block deletes nothing and sends nothing.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { audit } from "./artifacts.ts";
import { config, type ModelEndpoint } from "./config.ts";
import { afterCommit, db, transaction } from "./db.ts";
import { inspectHtmlBounded } from "./html.ts";
import { revokeConnectionInTransaction } from "./oauth.ts";
import { deleteAllVersions, readBlob, sha256 } from "./storage.ts";
import type { Category } from "./content-filter/lists.ts";
import { readFileSync } from "node:fs";
import {
  MAX_TEXT_CHARS,
  answered,
  budgetLeft,
  contentModels,
  spend,
  spentToday,
  type ModelAnswer,
  type ModelClient,
} from "./content-filter/model.ts";
import { codeModelClient, type CodeReview } from "./content-filter/code-model.ts";
import {
  CATEGORY_LABEL,
  NO_MODEL,
  parseRetention,
  type ModelFinding,
  type ModelView,
  type Retention,
} from "./content-filter/policy.ts";
import { sendMail } from "./mailer.ts";

let retentionTable: ReturnType<typeof parseRetention> | null = null;
/** What a block of this category does with the content (MODERATION_RETENTION). */
export function retentionOf(category: Category | "other"): Retention {
  retentionTable ??= parseRetention(config.MODERATION_RETENTION);
  return retentionTable[category];
}
/** What happens to blocked content, in words, for the operator. */
export function retentionText(category: Category | "other", legalHold: boolean) {
  if (legalHold) return "Содержимое сохранено как доказательство (legal hold) до снятия.";
  const retention = retentionOf(category);
  if (!retention.isolate)
    return "Ссылки закрыты, отправить работу заново нельзя; у владельца она остаётся.";
  if (retention.days === null)
    return "Содержимое изолировано (недоступно никому, включая владельца) до решения оператора.";
  if (retention.days === 0)
    return "Содержимое удаляется сейчас (все версии объектов); sha256 и метаданные — в журнале.";
  return `Содержимое изолировано (недоступно никому, включая владельца) и будет удалено через ${retention.days} дн.; за сутки до удаления придёт напоминание.`;
}

/** Tests change MODERATION_RETENTION at run time. */
export function resetRetention() {
  retentionTable = null;
}
import { levelOf, type FilterResult } from "./content-filter/scanner.ts";

type Queryable = Pick<PoolClient, "query">;

export type EventActor =
  | "filter"
  | "model"
  | "operator-mail"
  | "operator-script"
  | "maintenance"
  | "reports"
  | "signup";

export type ModerationEvent = {
  actor: EventActor;
  action: string;
  category?: Category | "other" | null;
  accountId?: string | null;
  tenantId?: string | null;
  artifactId?: string | null;
  revisionId?: string | null;
  shareId?: string | null;
  commentId?: string | null;
  reason?: string | null;
  authority?: string | null;
  details?: Record<string, unknown>;
};

/** Append one event to the journal. Never content, titles or file names. */
export async function recordEvent(c: Queryable, event: ModerationEvent) {
  await c.query(
    `INSERT INTO moderation_events(
       id,actor,action,category,account_id,tenant_id,artifact_id,revision_id,
       share_id,comment_id,reason,authority,details
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      randomUUID(),
      event.actor,
      event.action,
      event.category ?? null,
      event.accountId ?? null,
      event.tenantId ?? null,
      event.artifactId ?? null,
      event.revisionId ?? null,
      event.shareId ?? null,
      event.commentId ?? null,
      event.reason?.slice(0, 2000) ?? null,
      event.authority?.slice(0, 500) ?? null,
      event.details ?? {},
    ],
  );
}

/** What proves what was blocked without keeping it: hashes, sizes, types. */
export async function evidenceOf(c: Queryable, revisionId: string) {
  const {
    rows: [revision],
  } = await c.query(
    `SELECT sha256,size,total_size,mime,storage_kind,number,created_at
     FROM revisions WHERE id=$1`,
    [revisionId],
  );
  if (!revision) return {};
  const files = (
    await c.query(
      `SELECT sha256,size,mime FROM revision_files WHERE revision_id=$1
       ORDER BY file_index LIMIT 200`,
      [revisionId],
    )
  ).rows;
  const derivatives = (
    await c.query(
      `SELECT sha256,size FROM revision_derivatives
       WHERE revision_id=$1 AND sha256 IS NOT NULL LIMIT 20`,
      [revisionId],
    )
  ).rows;
  return {
    sha256: revision.sha256,
    size: Number(revision.size),
    totalSize: Number(revision.total_size ?? revision.size),
    mime: revision.mime,
    storageKind: revision.storage_kind,
    version: revision.number,
    savedAt: new Date(revision.created_at).toISOString(),
    files: files.map((file) => ({
      sha256: file.sha256,
      size: Number(file.size),
      mime: file.mime,
    })),
    derivatives: derivatives.map((item) => ({
      sha256: item.sha256,
      size: Number(item.size),
    })),
  };
}

/** Rules findings for the journal and the operator (no terms for csam). */
export function signalsForJournal(filter: FilterResult | null | undefined) {
  const out: Record<string, { score: number; terms?: string[] }> = {};
  for (const [category, hit] of Object.entries(filter?.hits ?? {}))
    if (hit && levelOf(category as Category, hit.score) !== "none")
      out[category] =
        category === "csam"
          ? { score: hit.score }
          : { score: hit.score, terms: hit.terms };
  return out;
}

/**
 * Disable an account inside the caller's transaction: sessions end, agent
 * connections are revoked, live links close. Nothing is deleted. The same
 * effect as moderation:disable; returns false when it was disabled already.
 */
export async function freezeAccountInTransaction(
  c: PoolClient,
  owner: { accountId: string; tenantId: string },
  actor: EventActor,
  reason: string,
  category: Category | "other" | null,
) {
  const {
    rows: [account],
  } = await c.query(
    "SELECT id,disabled FROM accounts WHERE id=$1 FOR UPDATE",
    [owner.accountId],
  );
  if (!account || account.disabled) return false;
  const connections = (
    await c.query(
      `SELECT id,tenant_id,account_id FROM agent_connections
       WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY id FOR UPDATE`,
      [owner.tenantId],
    )
  ).rows;
  await c.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.accountId]);
  await c.query("DELETE FROM sessions WHERE account_id=$1", [owner.accountId]);
  for (const connection of connections)
    await revokeConnectionInTransaction(c, connection);
  const shares = (
    await c.query(
      "UPDATE shares SET revoked=true WHERE tenant_id=$1 AND NOT revoked RETURNING id",
      [owner.tenantId],
    )
  ).rows;
  const self = { id: owner.accountId, tenant: owner.tenantId };
  for (const share of shares) await audit(c, self, "share.revoked", share.id);
  await audit(c, self, "account.disabled", owner.accountId);
  await recordEvent(c, {
    actor,
    action: "account.disabled",
    category,
    accountId: owner.accountId,
    tenantId: owner.tenantId,
    reason,
    details: { sharesClosed: shares.length, connectionsRevoked: connections.length },
  });
  return true;
}

export type BlockInput = {
  tenantId: string;
  accountId: string;
  artifactId: string;
  revisionId: string;
  category: Category | "other";
  actor: EventActor;
  reason: string;
  authority?: string | null;
  /** An operator's legal hold: the objects stay until it is lifted. */
  legalHold?: string | null;
  /** Disable the author as well. */
  freeze: boolean;
  details?: Record<string, unknown>;
};

export type BlockOutcome = {
  blockId: string;
  created: boolean;
  shareIds: string[];
  frozen: boolean;
};

/**
 * Block one revision: every link to it shows «Ссылка недоступна», grants
 * stop working, nobody can save or link the same bytes again, and by its
 * category's retention the content is isolated (the owner cannot open it
 * either) and deleted on schedule, unless a legal hold keeps it. Soft
 * categories only close the links. Idempotent: a second block of the same
 * revision changes only the legal hold.
 */
export async function blockRevisionInTransaction(
  c: PoolClient,
  input: BlockInput,
): Promise<BlockOutcome> {
  const {
    rows: [revision],
  } = await c.query(
    "SELECT id,sha256 FROM revisions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [input.revisionId, input.tenantId],
  );
  if (!revision) throw new Error("Blocked revision not found");
  const {
    rows: [existing],
  } = await c.query(
    "SELECT * FROM moderation_blocks WHERE revision_id=$1 FOR UPDATE",
    [input.revisionId],
  );
  let blockId: string;
  let created = false;
  const retention = retentionOf(input.category);
  if (existing && !existing.released_at) {
    blockId = existing.id;
    if (input.legalHold && !existing.legal_hold && !existing.purged_at) {
      await c.query("UPDATE moderation_blocks SET legal_hold=$2 WHERE id=$1", [
        blockId,
        input.legalHold,
      ]);
      await recordEvent(c, {
        actor: input.actor,
        action: "legal_hold.set",
        category: input.category,
        tenantId: input.tenantId,
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        authority: input.legalHold,
      });
    }
  } else {
    blockId = existing?.id ?? randomUUID();
    created = true;
    if (existing)
      await c.query(
        `UPDATE moderation_blocks SET category=$2,blocked_at=now(),isolated=$3,
           delete_after=now()+$4*interval '1 day',legal_hold=$5,released_at=NULL,
           reminded_at=NULL
         WHERE id=$1`,
        [blockId, input.category, retention.isolate, retention.days, input.legalHold ?? null],
      );
    else
      await c.query(
        `INSERT INTO moderation_blocks(
           id,tenant_id,artifact_id,revision_id,sha256,category,isolated,
           delete_after,legal_hold
         ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day',$9)`,
        [
          blockId,
          input.tenantId,
          input.artifactId,
          input.revisionId,
          revision.sha256,
          input.category,
          retention.isolate,
          retention.days,
          input.legalHold ?? null,
        ],
      );
  }
  const shareIds = (
    await c.query(
      `UPDATE shares SET moderation='blocked',moderation_reason=$3,moderated_at=now()
       WHERE revision_id=$1 AND tenant_id=$2 AND moderation<>'blocked'
       RETURNING id`,
      [input.revisionId, input.tenantId, `blocked:${input.category}`],
    )
  ).rows.map((row) => row.id as string);
  // Views already open end now: grants of the revision and of its links.
  await c.query(
    `DELETE FROM viewer_grants WHERE revision_id=$1
       OR share_id IN (SELECT id FROM shares WHERE revision_id=$1)`,
    [input.revisionId],
  );
  await c.query(
    `DELETE FROM grants WHERE revision_id=$1
       OR share_id IN (SELECT id FROM shares WHERE revision_id=$1)`,
    [input.revisionId],
  );
  if (created)
    await recordEvent(c, {
      actor: input.actor,
      action: "revision.blocked",
      category: input.category,
      accountId: input.accountId,
      tenantId: input.tenantId,
      artifactId: input.artifactId,
      revisionId: input.revisionId,
      reason: input.reason,
      authority: input.authority ?? null,
      details: {
        ...(input.details ?? {}),
        evidence: await evidenceOf(c, input.revisionId),
        legalHold: !!input.legalHold,
        // Why and for how long the content is kept (152-FZ purpose record).
        purpose: retention.isolate
          ? retention.days === null
            ? "изолировано до решения оператора"
            : `изолировано как доказательство на ${retention.days} дн., затем удаление`
          : "ссылки закрыты, работа остаётся у владельца",
        isolated: retention.isolate,
        retentionDays: retention.days,
      },
    });
  for (const shareId of shareIds)
    await recordEvent(c, {
      actor: input.actor,
      action: "share.blocked",
      category: input.category,
      accountId: input.accountId,
      tenantId: input.tenantId,
      artifactId: input.artifactId,
      revisionId: input.revisionId,
      shareId,
      reason: input.reason,
      authority: input.authority ?? null,
    });
  const frozen = input.freeze
    ? await freezeAccountInTransaction(
        c,
        { accountId: input.accountId, tenantId: input.tenantId },
        input.actor,
        `${input.reason} (${CATEGORY_LABEL[input.category]})`,
        input.category,
      )
    : false;
  if (created && !input.legalHold && retention.days === 0)
    afterCommit(c, () => purgeBlock(blockId));
  return { blockId, created, shareIds, frozen };
}

/**
 * Block a comment: nobody sees it; its text is emptied by the category's
 * retention (a soft category: when the operator decides). The journal keeps
 * its sha256.
 */
export async function blockCommentInTransaction(
  c: PoolClient,
  input: {
    commentId: string;
    tenantId: string;
    authorAccountId: string;
    authorTenantId: string;
    category: Category | "other";
    actor: EventActor;
    reason: string;
    freeze: boolean;
    details?: Record<string, unknown>;
  },
) {
  const {
    rows: [comment],
  } = await c.query(
    `SELECT id,artifact_id,share_id,encode(sha256(convert_to(body,'UTF8')),'hex') AS sha256,
       char_length(body) AS length,blocked_at
     FROM comments WHERE id=$1 FOR UPDATE`,
    [input.commentId],
  );
  if (!comment || comment.blocked_at) return false;
  const blockId = randomUUID();
  const retention = retentionOf(input.category);
  await c.query("UPDATE comments SET blocked_at=clock_timestamp() WHERE id=$1", [
    input.commentId,
  ]);
  await c.query(
    `INSERT INTO moderation_blocks(id,tenant_id,comment_id,sha256,category,isolated,delete_after)
     VALUES($1,$2,$3,$4,$5,true,now()+$6*interval '1 day')`,
    [
      blockId,
      input.tenantId,
      input.commentId,
      comment.sha256,
      input.category,
      retention.days,
    ],
  );
  await recordEvent(c, {
    actor: input.actor,
    action: "comment.blocked",
    category: input.category,
    accountId: input.authorAccountId,
    tenantId: input.tenantId,
    artifactId: comment.artifact_id,
    shareId: comment.share_id,
    commentId: input.commentId,
    reason: input.reason,
    details: {
      ...(input.details ?? {}),
      evidence: { sha256: comment.sha256, length: Number(comment.length) },
    },
  });
  if (input.freeze)
    await freezeAccountInTransaction(
      c,
      { accountId: input.authorAccountId, tenantId: input.authorTenantId },
      input.actor,
      input.reason,
      input.category,
    );
  if (retention.days === 0) afterCommit(c, () => purgeBlock(blockId));
  return true;
}

/**
 * Delete what one block keeps, if its time has come and nothing holds it:
 * every S3 version and delete marker of the revision's objects, its bundle
 * files and interactive builds; or a comment's text. The rows stay as
 * tombstones. Safe to repeat: a purged block is skipped.
 */
export async function purgeBlock(
  blockId: string,
  options: { now?: boolean; actor?: EventActor; reason?: string } = {},
) {
  const {
    rows: [block],
  } = await db.query(
    `SELECT block.*,revision.object_key
     FROM moderation_blocks block
     LEFT JOIN revisions revision ON revision.id=block.revision_id
     WHERE block.id=$1 AND block.purged_at IS NULL AND block.released_at IS NULL
       AND block.legal_hold IS NULL
       AND ($2::boolean OR block.delete_after<=now())`,
    [blockId, options.now === true],
  );
  if (!block) return { purged: false, versions: 0 };
  let versions = 0;
  if (block.revision_id && block.object_key) {
    const prefixes = new Set<string>([block.object_key]);
    for (const row of (
      await db.query(
        "SELECT object_key FROM revision_files WHERE revision_id=$1",
        [block.revision_id],
      )
    ).rows)
      prefixes.add(row.object_key);
    for (const row of (
      await db.query(
        "SELECT id,tenant_id FROM revision_derivatives WHERE revision_id=$1",
        [block.revision_id],
      )
    ).rows)
      prefixes.add(`${row.tenant_id}/derivatives/${row.id}/`);
    for (const prefix of prefixes)
      versions += await deleteAllVersions(prefix, (key) =>
        prefix.endsWith("/")
          ? key.startsWith(prefix)
          : key === prefix || key.startsWith(`${prefix}/`),
      );
  }
  await transaction(async (c) => {
    const {
      rows: [locked],
    } = await c.query(
      "SELECT id FROM moderation_blocks WHERE id=$1 AND purged_at IS NULL FOR UPDATE",
      [blockId],
    );
    if (!locked) return;
    if (block.revision_id)
      await c.query(
        "UPDATE revisions SET content_purged_at=clock_timestamp() WHERE id=$1 AND content_purged_at IS NULL",
        [block.revision_id],
      );
    if (block.comment_id)
      await c.query(
        `UPDATE comments SET body='',anchor=NULL,
           deleted_at=COALESCE(deleted_at,clock_timestamp())
         WHERE id=$1`,
        [block.comment_id],
      );
    await c.query(
      "UPDATE moderation_blocks SET purged_at=clock_timestamp() WHERE id=$1",
      [blockId],
    );
    await recordEvent(c, {
      actor: options.actor ?? "maintenance",
      action: "content.deleted",
      reason: options.reason ?? null,
      category: block.category,
      tenantId: block.tenant_id,
      artifactId: block.artifact_id,
      revisionId: block.revision_id,
      commentId: block.comment_id,
      details: { objectVersionsDeleted: versions, sha256: block.sha256 },
    });
  });
  console.info(
    JSON.stringify({ event: "moderation.content_deleted", versions }),
  );
  return { purged: true, versions };
}

/**
 * The day before a scheduled deletion the operator is reminded (ids and the
 * category only): time to set a legal hold if the police asked for the data.
 */
export async function remindDueBlocks(limit = 50) {
  const { rows } = await db.query(
    `UPDATE moderation_blocks SET reminded_at=now()
     WHERE id IN (
       SELECT id FROM moderation_blocks
       WHERE purged_at IS NULL AND released_at IS NULL AND legal_hold IS NULL
         AND reminded_at IS NULL AND delete_after IS NOT NULL
         AND delete_after<=now()+interval '1 day' AND delete_after>now()
       ORDER BY delete_after LIMIT $1)
     RETURNING id,category,artifact_id,revision_id,comment_id,delete_after,sha256`,
    [limit],
  );
  if (!rows.length) return 0;
  if (config.OPERATOR_EMAIL && config.MAIL_MODE !== "disabled") {
    const lines = rows.map(
      (row) =>
        `${new Date(row.delete_after).toISOString().slice(0, 16).replace("T", " ")} UTC — ${CATEGORY_LABEL[row.category as Category] ?? row.category}: ${row.revision_id ? `работа ${row.artifact_id}, версия ${row.revision_id}` : `комментарий ${row.comment_id}`}, sha256 ${row.sha256}`,
    );
    await sendMail({
      to: config.OPERATOR_EMAIL,
      subject: `Полка: завтра удаляется заблокированное (${rows.length})`,
      text: [
        "Через сутки будет удалено содержимое этих блокировок (все версии объектов в хранилище). Останутся sha256 и метаданные в журнале.",
        "",
        ...lines,
        "",
        "Если полиция или суд запросили эти данные: npm run moderation:legal-hold -- <id> on --authority \"…\"",
        "Если данные уже переданы: npm run moderation:handed-over -- <id>",
      ].join("\n"),
    }).catch(() =>
      console.error(JSON.stringify({ event: "moderation.mail_failed", kind: "reminder" })),
    );
  }
  for (const row of rows)
    await recordEvent(db, {
      actor: "maintenance",
      action: "deletion.reminded",
      category: row.category,
      artifactId: row.artifact_id,
      revisionId: row.revision_id,
      commentId: row.comment_id,
    });
  return rows.length;
}

/**
 * The moderation sweep, run by the app every hour and by
 * `npm run moderation:sweep`: reminders, then deletions that are due.
 */
export async function sweepBlocks() {
  const reminded = await remindDueBlocks();
  const deleted = await purgeDueBlocks();
  return { reminded, deleted };
}

/** Blocks whose retention ended: deleted now. */
export async function purgeDueBlocks(limit = 50) {
  const { rows } = await db.query(
    `SELECT id FROM moderation_blocks
     WHERE purged_at IS NULL AND released_at IS NULL AND legal_hold IS NULL
       AND delete_after IS NOT NULL AND delete_after<=now()
     ORDER BY delete_after LIMIT $1`,
    [limit],
  );
  let purged = 0;
  for (const row of rows) {
    try {
      if ((await purgeBlock(row.id)).purged) purged++;
    } catch {
      console.error(JSON.stringify({ event: "moderation.delete_failed" }));
    }
  }
  return purged;
}

/**
 * An object nobody may read: a revision's, a bundle file's or a build's key
 * whose revision is blocked and isolated (the owner included).
 */
export async function isolatedObject(key: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT 1 FROM moderation_blocks block
     WHERE block.isolated AND block.released_at IS NULL
       AND block.revision_id IN (
         SELECT id FROM revisions WHERE object_key=$1
         UNION ALL SELECT revision_id FROM revision_files WHERE object_key=$1
         UNION ALL SELECT revision_id FROM revision_derivatives WHERE object_key=$1)
     LIMIT 1`,
    [key],
  );
  return !!row;
}

/** An object of a revision whose content moderation deleted. */
export async function purgedObject(key: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT 1 FROM revisions revision
     WHERE revision.content_purged_at IS NOT NULL AND revision.id IN (
       SELECT id FROM revisions WHERE object_key=$1
       UNION ALL SELECT revision_id FROM revision_files WHERE object_key=$1
       UNION ALL SELECT revision_id FROM revision_derivatives WHERE object_key=$1)
     LIMIT 1`,
    [key],
  );
  return !!row;
}

/** A live block of these bytes (a re-upload of blocked content). */
export async function blockedHash(c: Queryable, sha256: string) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT category FROM moderation_blocks
     WHERE sha256=$1 AND released_at IS NULL AND revision_id IS NOT NULL
     ORDER BY blocked_at DESC LIMIT 1`,
    [sha256],
  );
  return (row?.category as Category | "other" | undefined) ?? null;
}

/** The revision is blocked (and not released): no new link to it. */
export async function revisionBlocked(c: Queryable, revisionId: string) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT 1 FROM moderation_blocks WHERE revision_id=$1 AND released_at IS NULL
     UNION ALL SELECT 1 FROM revisions WHERE id=$1 AND content_purged_at IS NOT NULL
     LIMIT 1`,
    [revisionId],
  );
  return !!row;
}

// ---------------------------------------------------------------------------
// The model stage (docs/specs/CONTENT_FILTER.md, «Модель»): after a save
// commits, in the background. The verdict is stored with the revision; links
// already made to it are decided again: stricter for open links, released for
// links that waited only for the model (shares.ts, releasableHold).

const MAX_IMAGE_BYTES = 1_000_000;
const MAX_CODE_CHARS = 12_000;
/** Reviews of one revision before the models are given up on. */
export const MAX_REVIEW_ATTEMPTS = 5;
const MAX_ATTEMPTS = MAX_REVIEW_ATTEMPTS;

type StoredModel = {
  state: "checked" | "unchecked";
  hash: string;
  attempts: number;
  at: string;
  findings: ModelFinding[];
  /** What each model answered: categories or failures, never the text. */
  answers: Array<{ source: string; model: string; answer: string }>;
};

/** The stored verdict as the policy reads it. */
export function modelView(contentFilter: any): ModelView {
  const stored = contentFilter?.model as StoredModel | undefined;
  if (!contentModels()) return NO_MODEL;
  if (!stored) return { state: "pending", findings: [] };
  return { state: stored.state, findings: stored.findings ?? [] };
}

const queue: string[] = [];
const queued = new Set<string>();
let running = 0;
const idle: Array<() => void> = [];

/** Review a saved revision in the background (after its save commits). */
export function queueReview(revisionId: string) {
  if (!contentModels() || config.CONTENT_FILTER_MODE === "off") return;
  if (queued.has(revisionId)) return;
  queued.add(revisionId);
  queue.push(revisionId);
  pump();
}

function pump() {
  while (running < 2 && queue.length) {
    const revisionId = queue.shift()!;
    running++;
    reviewRevision(revisionId)
      .catch(() =>
        console.error(JSON.stringify({ event: "moderation.model_review_failed" })),
      )
      .finally(() => {
        running--;
        queued.delete(revisionId);
        pump();
        if (!running && !queue.length) for (const done of idle.splice(0)) done();
      });
  }
}

/** Tests: wait until every queued review is done. */
export function reviewsSettled() {
  return !running && !queue.length
    ? Promise.resolve()
    : new Promise<void>((resolve) => idle.push(resolve));
}

// Scripts nobody needs a model to read: known library builds (sha256).
let knownScripts: Set<string> | null = null;
function knownScript(hash: string) {
  if (!knownScripts) {
    knownScripts = new Set();
    try {
      const source = readFileSync(
        new URL("./content-filter/lists/known_scripts.txt", import.meta.url),
        "utf8",
      );
      for (const line of source.split("\n")) {
        const value = line.replace(/#.*$/, "").trim();
        if (/^[a-f0-9]{64}$/.test(value)) knownScripts.add(value);
      }
    } catch {
      // No list: every script is read.
    }
  }
  return knownScripts.has(hash);
}

/** A compact view of a page's scripts: deduplicated, known libraries skipped. */
function codeSummary(scripts: string[]) {
  const seen = new Set<string>();
  let summary = "";
  for (const script of scripts) {
    const hash = sha256(script);
    if (seen.has(hash) || knownScript(hash)) continue;
    seen.add(hash);
    const room = MAX_CODE_CHARS - summary.length;
    if (room <= 200) break;
    summary += `\n// --- script ${seen.size} (${script.length} chars)\n${script.slice(0, room - 60)}`;
  }
  return summary.trim();
}

/** What a revision shows: its text, images and scripts, bounded. */
async function revisionMaterial(revision: any) {
  let text = "";
  const images: string[] = [];
  const scripts: string[] = [];
  if (revision.mime === "text/html") {
    const bytes = await readBlob(revision.object_key, revision.object_version);
    const inspection = await inspectHtmlBounded(bytes.toString("utf8"), undefined, {
      sample: true,
      images: config.CONTENT_MODEL_IMAGES,
      scripts: true,
    });
    text = inspection.sample ?? "";
    images.push(...(inspection.images ?? []));
    scripts.push(...(inspection.scripts ?? []));
    if (revision.storage_kind === "bundle")
      for (const file of (
        await db.query(
          `SELECT mime,object_key,object_version,size FROM revision_files
           WHERE revision_id=$1 AND (mime LIKE 'image/%' OR mime='text/javascript')
           ORDER BY file_index LIMIT 64`,
          [revision.id],
        )
      ).rows) {
        if (file.mime === "text/javascript" && scripts.join("").length < MAX_CODE_CHARS * 4)
          scripts.push((await readBlob(file.object_key, file.object_version)).toString("utf8"));
        else if (
          file.mime.startsWith("image/") &&
          config.CONTENT_MODEL_IMAGES &&
          images.length < 4 &&
          Number(file.size) <= MAX_IMAGE_BYTES
        )
          images.push(
            `data:${file.mime};base64,${(await readBlob(file.object_key, file.object_version)).toString("base64")}`,
          );
      }
  } else if (revision.mime === "text/plain") {
    const bytes = await readBlob(revision.object_key, revision.object_version);
    text = bytes.subarray(0, 96_000).toString("utf8");
  } else if (
    revision.mime.startsWith("image/") &&
    config.CONTENT_MODEL_IMAGES &&
    Number(revision.size) <= MAX_IMAGE_BYTES
  ) {
    const bytes = await readBlob(revision.object_key, revision.object_version);
    images.push(`data:${revision.mime};base64,${bytes.toString("base64")}`);
  }
  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    images: images.filter((image) => image.length <= MAX_IMAGE_BYTES * 1.4).slice(0, 4),
    code: codeSummary(scripts),
  };
}

let budgetLetterSent = "";

async function charge(costRub: number) {
  if (!spend(costRub)) return;
  const day = new Date().toISOString().slice(0, 10);
  if (budgetLetterSent === day) return;
  budgetLetterSent = day;
  console.error(JSON.stringify({ event: "moderation.model_budget_spent" }));
  if (config.OPERATOR_EMAIL && config.MAIL_MODE !== "disabled")
    await sendMail({
      to: config.OPERATOR_EMAIL,
      subject: "Полка: дневной бюджет проверки моделью исчерпан",
      text: `Сегодня на проверку моделями потрачено ${spentToday().toFixed(0)} ₽ из ${config.CONTENT_MODEL_DAILY_BUDGET_RUB} ₽ (CONTENT_MODEL_DAILY_BUDGET_RUB). До конца суток (UTC) работают только правила, а изображения новых аккаунтов ждут проверки. Непроверенные версии будут проверены повторно.`,
    }).catch(() => undefined);
}

async function ask(client: ModelClient, input: { text?: string; image?: string }) {
  // A flat-rate key costs nothing: the budget stops only paid calls.
  if (!client.flatRate && !budgetLeft())
    return { failed: "budget", model: client.name, costRub: 0 } as ModelAnswer;
  const answer = await client.classify(input);
  await charge(answer.costRub);
  return answer;
}

const describe = (answer: ModelAnswer | null) =>
  !answer ? "—" : answered(answer) ? answer.category : `ошибка: ${answer.failed}`;

/**
 * Ask the models about one revision: the primary; the second model when the
 * primary fails or flags something (a confirmation from another family); the
 * code model for scripts. Store the verdict, then decide existing links again.
 */
export async function reviewRevision(revisionId: string) {
  const pair = contentModels();
  if (!pair || config.CONTENT_FILTER_MODE === "off") return null;
  const {
    rows: [revision],
  } = await db.query(
    `SELECT id,tenant_id,artifact_id,mime,storage_kind,object_key,object_version,
       size,content_filter,content_purged_at
     FROM revisions WHERE id=$1`,
    [revisionId],
  );
  if (!revision || revision.content_purged_at) return null;
  if (await isolatedObject(revision.object_key)) return null;
  const previous = revision.content_filter?.model as StoredModel | undefined;
  if (previous?.state === "unchecked" && previous.attempts >= MAX_ATTEMPTS) return null;
  const material = await revisionMaterial(revision);
  const hash = sha256(
    JSON.stringify([material.text, material.images.map((image) => sha256(image)), material.code]),
  );
  if (previous?.state === "checked" && previous.hash === hash) return previous;
  // The same material checked before (a re-save): its verdict, no new calls.
  const {
    rows: [cached],
  } = await db.query(
    `SELECT content_filter->'model' AS model FROM revisions
     WHERE tenant_id=$1 AND id<>$2 AND content_filter->'model'->>'hash'=$3
       AND content_filter->'model'->>'state'='checked'
     LIMIT 1`,
    [revision.tenant_id, revisionId, hash],
  );
  let stored: StoredModel;
  if (cached?.model) stored = { ...cached.model, at: new Date().toISOString() };
  else {
    const findings: ModelFinding[] = [];
    const answers: StoredModel["answers"] = [];
    let calls = 0,
      failures = 0,
      // Failures only because an endpoint was at its rate limit: the model
      // did not fail, so they do not use up the revision's attempts.
      limited = 0;
    const rateLimited = (answer: ModelAnswer | CodeReview | null) =>
      !answer || ("failed" in answer && answer.failed === "rate_limited");
    const second = async (
      source: ModelFinding["source"],
      input: { text?: string; image?: string },
    ) => {
      calls++;
      const primary = await ask(pair.primary, input);
      let confirm: ModelAnswer | null = null;
      // gpt-oss is not multimodal: an image gets no second model.
      const canConfirm = pair.fallback && source === "text";
      if (!answered(primary)) {
        // A failed or rate-limited primary (429): the fallback at once.
        if (canConfirm) confirm = await ask(pair.fallback!, input);
        if (!answered(confirm)) {
          failures++;
          if (rateLimited(primary) && (!canConfirm || rateLimited(confirm))) limited++;
        }
      } else if (primary.category !== "none" && canConfirm)
        confirm = await ask(pair.fallback!, input);
      answers.push({ source, model: pair.primary.name, answer: describe(primary) });
      if (confirm)
        answers.push({ source, model: pair.fallback!.name, answer: describe(confirm) });
      const flagged = answered(primary) && primary.category !== "none" ? primary : null;
      if (flagged)
        findings.push({
          category: flagged.category as Category,
          agreed: answered(confirm) && confirm.category === flagged.category,
          source,
          reason: flagged.reason,
        });
      else if (!answered(primary) && answered(confirm) && confirm.category !== "none")
        findings.push({ category: confirm.category, agreed: false, source, reason: confirm.reason });
    };
    if (material.text.trim()) await second("text", { text: material.text });
    for (const image of material.images) {
      await second("image", { image });
      if (config.CONTENT_VISION_MODERATION) {
        const vision = await visionModeration(image);
        if (vision && (vision.adult > 0.5 || vision.gruesome > 0.5)) {
          const category: Category = vision.adult > 0.5 ? "porn" : "other" as never;
          const same = findings.find((finding) => finding.source === "image" && finding.category === category);
          if (same) same.agreed = true;
          else
            findings.push({
              category: vision.adult > 0.5 ? "porn" : "extremism_terror",
              agreed: false,
              source: "vision",
              reason: `Yandex Vision: adult ${vision.adult.toFixed(2)}, gruesome ${vision.gruesome.toFixed(2)}`,
            });
        }
      }
    }
    const codeModel = codeModelClient();
    if (material.code && codeModel) {
      calls++;
      const review =
        codeModel.flatRate || budgetLeft() ? await codeModel.review(material.code) : null;
      if (review) await charge(review.costRub);
      if (!review || "failed" in review) {
        failures++;
        if (review && rateLimited(review)) limited++;
      } else {
        answers.push({ source: "code", model: codeModel.name, answer: review.verdict });
        if (review.verdict !== "safe")
          findings.push({
            category: "malicious_code",
            // Both the rules and the model: a block. The model alone: review.
            agreed:
              review.verdict === "malicious" &&
              !!revision.content_filter?.hits?.malicious_code,
            source: "code",
            reason: review.reasons.join("; ").slice(0, 150),
          });
      }
    }
    const unchecked = calls > 0 && failures === calls;
    stored = {
      state: unchecked ? "unchecked" : "checked",
      hash,
      attempts: (previous?.attempts ?? 0) + (unchecked && limited === failures ? 0 : 1),
      at: new Date().toISOString(),
      findings,
      answers,
    };
  }
  await db.query(
    "UPDATE revisions SET content_filter=content_filter||jsonb_build_object('model',$2::jsonb) WHERE id=$1",
    [revisionId, JSON.stringify(stored)],
  );
  if (stored.findings.length) {
    await recordEvent(db, {
      actor: "model",
      action: "revision.reviewed",
      category: stored.findings[0]!.category,
      tenantId: revision.tenant_id,
      artifactId: revision.artifact_id ?? null,
      revisionId,
      details: {
        findings: stored.findings.map((finding) =>
          finding.category === "csam"
            ? { category: "csam", agreed: finding.agreed, source: finding.source }
            : finding,
        ),
        answers: stored.answers,
      },
    });
  }
  // Whatever the models said, links to the revision are decided again: a
  // finding makes them stricter; a clean answer releases a link that waited
  // only for the model. A failed review keeps it waiting.
  const { reconsiderLinks } = await import("./shares.ts");
  await reconsiderLinks(revisionId);
  return stored;
}

/** Unchecked revisions of the last week, tried again by the sweep. */
export async function retryUnchecked(limit = 20) {
  if (!contentModels() || !budgetLeft()) return 0;
  const { rows } = await db.query(
    `SELECT id FROM revisions
     WHERE created_at>now()-interval '7 days' AND content_purged_at IS NULL
       AND content_filter->'model'->>'state'='unchecked'
       AND (content_filter->'model'->>'attempts')::int<$1
     ORDER BY created_at DESC LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  for (const row of rows) queueReview(row.id);
  return rows.length;
}

/**
 * Yandex Vision's «moderation» classifier (adult, gruesome): an extra image
 * signal, off unless CONTENT_VISION_MODERATION. The folder and the key come
 * from the first role on Yandex AI Studio (its model URI gpt://<folder>/…).
 */
async function visionModeration(dataUrl: string) {
  const endpoints = config.CONTENT_MODEL_ENDPOINTS;
  const yandex = [
    [endpoints?.primary, config.CONTENT_MODEL_PRIMARY],
    [endpoints?.fallback, config.CONTENT_MODEL_FALLBACK],
    [endpoints?.code, config.CONTENT_CODE_MODEL],
  ].find(([endpoint]) => (endpoint as ModelEndpoint | null)?.provider === "yandex") as
    | [ModelEndpoint, string | undefined]
    | undefined;
  const folder = /^gpt:\/\/([^/]+)\//.exec(yandex?.[1] ?? "")?.[1];
  const key = yandex?.[0].key;
  const content = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!folder || !key) return null;
  try {
    const response = await fetch("https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze", {
      method: "POST",
      signal: AbortSignal.timeout(config.CONTENT_MODEL_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        authorization: `Api-Key ${key}`,
        "x-data-logging-enabled": "false",
      },
      body: JSON.stringify({
        folderId: folder,
        analyze_specs: [
          {
            content,
            features: [{ type: "CLASSIFICATION", classificationConfig: { model: "moderation" } }],
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const body: any = await response.json();
    const properties: Array<{ name: string; probability: number }> =
      body?.results?.[0]?.results?.[0]?.classification?.properties ?? [];
    const probability = (name: string) =>
      Number(properties.find((item) => item.name === name)?.probability ?? 0);
    return { adult: probability("adult"), gruesome: probability("gruesome") };
  } catch {
    return null;
  }
}
