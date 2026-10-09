// Proposals to «Лента» from a department shelf (docs/specs/DISCOVER_V2.md,
// «Предложение с полки отдела»). «Лента» is the operator's editorial
// selection: a curator or admin of the shelf proposes one version of a work,
// the operator reviews it by hand (npm run feed:proposals) and, if it fits,
// publishes a copy through the existing editorial path. The proposal itself
// publishes nothing.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { createFeedProposalInput, type FeedProposal } from "../../packages/contracts/feed-proposal.ts";
import { audit, type Actor } from "./artifacts.ts";
import { limitAttempts } from "./auth.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { lockShelf } from "./shelves.ts";
import { readBlob } from "./storage.ts";

/** Proposals one account may send a day (DISCOVER_V2 §5 says 3 for authors; a curator answers for a department). */
export const FEED_PROPOSALS_PER_DAY = 10;

const columns = `p.id,p.revision_id AS "revisionId",r.number AS "revisionNumber",
  p.title,p.summary,p.state,p.reason,
  COALESCE(a.display_name,a.name) AS "proposedBy",
  p.created_at AS "createdAt",p.decided_at AS "decidedAt"`;

const fromProposals = `FROM feed_proposals p
  JOIN revisions r ON r.id=p.revision_id
  LEFT JOIN accounts a ON a.id=p.proposed_by`;

const view = (row: any): FeedProposal => ({
  ...row,
  revisionNumber: Number(row.revisionNumber),
  createdAt: new Date(row.createdAt).toISOString(),
  decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
});

const teamOnly = (tenant: { kind: string }) => {
  if (tenant.kind !== "team") throw new Problem(409, "conflict", "В Ленту предлагают работы с полки отдела.");
};

async function latest(c: Pick<PoolClient, "query">, tenantId: string, artifactId: string) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT ${columns} ${fromProposals}
     WHERE p.tenant_id=$1 AND p.artifact_id=$2
     ORDER BY p.created_at DESC,p.id DESC LIMIT 1`,
    [tenantId, artifactId],
  );
  return row ? view(row) : null;
}

async function lockWork(c: PoolClient, actor: Actor, artifactId: string) {
  const {
    rows: [artifact],
  } = await c.query(
    `SELECT id FROM artifacts WHERE id=$1 AND tenant_id=$2
       AND trashed_at IS NULL AND purged_at IS NULL FOR UPDATE`,
    [artifactId, actor.tenant],
  );
  if (!artifact) throw missing();
}

/** The work's latest proposal, for any member of the shelf. */
export async function readFeedProposal(actor: Actor, artifactId: string) {
  return transaction(async (c) => {
    const { tenant } = await lockShelf(c, actor, "reader", "SHARE");
    if (tenant.kind !== "team") return { proposal: null };
    const found = await c.query("SELECT 1 FROM artifacts WHERE id=$1 AND tenant_id=$2 AND purged_at IS NULL", [
      artifactId,
      actor.tenant,
    ]);
    if (!found.rowCount) throw missing();
    return { proposal: await latest(c, actor.tenant, artifactId) };
  });
}

/** A curator or admin proposes one version of the work to «Лента». */
export async function proposeToFeed(actor: Actor, artifactId: string, body: unknown) {
  const input = createFeedProposalInput.parse(body);
  return transaction(async (c) => {
    const { tenant } = await lockShelf(c, actor, "curator");
    teamOnly(tenant);
    await lockWork(c, actor, artifactId);
    const {
      rows: [revision],
    } = await c.query(
      `SELECT storage_kind,mime,html_profile FROM revisions
       WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3 AND content_purged_at IS NULL`,
      [input.revisionId, artifactId, actor.tenant],
    );
    if (!revision) throw missing();
    // What the editorial path can show: one HTML page that opens in the
    // ordinary viewer (editorial.ts, PUBLICATION_USABLE).
    if (
      revision.storage_kind !== "single" ||
      revision.mime !== "text/html" ||
      !["static", "limited"].includes(revision.html_profile)
    )
      throw new Problem(
        422,
        "unsupported",
        "В Ленту можно предложить одну HTML-страницу, которая открывается в обычном просмотре.",
      );
    const pending = await c.query("SELECT 1 FROM feed_proposals WHERE artifact_id=$1 AND state='pending'", [
      artifactId,
    ]);
    if (pending.rowCount) throw new Problem(409, "conflict", "Эта работа уже ждёт решения Редакции.");
    await limitAttempts(`feed-proposal:${actor.id}`, FEED_PROPOSALS_PER_DAY, "24 hours");
    const id = randomUUID();
    await c.query(
      `INSERT INTO feed_proposals(id,tenant_id,artifact_id,revision_id,proposed_by,title,summary)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.tenant, artifactId, input.revisionId, actor.id, input.title, input.summary],
    );
    await audit(c, actor, "feed.proposed", artifactId, {
      artifactId,
      revisionId: input.revisionId,
    });
    return { proposal: await latest(c, actor.tenant, artifactId) };
  });
}

/** A curator or admin takes the waiting proposal back. */
export async function withdrawFeedProposal(actor: Actor, artifactId: string) {
  return transaction(async (c) => {
    const { tenant } = await lockShelf(c, actor, "curator");
    teamOnly(tenant);
    await lockWork(c, actor, artifactId);
    const { rowCount } = await c.query(
      `UPDATE feed_proposals SET state='withdrawn',decided_at=clock_timestamp()
       WHERE artifact_id=$1 AND tenant_id=$2 AND state='pending'`,
      [artifactId, actor.tenant],
    );
    if (!rowCount) throw new Problem(409, "conflict", "Предложение уже рассмотрено или отозвано.");
    await audit(c, actor, "feed.proposal_withdrawn", artifactId, { artifactId });
    return { proposal: await latest(c, actor.tenant, artifactId) };
  });
}

/**
 * The work went to the trash or is being deleted: a waiting proposal goes
 * with it. The caller holds the work's lock.
 */
export async function withdrawFeedProposalsOfWork(c: Pick<PoolClient, "query">, artifactId: string) {
  await c.query(
    `UPDATE feed_proposals SET state='withdrawn',decided_at=clock_timestamp()
     WHERE artifact_id=$1 AND state='pending'`,
    [artifactId],
  );
}

// ——— The operator (scripts/feed-proposals.ts) ———

export type OperatorFeedProposal = FeedProposal & {
  artifactId: string;
  shelfId: string;
  shelfName: string | null;
  workTitle: string;
};

export async function listFeedProposalsForOperator(all = false): Promise<OperatorFeedProposal[]> {
  const { rows } = await db.query(
    `SELECT ${columns},p.artifact_id AS "artifactId",p.tenant_id AS "shelfId",
            t.name AS "shelfName",w.title AS "workTitle"
     ${fromProposals}
     JOIN tenants t ON t.id=p.tenant_id
     JOIN artifacts w ON w.id=p.artifact_id
     WHERE $1::boolean OR p.state='pending'
     ORDER BY p.created_at,p.id LIMIT 500`,
    [all],
  );
  return rows.map((row) => ({
    ...view(row),
    artifactId: row.artifactId,
    shelfId: row.shelfId,
    shelfName: row.shelfName,
    workTitle: row.workTitle,
  }));
}

/** The proposed version's bytes, for the operator to review and copy into content/editorial. */
export async function feedProposalSource(id: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT p.state,r.object_key,r.object_version,r.sha256 FROM feed_proposals p
     JOIN revisions r ON r.id=p.revision_id
     JOIN artifacts w ON w.id=p.artifact_id
     WHERE p.id=$1 AND w.trashed_at IS NULL AND w.purged_at IS NULL AND r.content_purged_at IS NULL`,
    [id],
  );
  if (!row) throw missing();
  if (row.state !== "pending") throw new Problem(409, "conflict", "Предложение уже рассмотрено или отозвано.");
  return { bytes: await readBlob(row.object_key, row.object_version), sha256: row.sha256 as string };
}

/**
 * The operator's decision. «published» only records that the copy went
 * through the editorial path; «rejected» needs a reason the shelf will see.
 */
export async function decideFeedProposal(id: string, decision: "published" | "rejected", reason: string | null) {
  const text = reason?.trim() || null;
  if (decision === "rejected" && !text)
    throw new Problem(422, "invalid", "Объясните кураторам, почему работа не подходит.");
  if (text && text.length > 500) throw new Problem(422, "invalid", "Причина — до 500 символов.");
  const { rows } = await db.query(
    `UPDATE feed_proposals SET state=$2,reason=$3,decided_at=clock_timestamp()
     WHERE id=$1 AND state='pending' RETURNING id`,
    [id, decision, text],
  );
  if (!rows.length) throw new Problem(409, "conflict", "Предложение уже рассмотрено, отозвано или не найдено.");
  return { id, state: decision };
}
