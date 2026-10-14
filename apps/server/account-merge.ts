// One person, one shelf: moves everything of a SOURCE account and its tenant
// into a TARGET account and disables the source (docs/specs/
// SIGN_IN_PROVIDERS.md § 9). Used by the operator (scripts/account-merge.ts)
// and by «Объединить» when a provisional shelf meets its owner's existing one
// (claim-routes.ts).
//
// What moves: folders (same name → the target's folder), works with their
// versions, files and prepared versions, links (their tokens do not change,
// so old links keep opening), the discussions of those links, agent
// connections with their tokens and refresh tokens (they keep working and now
// save to the target), upload and import receipts, the audit trail, provider
// identities the target does not already have, template library
// memberships, notes and comments the source wrote elsewhere, its usage
// analytics (re-keyed; its sign-up event is dropped), and its agent sessions
// with their transcripts, allowance and fingerprint key. MERGE_INVENTORY
// lists every column that names an account or a shelf and what happens to it.
//
// Objects in storage live under `<tenant>/…`, and deletion purges a tenant by
// that prefix, so every object of the source is copied to the same path
// under the target's prefix and the rows point at the copies. The copies are
// made under the locks, before the rows change; the originals are deleted
// after the commit. A failure rolls the rows back and deletes the copies.
//
// Refused: the same account twice, a disabled or deleting account on either
// side, blocked content in the source, editorial publications of the source,
// and work in flight (an unfinished upload, URL import or preview build).
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { PoolClient } from "pg";
import { actorKey } from "./analytics-keys.ts";
import { audit } from "./artifacts.ts";
import { recordEvent } from "./content-moderation.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { checkAccountMerge, runAccountMerged } from "./extensions.ts";
import { requestDeletionRows } from "./provisional-maintenance.ts";
import { bucket, copyVersion, s3 } from "./storage.ts";
import { UUID_RE } from "../../packages/contracts/uuid.ts";

type Queryable = Pick<PoolClient, "query">;

export class MergeRefusal extends Error {}

/** Copies and deletes object versions (storage.ts in production). */
export type ObjectMover = {
  copy(fromKey: string, fromVersion: string, toKey: string): Promise<string>;
  remove(key: string, version: string): Promise<void>;
};

export const s3Mover: ObjectMover = {
  copy: copyVersion,
  async remove(key, version) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
  },
};

export type MergeAccount = {
  id: string;
  name: string;
  email: string | null;
  displayName: string | null;
  tenant: string;
  disabled: boolean;
  deleting: boolean;
  provisional: boolean;
};

/** An account by its id, address or login. */
export async function findMergeAccount(ref: string, q: Queryable = db): Promise<MergeAccount | null> {
  const value = ref.trim();
  const column = UUID_RE.test(value) ? "a.id::text" : value.includes("@") ? "a.email" : "a.name";
  const {
    rows: [row],
  } = await q.query(
    `SELECT a.id,a.name,a.email,a.display_name,a.disabled,
            a.deletion_requested_at IS NOT NULL AS deleting,
            (a.provisional_at IS NOT NULL AND a.claimed_at IS NULL) AS provisional,
            t.id AS tenant
       FROM accounts a JOIN tenants t ON t.owner_id=a.id
      WHERE ${column}=$1`,
    [column === "a.email" ? value.toLowerCase() : value],
  );
  return row
    ? {
        id: row.id,
        name: row.name,
        email: row.email,
        displayName: row.display_name,
        tenant: row.tenant,
        disabled: row.disabled,
        deleting: row.deleting,
        provisional: row.provisional,
      }
    : null;
}

export type MergeCounts = {
  folders: number;
  foldersJoined: number;
  artifacts: number;
  revisions: number;
  objects: number;
  shares: number;
  activeShares: number;
  discussions: number;
  commentsAuthored: number;
  agentConnections: number;
  activeAgentConnections: number;
  refreshTokens: number;
  identities: number;
  identitiesKept: string[];
  libraryMemberships: number;
  analyticsEvents: number;
  sessionsEnded: number;
  /** Agent sessions (docs/specs/AGENT_SESSIONS.md) that move… */
  agentSessions: number;
  /** …of which also on the target (same agent, same id): the later upload stays. */
  agentSessionsTwice: number;
  sourceBytes: number;
  derivativeBytes: number;
};

export type MergeReport = {
  dryRun: boolean;
  from: { id: string; name: string; tenant: string };
  into: { id: string; name: string; tenant: string };
  counts: MergeCounts;
  /** Things the operator should know (an address that stayed, a quota). */
  notes: string[];
  /** Originals that could not be deleted after the commit (retry by hand). */
  leftovers: Array<{ key: string; version: string }>;
};

async function lockPair(c: PoolClient, from: MergeAccount, into: MergeAccount) {
  // Tenant, then account, as everywhere else; two of each in id order so
  // two merges (or a merge and a sign-in) never wait on each other in turn.
  await c.query("SELECT id FROM tenants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[from.tenant, into.tenant]]);
  const { rows } = await c.query(
    `SELECT id,name,email,display_name,disabled,
            deletion_requested_at IS NOT NULL AS deleting,
            (provisional_at IS NOT NULL AND claimed_at IS NULL) AS provisional
       FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[from.id, into.id]],
  );
  const current = new Map(rows.map((row) => [row.id as string, row]));
  const check = (account: MergeAccount, role: string) => {
    const row = current.get(account.id);
    const owner = rows.length === 2 && row;
    if (!owner) throw new MergeRefusal(`${role}: аккаунт не найден.`);
    if (row.disabled || row.deleting) throw new MergeRefusal(`${role} (${row.name}): аккаунт отключён или удаляется.`);
    return {
      ...account,
      email: row.email,
      displayName: row.display_name,
      provisional: row.provisional,
    };
  };
  return { from: check(from, "Источник"), into: check(into, "Получатель") };
}

async function refuseUnsafeSource(c: Queryable, from: MergeAccount) {
  const {
    rows: [row],
  } = await c.query(
    `SELECT
       EXISTS(SELECT 1 FROM moderation_blocks
               WHERE tenant_id=$1 AND released_at IS NULL) AS blocked_blocks,
       EXISTS(SELECT 1 FROM shares
               WHERE tenant_id=$1 AND moderation='blocked') AS blocked_shares,
       EXISTS(SELECT 1 FROM comments
               WHERE author_account_id=$2 AND blocked_at IS NOT NULL) AS blocked_comments,
       EXISTS(SELECT 1 FROM editorial_publications WHERE tenant_id=$1) AS editorial,
       EXISTS(SELECT 1 FROM uploads
               WHERE tenant_id=$1 AND receipt IS NULL AND reconciled_at IS NULL) AS uploads,
       EXISTS(SELECT 1 FROM url_import_jobs
               WHERE tenant_id=$1
                 AND state IN ('queued','fetching','prepared','saving','previewing')) AS imports,
       EXISTS(SELECT 1 FROM revision_derivatives
               WHERE tenant_id=$1 AND state='pending') AS builds`,
    [from.tenant, from.id],
  );
  if (row.blocked_blocks || row.blocked_shares || row.blocked_comments)
    throw new MergeRefusal(
      "В источнике есть заблокированное содержимое. Объединение запрещено: сначала разберите блокировку (admin moderation events).",
    );
  if (row.editorial) throw new MergeRefusal("У источника есть публикации в «Открытиях». Объединение не переносит их.");
  if (row.uploads || row.imports || row.builds)
    throw new MergeRefusal(
      "В источнике идёт загрузка, импорт или сборка. Повторите через несколько минут (или после npm run maintenance).",
    );
}

async function count(c: Queryable, from: MergeAccount, into: MergeAccount): Promise<MergeCounts> {
  const {
    rows: [row],
  } = await c.query(
    `SELECT
       (SELECT count(*) FROM folders WHERE tenant_id=$1) AS folders,
       (SELECT count(*) FROM folders s WHERE s.tenant_id=$1
          AND EXISTS(SELECT 1 FROM folders t WHERE t.tenant_id=$3 AND t.name=s.name)) AS folders_joined,
       (SELECT count(*) FROM artifacts WHERE tenant_id=$1) AS artifacts,
       (SELECT count(*) FROM revisions WHERE tenant_id=$1) AS revisions,
       (SELECT count(*) FROM shares WHERE tenant_id=$1) AS shares,
       (SELECT count(*) FROM shares WHERE tenant_id=$1 AND NOT revoked AND expires_at>now()) AS active_shares,
       (SELECT count(*) FROM comments WHERE tenant_id=$1) AS discussions,
       (SELECT count(*) FROM comments WHERE author_account_id=$2 AND tenant_id<>$1) AS comments_authored,
       (SELECT count(*) FROM agent_connections WHERE tenant_id=$1) AS connections,
       (SELECT count(*) FROM agent_connections WHERE tenant_id=$1
          AND revoked_at IS NULL AND expires_at>now()) AS active_connections,
       (SELECT count(*) FROM oauth_refresh_tokens WHERE tenant_id=$1
          AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at>now()) AS refresh_tokens,
       (SELECT count(*) FROM template_library_members
          WHERE account_id=$2 AND state='active') AS memberships,
       (SELECT count(*) FROM analytics_events WHERE actor=$4) AS analytics,
       (SELECT count(*) FROM sessions WHERE account_id=$2) AS sessions,
       (SELECT used_bytes FROM tenants WHERE id=$1) AS source_bytes,
       (SELECT derivative_used_bytes FROM tenants WHERE id=$1) AS derivative_bytes,
       (SELECT count(*) FROM (
          SELECT object_key FROM revisions WHERE tenant_id=$1
          UNION SELECT f.object_key FROM revision_files f
                  JOIN revisions r ON r.id=f.revision_id WHERE r.tenant_id=$1
          UNION SELECT object_key FROM revision_derivatives
                 WHERE tenant_id=$1 AND object_key IS NOT NULL
          UNION SELECT transcript_key FROM agent_sessions
                 WHERE tenant_id=$1 AND transcript_key IS NOT NULL) keys) AS objects,
       (SELECT count(*) FROM agent_sessions WHERE tenant_id=$1) AS agent_sessions,
       (SELECT count(*) FROM agent_sessions s JOIN agent_sessions t
           ON t.tenant_id=$3 AND t.source=s.source AND t.external_id=s.external_id
         WHERE s.tenant_id=$1) AS agent_sessions_twice`,
    [from.tenant, from.id, into.tenant, actorKey(from.id)],
  );
  const { rows: identities } = await c.query(
    `SELECT s.provider,
            EXISTS(SELECT 1 FROM account_identities t
                    WHERE t.account_id=$2 AND t.provider=s.provider) AS kept
       FROM account_identities s WHERE s.account_id=$1 ORDER BY s.provider`,
    [from.id, into.id],
  );
  const n = (value: unknown) => Number(value ?? 0);
  return {
    folders: n(row.folders),
    foldersJoined: n(row.folders_joined),
    artifacts: n(row.artifacts),
    revisions: n(row.revisions),
    objects: n(row.objects),
    shares: n(row.shares),
    activeShares: n(row.active_shares),
    discussions: n(row.discussions),
    commentsAuthored: n(row.comments_authored),
    agentConnections: n(row.connections),
    activeAgentConnections: n(row.active_connections),
    refreshTokens: n(row.refresh_tokens),
    identities: identities.filter((item) => !item.kept).length,
    identitiesKept: identities.filter((item) => item.kept).map((item) => item.provider as string),
    libraryMemberships: n(row.memberships),
    analyticsEvents: n(row.analytics),
    sessionsEnded: n(row.sessions),
    agentSessions: n(row.agent_sessions),
    agentSessionsTwice: n(row.agent_sessions_twice),
    sourceBytes: n(row.source_bytes),
    derivativeBytes: n(row.derivative_bytes),
  };
}

type StoredObject = {
  key: string;
  version: string;
  /** The content was purged by moderation: rename, nothing to copy. */
  gone: boolean;
};

async function sourceObjects(c: Queryable, tenant: string) {
  const { rows } = await c.query(
    `SELECT object_key AS key,object_version AS version,
            content_purged_at IS NOT NULL AS gone
       FROM revisions WHERE tenant_id=$1
     UNION
     SELECT f.object_key,f.object_version,r.content_purged_at IS NOT NULL
       FROM revision_files f JOIN revisions r ON r.id=f.revision_id
      WHERE r.tenant_id=$1
     UNION
     SELECT object_key,object_version,false FROM revision_derivatives
      WHERE tenant_id=$1 AND object_key IS NOT NULL
     UNION
     SELECT f.object_key,f.object_version,false
       FROM upload_files f JOIN uploads u ON u.id=f.upload_id
      WHERE u.tenant_id=$1 AND u.receipt IS NOT NULL
     UNION
     SELECT transcript_key,transcript_version,false FROM agent_sessions
      WHERE tenant_id=$1 AND transcript_key IS NOT NULL AND transcript_version IS NOT NULL`,
    [tenant],
  );
  // One copy per object version, even when several rows name it.
  const unique = new Map<string, StoredObject>();
  for (const row of rows as StoredObject[]) {
    const id = `${row.key}\u0000${row.version}`;
    const seen = unique.get(id);
    unique.set(id, seen ? { ...row, gone: seen.gone && row.gone } : row);
  }
  return [...unique.values()];
}

/**
 * Sessions sent to both shelves (the same agent and session id): the later
 * upload stays, as a second upload replaces the first; on a tie the
 * target's. Returns the transcripts of the rows deleted.
 */
async function dropTwiceSentSessions(c: Queryable, from: string, into: string) {
  const { rows } = await c.query(
    `DELETE FROM agent_sessions d USING agent_sessions s, agent_sessions t
      WHERE s.tenant_id=$1 AND t.tenant_id=$2 AND t.source=s.source AND t.external_id=s.external_id
        AND d.id = CASE WHEN s.updated_at > t.updated_at THEN t.id ELSE s.id END
     RETURNING d.transcript_key AS key, d.transcript_version AS version`,
    [from, into],
  );
  return (rows as Array<{ key: string | null; version: string | null }>).filter(
    (row): row is { key: string; version: string } => !!row.key && !!row.version,
  );
}

/**
 * Agent sessions move with their transcripts (already copied, `objectMap`),
 * their allowance and their fingerprint key. Fingerprints are HMACs made on
 * the person's machine with the shelf's key, and the server never has the
 * values, so they cannot be re-keyed: a target without a key of its own
 * takes the source's (every fingerprint stays comparable); a target with
 * one keeps it, and the moved sessions keep fingerprints of the old key
 * until they are sent again (docs/specs/AGENT_SESSIONS.md).
 */
async function moveAgentSessions(c: Queryable, from: MergeAccount, into: MergeAccount, objectMap: string) {
  const moved = await c.query(
    `UPDATE agent_sessions s SET tenant_id=$2, account_id=$3,
            transcript_key=COALESCE(m.new_key, s.transcript_key),
            transcript_version=COALESCE(m.new_version, s.transcript_version)
       FROM agent_sessions o
       LEFT JOIN (SELECT * FROM jsonb_to_recordset($4::jsonb)
                    AS x(old_key text,old_version text,new_key text,new_version text)) m
         ON m.old_key=o.transcript_key AND m.old_version=o.transcript_version
      WHERE o.id=s.id AND s.tenant_id=$1
     RETURNING s.transcript_key`,
    [from.tenant, into.tenant, into.id, objectMap],
  );
  if (moved.rows.some((row) => row.transcript_key && !String(row.transcript_key).startsWith(`${into.tenant}/`)))
    throw new MergeRefusal("Не все расшифровки сессий агентов нашли свои объекты хранилища. Объединение отменено.");
  // Only a personal shelf holds sessions, so none of the source is elsewhere; just in case.
  await c.query("UPDATE agent_sessions SET account_id=$2 WHERE account_id=$1", [from.id, into.id]);
  await c.query(
    `UPDATE tenants t SET
            session_quota_bytes=GREATEST(t.session_quota_bytes, s.session_quota_bytes),
            session_fingerprint_key=COALESCE(t.session_fingerprint_key, s.session_fingerprint_key),
            session_used_bytes=(SELECT COALESCE(sum(transcript_bytes+index_bytes),0) FROM agent_sessions WHERE tenant_id=t.id)
       FROM tenants s WHERE t.id=$2 AND s.id=$1`,
    [from.tenant, into.tenant],
  );
  await c.query("UPDATE tenants SET session_used_bytes=0, session_fingerprint_key=NULL WHERE id=$1", [from.tenant]);
  return moved.rowCount ?? 0;
}

/**
 * Every column that ties a row to an account or a shelf (a foreign key to
 * accounts or tenants, or a column named tenant_id / account_id /
 * *_account_id), and what a merge does with it. tests/account-merge.test.ts
 * compares this with the schema: a new such column fails the test until it
 * is moved here or deliberately left, with the reason.
 */
export const MERGE_INVENTORY: Record<string, `moved${string}` | `left: ${string}` | `refused: ${string}`> = {
  "account_deletions.account_id": "left: the source's own deletion request",
  "account_deletions.tenant_id": "left: the source's own deletion request",
  "account_identities.account_id": "moved where the target has no such provider; the rest go with the source",
  "account_purge_jobs.account_id": "left: the source's own purge",
  "account_purge_jobs.tenant_id": "left: the source's own purge",
  "account_restore_suppressions.account_id": "left: about the source's own erasure",
  "account_restore_suppressions.tenant_id": "left: about the source's own erasure",
  "agent_connections.account_id": "moved (picked ones; the rest revoked first)",
  "agent_connections.tenant_id": "moved",
  "agent_operations.account_id": "moved",
  "agent_operations.tenant_id": "moved",
  "agent_read_days.tenant_id": "left: read counts of the source shelf, erased with it",
  "agent_sessions.account_id": "moved (moveAgentSessions)",
  "agent_sessions.tenant_id": "moved (moveAgentSessions)",
  "artifact_search.tenant_id": "moved with its work (foreign key ON UPDATE CASCADE, migration 075)",
  "artifacts.created_by": "moved on the source shelf; left: elsewhere authorship stays, as for any erased author",
  "artifacts.owner_account_id": "moved, on every shelf",
  "artifacts.tenant_id": "moved",
  "audit_outbox.actor_id": "moved on the source shelf; left: elsewhere the journal keeps who it was",
  "audit_outbox.tenant_id": "moved",
  "comment_reactions.author_account_id": "moved",
  "comment_reactions.tenant_id": "moved",
  "comments.author_account_id": "moved",
  "comments.resolved_by": "moved",
  "comments.tenant_id": "moved",
  "editorial_publications.tenant_id": "refused: a source with publications in «Открытия» is not merged",
  "feed_proposals.proposed_by": "moved",
  "feed_proposals.tenant_id": "left: proposals come from department shelves, which do not move",
  "folders.tenant_id": "moved (same name: joined)",
  "moderation_blocks.tenant_id": "moved (released ones; an active block refuses the merge)",
  "moderation_events.account_id": "left: the moderation record of the source, account.merged included",
  "moderation_events.tenant_id": "left: the moderation record of the source",
  "oauth_authorizations.account_id": "moved",
  "oauth_authorizations.tenant_id": "moved",
  "oauth_refresh_tokens.account_id": "moved",
  "oauth_refresh_tokens.tenant_id": "moved",
  "operator_sign_in_links.account_id": "left: an operator's sign-in link opens the source only, which is closed",
  "provisional_erasures.account_id": "refused: a shelf closed for erasure is disabled, which a merge refuses",
  "provisional_erasures.tenant_id": "refused: a shelf closed for erasure is disabled, which a merge refuses",
  "revision_derivatives.tenant_id": "moved",
  "revisions.created_by": "moved on the source shelf; left: elsewhere authorship stays, as for any erased author",
  "revisions.tenant_id": "moved",
  "service_principals.created_by": "left: history on a department shelf",
  "service_principals.responsible_account_id":
    "left: department shelves only; the source's erasure freezes them for a shelf admin to reassign",
  "service_principals.tenant_id": "left: department shelves only, which do not move",
  "sessions.account_id": "left: the source's sign-ins are ended",
  "share_reports.tenant_id": "moved",
  "shares.created_by": "moved on the source shelf",
  "shares.tenant_id": "moved",
  "template_libraries.created_by": "moved",
  "template_library_events.actor_id": "left: history",
  "template_library_events.target_account_id": "left: history",
  "template_library_invitations.accepted_by": "left: history",
  "template_library_invitations.invited_by": "left: history",
  "template_library_members.account_id": "moved (the higher role)",
  "template_library_publications.publisher_id": "left: history of who published to a library",
  "template_library_viewer_grants.member_account_id": "left: bound to the source's sign-ins, which end",
  "tenant_invitations.invited_by": "left: history",
  "tenant_invitations.tenant_id": "left: invitations are to department shelves, which do not move",
  "tenant_member_events.actor_id": "left: history (the merge adds its own events)",
  "tenant_member_events.target_account_id": "left: history",
  "tenant_member_events.tenant_id": "left: history of department shelves",
  "tenant_members.account_id": "moved (department shelves, the higher role)",
  "tenant_members.invited_by": "left: history",
  "tenant_members.tenant_id": "left: memberships of department shelves, which do not move",
  "tenants.created_by": "left: the source shelf itself, emptied and erased",
  "tenants.owner_id": "left: the source shelf itself, emptied and erased",
  "uploads.account_id": "moved",
  "uploads.tenant_id": "moved",
  "url_import_jobs.account_id": "moved",
  "url_import_jobs.tenant_id": "moved",
  "webhook_deliveries.tenant_id": "left: deleted with the source shelf's endpoints",
  "webhook_endpoints.created_by": "moved",
  "webhook_endpoints.tenant_id": "left: the source shelf's endpoints are deleted",
};

const ROLE_RANK = { reader: 1, curator: 2, admin: 3 } as const;
const SHELF_RANK = { reader: 1, author: 2, curator: 3, admin: 4 } as const;

/**
 * Department shelves (docs/specs/TEAM_SHELVES.md): the source's roles become
 * the target's, the higher of the two where both are members. The source's
 * own rows are revoked by the trigger on its deletion request (migration 044).
 */
async function moveShelfMemberships(c: PoolClient, from: MergeAccount, into: MergeAccount) {
  const { rows } = await c.query(
    `SELECT s.tenant_id,s.role,t.role AS target_role,t.state AS target_state
       FROM tenant_members s
       JOIN tenants shelf ON shelf.id=s.tenant_id AND shelf.kind='team'
       LEFT JOIN tenant_members t ON t.tenant_id=s.tenant_id AND t.account_id=$2
      WHERE s.account_id=$1 AND s.state='active'
      ORDER BY s.tenant_id
      FOR UPDATE OF s`,
    [from.id, into.id],
  );
  for (const row of rows) {
    const role = row.role as keyof typeof SHELF_RANK;
    const target = row.target_state === "active" ? (row.target_role as keyof typeof SHELF_RANK) : null;
    if (!target)
      await c.query(
        `INSERT INTO tenant_members(tenant_id,account_id,role,state,invited_by)
         VALUES($1,$2,$3,'active',$2)
         ON CONFLICT (tenant_id,account_id) DO UPDATE
           SET role=EXCLUDED.role,state='active',revoked_at=NULL,joined_at=clock_timestamp()`,
        [row.tenant_id, into.id, role],
      );
    else if (SHELF_RANK[role] > SHELF_RANK[target])
      await c.query("UPDATE tenant_members SET role=$3 WHERE tenant_id=$1 AND account_id=$2", [
        row.tenant_id,
        into.id,
        role,
      ]);
    await c.query(
      `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role,new_role)
       VALUES($1,$2,'member_added',$2,$3,$4)`,
      [row.tenant_id, into.id, target, target && SHELF_RANK[target] >= SHELF_RANK[role] ? target : role],
    );
  }
  return rows.length;
}

async function moveMemberships(c: PoolClient, from: MergeAccount, into: MergeAccount) {
  const { rows } = await c.query(
    `SELECT s.library_id,s.role,t.role AS target_role
       FROM template_library_members s
       LEFT JOIN template_library_members t
         ON t.library_id=s.library_id AND t.account_id=$2 AND t.state='active'
      WHERE s.account_id=$1 AND s.state='active'
      ORDER BY s.library_id
      FOR UPDATE OF s`,
    [from.id, into.id],
  );
  for (const row of rows) {
    const role = row.role as keyof typeof ROLE_RANK;
    const targetRole = row.target_role as keyof typeof ROLE_RANK | null;
    if (!targetRole)
      await c.query(
        `INSERT INTO template_library_members(library_id,account_id,role,state,joined_at)
         VALUES($1,$2,$3,'active',clock_timestamp())`,
        [row.library_id, into.id, role],
      );
    else if (ROLE_RANK[role] > ROLE_RANK[targetRole])
      await c.query(
        `UPDATE template_library_members SET role=$3
          WHERE library_id=$1 AND account_id=$2 AND state='active'`,
        [row.library_id, into.id, role],
      );
    await c.query(
      `UPDATE template_library_members
          SET state='revoked',revoked_at=clock_timestamp()
        WHERE library_id=$1 AND account_id=$2 AND state='active'`,
      [row.library_id, from.id],
    );
  }
  await c.query("UPDATE template_libraries SET created_by=$2 WHERE created_by=$1", [from.id, into.id]);
  return rows.length;
}

/**
 * Usage analytics of the source become the target's: events and active
 * days are re-keyed (the runtime role may insert and delete, not update),
 * the source's sign-up is dropped, and an objection on either side wins.
 */
async function moveAnalytics(c: Queryable, from: string, into: string) {
  const source = actorKey(from),
    target = actorKey(into);
  const {
    rows: [optouts],
  } = await c.query(
    `SELECT EXISTS(SELECT 1 FROM analytics_optouts WHERE actor=$1) AS source,
            EXISTS(SELECT 1 FROM analytics_optouts WHERE actor=$2) AS target`,
    [source, target],
  );
  if (optouts.source) await c.query("INSERT INTO analytics_optouts(actor) VALUES($1) ON CONFLICT DO NOTHING", [target]);
  if (optouts.source || optouts.target) {
    await c.query("DELETE FROM analytics_events WHERE actor=$1", [source]);
    await c.query("DELETE FROM analytics_active_days WHERE actor=$1", [source]);
    return;
  }
  await c.query("DELETE FROM analytics_events WHERE actor=$1 AND name='signup_completed'", [source]);
  await c.query(
    `WITH moved AS (
       DELETE FROM analytics_events WHERE actor=$1 RETURNING *
     )
     INSERT INTO analytics_events(id,occurred_at,day,name,actor,subject,props)
     SELECT gen_random_uuid(),occurred_at,day,name,$2,subject,props FROM moved
     ON CONFLICT DO NOTHING`,
    [source, target],
  );
  await c.query(
    `WITH moved AS (
       DELETE FROM analytics_active_days WHERE actor=$1 RETURNING day
     )
     INSERT INTO analytics_active_days(actor,day)
     SELECT $2,day FROM moved ON CONFLICT DO NOTHING`,
    [source, target],
  );
}

/**
 * The most objects the web path (/claim) copies. It runs under the app
 * role's idle-in-transaction limit (db.ts, 60 s), and the copies run between
 * statements, one after another: past this the merge would be killed halfway
 * (and undone), so it is refused up front. The operator's command has no such
 * limit and takes any number.
 */
export const WEB_MERGE_MAX_OBJECTS = 100;

const newKey = (key: string, from: string, into: string) => {
  if (!key.startsWith(`${from}/`))
    throw new MergeRefusal("Объект хранилища лежит вне пространства источника. Объединение остановлено.");
  return `${into}/${key.slice(from.length + 1)}`;
};

/**
 * Merges `fromRef` into `intoRef` (ids, addresses or logins). With `dryRun`
 * nothing changes; the counts say what would move.
 */
export async function mergeAccounts(input: {
  from: string;
  into: string;
  dryRun?: boolean;
  actor: "operator-script" | "signup";
  mover?: ObjectMover;
  reason?: string;
  /**
   * The operator's evidence that one person controls both shelves (a
   * support ticket); required for the operator, recorded in the journal.
   */
  proof?: string;
  /**
   * Agent connections of the source that move ("all" for the operator). The
   * person picks them one by one on /claim; the rest are revoked.
   */
  keepConnections?: string[] | "all";
  /** Refuse, before any copy, a source with more stored objects than this. */
  maxObjects?: number;
}): Promise<MergeReport> {
  if (input.actor === "operator-script" && !input.dryRun && !input.proof?.trim())
    throw new MergeRefusal(
      "Укажите --proof <номер обращения>: чем подтверждено, что обе полки принадлежат одному человеку.",
    );
  const mover = input.mover ?? s3Mover;
  const [fromFound, intoFound] = await Promise.all([findMergeAccount(input.from), findMergeAccount(input.into)]);
  if (!fromFound) throw new MergeRefusal(`Источник не найден: ${input.from}`);
  if (!intoFound) throw new MergeRefusal(`Получатель не найден: ${input.into}`);
  if (fromFound.id === intoFound.id) throw new MergeRefusal("Источник и получатель — один и тот же аккаунт.");

  const copies: Array<{ key: string; version: string }> = [];
  const originals: Array<{ key: string; version: string }> = [];
  /** Transcripts of sessions kept once (dropTwiceSentSessions): deleted after the commit. */
  const dropped: Array<{ key: string; version: string }> = [];
  let report: MergeReport;
  try {
    report = await transaction(async (c) => {
      const { from, into } = await lockPair(c, fromFound, intoFound);
      // «Объединить» on /claim moves a provisional shelf only: one claimed
      // in another tab meanwhile is a real shelf and is left alone.
      if (input.actor === "signup" && !from.provisional)
        throw new MergeRefusal("Временная полка уже закреплена. Обновите страницу.");
      await refuseUnsafeSource(c, from);
      const merge = {
        from: { accountId: from.id, tenantId: from.tenant },
        into: { accountId: into.id, tenantId: into.tenant },
        actor: input.actor,
        dryRun: !!input.dryRun,
      };
      const refused = await checkAccountMerge(merge, c);
      if (refused) throw new MergeRefusal(refused.message);
      const counts = await count(c, from, into);
      const notes: string[] = [];
      if (from.email && into.email)
        notes.push(
          `Адрес ${from.email} будет стёрт вместе с источником: у получателя уже есть ${into.email}. Код на ${from.email} потом откроет новую полку.`,
        );
      if (counts.identitiesKept.length)
        notes.push(
          `У получателя уже есть ${counts.identitiesKept.join(", ")}: эти привязки источника будут стёрты вместе с ним.`,
        );
      const summary = {
        dryRun: !!input.dryRun,
        from: { id: from.id, name: from.name, tenant: from.tenant },
        into: { id: into.id, name: into.name, tenant: into.tenant },
        counts,
        notes,
        leftovers: [],
      };
      if (input.dryRun) return summary;

      // The same rows a deletion request locks, in the same order.
      for (const table of ["agent_connections", "uploads", "artifacts", "shares", "revision_derivatives"])
        await c.query(`SELECT id FROM ${table} WHERE tenant_id=$1 ORDER BY id FOR UPDATE`, [from.tenant]);

      // Connections the person did not pick are closed before they move.
      if (input.keepConnections && input.keepConnections !== "all") {
        const closed = await c.query(
          `UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,clock_timestamp())
            WHERE tenant_id=$1 AND NOT (id = ANY($2::uuid[])) RETURNING id`,
          [from.tenant, input.keepConnections],
        );
        await c.query(
          `UPDATE oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp())
            WHERE tenant_id=$1 AND NOT (connection_id = ANY($2::uuid[]))`,
          [from.tenant, input.keepConnections],
        );
        counts.activeAgentConnections = Math.max(0, counts.activeAgentConnections - (closed.rowCount ?? 0));
      }

      // An agent session sent to both shelves (same agent, same id) is kept
      // once, as after any second upload: the later one. The other row goes
      // now, its transcript after the commit.
      dropped.push(...(await dropTwiceSentSessions(c, from.tenant, into.tenant)));

      // 1. Copies under the target's prefix (the originals stay until commit).
      const objects = await sourceObjects(c, from.tenant);
      if (input.maxObjects !== undefined && objects.length > input.maxObjects)
        throw new MergeRefusal(
          `На полке слишком много файлов (${objects.length}) для автоматического объединения. Напишите в поддержку: оператор объединит полки командой, ничего не потеряется.`,
        );
      const mapping: Array<{
        oldKey: string;
        oldVersion: string;
        newKey: string;
        newVersion: string;
      }> = [];
      for (const object of objects) {
        const key = newKey(object.key, from.tenant, into.tenant);
        let version = object.version;
        if (!object.gone) {
          version = await mover.copy(object.key, object.version, key);
          copies.push({ key, version });
          originals.push({ key: object.key, version: object.version });
        }
        mapping.push({
          oldKey: object.key,
          oldVersion: object.version,
          newKey: key,
          newVersion: version,
        });
      }
      // The key mapping travels as one JSON parameter: the application role
      // has no TEMPORARY privilege on hosted installations.
      const objectMap = JSON.stringify(
        mapping.map((item) => ({
          old_key: item.oldKey,
          old_version: item.oldVersion,
          new_key: item.newKey,
          new_version: item.newVersion,
        })),
      );
      const mergeObjects = (param: string) =>
        `(SELECT * FROM jsonb_to_recordset(${param}::jsonb)
            AS o(old_key text,old_version text,new_key text,new_version text))`;

      // 2. The works and everything that points at them, in ONE statement:
      // foreign keys include the tenant, so they are checked once all rows
      // have moved. Prepared versions are immutable once ready, so they are
      // re-inserted under the same id rather than updated.
      await c.query(
        `WITH
         folder_map AS (
           SELECT s.id AS old_id,t.id AS new_id FROM folders s
             JOIN folders t ON t.tenant_id=$2 AND t.name=s.name
            WHERE s.tenant_id=$1
         ),
         moved_folders AS (
           UPDATE folders SET tenant_id=$2
            WHERE tenant_id=$1 AND id NOT IN (SELECT old_id FROM folder_map)
           RETURNING id
         ),
         dropped_folders AS (
           DELETE FROM folders WHERE id IN (SELECT old_id FROM folder_map)
           RETURNING id
         ),
         moved_artifacts AS (
           UPDATE artifacts a SET tenant_id=$2,
                  created_by=CASE WHEN a.created_by=$3 THEN $4 ELSE a.created_by END,
                  folder_id=COALESCE(
                    (SELECT new_id FROM folder_map WHERE old_id=a.folder_id),
                    a.folder_id)
            WHERE a.tenant_id=$1
           RETURNING id
         ),
         moved_revisions AS (
           UPDATE revisions r SET tenant_id=$2,
                  created_by=CASE WHEN r.created_by=$3 THEN $4 ELSE r.created_by END,
                  object_key=m.new_key,object_version=m.new_version
             FROM ${mergeObjects("$5")} m
            WHERE r.tenant_id=$1 AND m.old_key=r.object_key
              AND m.old_version=r.object_version
           RETURNING r.id
         ),
         moved_files AS (
           UPDATE revision_files f
              SET object_key=m.new_key,object_version=m.new_version
             FROM ${mergeObjects("$5")} m, revisions r
            WHERE r.id=f.revision_id AND r.tenant_id=$1
              AND m.old_key=f.object_key AND m.old_version=f.object_version
           RETURNING f.revision_id
         ),
         old_derivatives AS (
           DELETE FROM revision_derivatives WHERE tenant_id=$1 RETURNING *
         ),
         new_derivatives AS (
           INSERT INTO revision_derivatives(
             id,tenant_id,revision_id,source_manifest_sha256,builder_version,
             state,attempt_id,attempt_expires_at,runtime_profile,size,sha256,
             object_key,object_version,reason,error_path,created_at,updated_at,
             artifact_lifecycle_version)
           SELECT d.id,$2,d.revision_id,d.source_manifest_sha256,d.builder_version,
                  d.state,d.attempt_id,d.attempt_expires_at,d.runtime_profile,
                  d.size,d.sha256,
                  COALESCE(m.new_key,d.object_key),
                  COALESCE(m.new_version,d.object_version),
                  d.reason,d.error_path,d.created_at,d.updated_at,
                  d.artifact_lifecycle_version
             FROM old_derivatives d
             LEFT JOIN ${mergeObjects("$5")} m
               ON m.old_key=d.object_key AND m.old_version=d.object_version
           RETURNING id
         ),
         moved_shares AS (
           UPDATE shares SET tenant_id=$2 WHERE tenant_id=$1 RETURNING id
         ),
         moved_comments AS (
           UPDATE comments SET tenant_id=$2 WHERE tenant_id=$1 RETURNING id
         ),
         -- Reactions are never updated by the runtime (it holds no UPDATE on
         -- them): they move as a delete and an insert of the same row.
         old_reactions AS (
           DELETE FROM comment_reactions WHERE tenant_id=$1 RETURNING *
         ),
         moved_reactions AS (
           INSERT INTO comment_reactions
             (id,tenant_id,artifact_id,share_id,revision_id,author_account_id,anchor_sig,anchor,emoji,created_at)
           SELECT id,$2,artifact_id,share_id,revision_id,author_account_id,anchor_sig,anchor,emoji,created_at
             FROM old_reactions
           RETURNING id
         ),
         moved_reports AS (
           UPDATE share_reports SET tenant_id=$2 WHERE tenant_id=$1 RETURNING id
         ),
         moved_blocks AS (
           UPDATE moderation_blocks SET tenant_id=$2 WHERE tenant_id=$1 RETURNING id
         )
         SELECT (SELECT count(*) FROM moved_revisions) AS revisions,
                (SELECT count(*) FROM moved_files) AS files,
                (SELECT count(*) FROM new_derivatives) AS derivatives,
                (SELECT count(*) FROM moved_artifacts) AS artifacts,
                (SELECT count(*) FROM moved_folders) AS folders,
                (SELECT count(*) FROM dropped_folders) AS joined,
                (SELECT count(*) FROM moved_shares) AS shares,
                (SELECT count(*) FROM moved_comments) AS comments,
                (SELECT count(*) FROM moved_reactions) AS reactions,
                (SELECT count(*) FROM moved_reports) AS reports,
                (SELECT count(*) FROM moved_blocks) AS blocks`,
        [from.tenant, into.tenant, from.id, into.id, objectMap],
      );
      const stillThere = await c.query("SELECT 1 FROM revisions WHERE tenant_id=$1 LIMIT 1", [from.tenant]);
      if (stillThere.rowCount)
        throw new MergeRefusal("Не все версии нашли свои объекты хранилища. Объединение отменено.");

      // 3. Agents and receipts: connection, then everything that names it
      // with (connection, tenant, account), again in one statement.
      await c.query(
        `WITH
         connections AS (
           UPDATE agent_connections SET tenant_id=$2,account_id=$4
            WHERE tenant_id=$1 RETURNING id
         ),
         uploads_moved AS (
           UPDATE uploads SET tenant_id=$2,account_id=$4
            WHERE tenant_id=$1 RETURNING id
         ),
         audit_moved AS (
           UPDATE audit_outbox SET tenant_id=$2,
                  actor_id=CASE WHEN actor_id=$3 THEN $4 ELSE actor_id END
            WHERE tenant_id=$1 RETURNING id
         ),
         operations AS (
           UPDATE agent_operations SET tenant_id=$2,account_id=$4
            WHERE tenant_id=$1 RETURNING id
         ),
         imports AS (
           UPDATE url_import_jobs SET tenant_id=$2,account_id=$4
            WHERE tenant_id=$1 RETURNING id
         ),
         authorizations AS (
           UPDATE oauth_authorizations SET tenant_id=$2,account_id=$4
            WHERE tenant_id=$1 RETURNING id
         ),
         refresh AS (
           UPDATE oauth_refresh_tokens SET tenant_id=$2,account_id=$4
            WHERE tenant_id=$1 RETURNING id
         )
         SELECT (SELECT count(*) FROM connections) AS connections,
                (SELECT count(*) FROM uploads_moved) AS uploads,
                (SELECT count(*) FROM audit_moved) AS audit,
                (SELECT count(*) FROM operations) AS operations,
                (SELECT count(*) FROM imports) AS imports,
                (SELECT count(*) FROM authorizations) AS authorizations,
                (SELECT count(*) FROM refresh) AS refresh`,
        [from.tenant, into.tenant, from.id, into.id],
      );
      // Upload receipts name the same objects as the versions they made.
      await c.query(
        `UPDATE upload_files f SET object_key=m.new_key,object_version=m.new_version
           FROM ${mergeObjects("$2")} m, uploads u
          WHERE u.id=f.upload_id AND u.tenant_id=$1
            AND m.old_key=f.object_key AND m.old_version=f.object_version`,
        [into.tenant, objectMap],
      );
      await c.query(
        `UPDATE uploads u SET object_version=m.new_version
           FROM ${mergeObjects("$3")} m
          WHERE u.tenant_id=$1 AND u.object_version IS NOT NULL
            AND m.old_key=$2||'/'||u.id::text AND m.old_version=u.object_version`,
        [into.tenant, from.tenant, objectMap],
      );
      await moveAgentSessions(c, from, into, objectMap);

      // 4. What the source wrote elsewhere, and who it is.
      // The person responsible for works (on department shelves too), the
      // author of the moved links and of proposals to «Лента» stay the person.
      await c.query("UPDATE artifacts SET owner_account_id=$2 WHERE owner_account_id=$1", [from.id, into.id]);
      await c.query("UPDATE shares SET created_by=$3 WHERE tenant_id=$1 AND created_by=$2", [
        into.tenant,
        from.id,
        into.id,
      ]);
      await c.query("UPDATE feed_proposals SET proposed_by=$2 WHERE proposed_by=$1", [from.id, into.id]);
      await c.query(
        `DELETE FROM comment_reactions s USING comment_reactions t
          WHERE s.author_account_id=$1 AND t.author_account_id=$2
            AND t.share_id=s.share_id AND t.anchor_sig=s.anchor_sig
            AND t.emoji=s.emoji`,
        [from.id, into.id],
      );
      await c.query(
        `WITH old AS (
           DELETE FROM comment_reactions WHERE author_account_id=$1 RETURNING *
         )
         INSERT INTO comment_reactions
           (id,tenant_id,artifact_id,share_id,revision_id,author_account_id,anchor_sig,anchor,emoji,created_at)
         SELECT id,tenant_id,artifact_id,share_id,revision_id,$2,anchor_sig,anchor,emoji,created_at FROM old`,
        [from.id, into.id],
      );
      await c.query("UPDATE comments SET author_account_id=$2 WHERE author_account_id=$1", [from.id, into.id]);
      await c.query("UPDATE comments SET resolved_by=$2 WHERE resolved_by=$1", [from.id, into.id]);
      // Webhooks (docs/specs/WEBHOOKS.md): the source shelf's addresses do not
      // move (they would start receiving the target's events); those the
      // person registered on department shelves stay, now under the target.
      await c.query("DELETE FROM webhook_endpoints WHERE tenant_id=$1", [from.tenant]);
      await c.query("UPDATE webhook_endpoints SET created_by=$2 WHERE created_by=$1", [from.id, into.id]);
      await moveMemberships(c, from, into);
      await moveShelfMemberships(c, from, into);
      await c.query(
        `UPDATE account_identities SET account_id=$2
          WHERE account_id=$1
            AND provider NOT IN (SELECT provider FROM account_identities
                                  WHERE account_id=$2)`,
        [from.id, into.id],
      );
      // An address the target lacks moves with the person, so a code to it
      // still opens the (merged) shelf.
      if (from.email && !into.email) {
        const {
          rows: [moved],
        } = await c.query("SELECT email,email_verified_at FROM accounts WHERE id=$1", [from.id]);
        await c.query("UPDATE accounts SET email=NULL WHERE id=$1", [from.id]);
        await c.query("UPDATE accounts SET email=$2,email_verified_at=$3 WHERE id=$1", [
          into.id,
          moved.email,
          moved.email_verified_at,
        ]);
      }
      await moveAnalytics(c, from.id, into.id);
      // Extensions move their own records of the person in this transaction.
      await runAccountMerged(merge, c);

      // 5. Storage accounting, then the source is closed.
      await c.query(
        `UPDATE tenants t SET used_bytes=t.used_bytes+s.used_bytes,
                derivative_used_bytes=t.derivative_used_bytes+s.derivative_used_bytes
           FROM tenants s WHERE t.id=$2 AND s.id=$1`,
        [from.tenant, into.tenant],
      );
      await c.query("UPDATE tenants SET used_bytes=0,derivative_used_bytes=0 WHERE id=$1", [from.tenant]);
      const {
        rows: [quota],
      } = await c.query("SELECT used_bytes>quota_bytes AS over FROM tenants WHERE id=$1", [into.tenant]);
      if (quota?.over)
        notes.push(
          "Получатель теперь занимает больше своей квоты хранения: новые сохранения будут отклоняться, пока место не освободится или квоту не увеличат.",
        );
      await recordEvent(c, {
        actor: input.actor,
        action: "account.merged",
        accountId: from.id,
        tenantId: from.tenant,
        reason: input.reason ?? null,
        authority: input.proof?.trim() || null,
        details: {
          intoAccountId: into.id,
          intoTenantId: into.tenant,
          counts: { ...counts, identitiesKept: counts.identitiesKept.length },
        },
      });
      // The emptied source is deleted, not merely disabled: through the
      // deletion pipeline where it runs, otherwise its personal fields go now.
      await c.query("DELETE FROM sessions WHERE account_id=$1", [from.id]);
      if (
        config.ACCOUNT_DELETION_ENABLED &&
        (await requestDeletionRows(
          c,
          { id: from.id, tenant: from.tenant },
          {
            policyVersion: config.ACCOUNT_DELETION_POLICY_VERSION!,
            purgeMaxHours: config.ACCOUNT_PURGE_MAX_HOURS!,
            backupRetentionMaxDays: config.BACKUP_RETENTION_MAX_DAYS!,
          },
          "account.merged_source_deleted",
        ))
      )
        notes.push("Источник передан на удаление (конвейер удаления аккаунтов).");
      else {
        await c.query(
          `UPDATE accounts SET disabled=true,
                  deletion_requested_at=COALESCE(deletion_requested_at,clock_timestamp()),
                  email=NULL,display_name=NULL,email_verified_at=NULL
            WHERE id=$1`,
          [from.id],
        );
        notes.push("Источник закрыт как удалённый: почта, имя и оставшиеся привязки стёрты.");
      }
      await audit(c, { id: into.id, tenant: into.tenant }, "account.merged", from.id);
      return summary;
    });
  } catch (error) {
    // Nothing points at the copies: remove them.
    await Promise.allSettled(copies.map((copy) => mover.remove(copy.key, copy.version)));
    throw error;
  }
  if (!report.dryRun) {
    for (const original of [...originals, ...dropped]) {
      try {
        await mover.remove(original.key, original.version);
      } catch {
        report.leftovers.push(original);
      }
    }
  }
  return report;
}

/** A plain-text report for the operator's terminal. */
export function formatMergeReport(report: MergeReport) {
  const c = report.counts;
  const lines = [
    report.dryRun ? "Пробный прогон: ничего не изменено." : "Объединение выполнено.",
    `Из: ${report.from.name} (${report.from.id})`,
    `В:  ${report.into.name} (${report.into.id})`,
    `Папки: ${c.folders} (из них слиты по имени: ${c.foldersJoined})`,
    `Работы: ${c.artifacts}, версии: ${c.revisions}, объекты хранилища: ${c.objects}`,
    `Ссылки: ${c.shares} (действующих: ${c.activeShares}), комментарии на них: ${c.discussions}`,
    `Заметки и комментарии источника на чужих полках: ${c.commentsAuthored}`,
    `Подключения агентов: ${c.agentConnections} (действующих: ${c.activeAgentConnections}), ключи продления: ${c.refreshTokens}`,
    `Способы входа к переносу: ${c.identities}`,
    `Участие в библиотеках: ${c.libraryMemberships}`,
    `События статистики: ${c.analyticsEvents}`,
    `Сеансы источника будут закрыты: ${c.sessionsEnded}`,
    `Сессии агентов: ${c.agentSessions} (есть и у получателя: ${c.agentSessionsTwice}, из двух остаётся отправленная позже)`,
    `Объём: ${c.sourceBytes} Б исходников, ${c.derivativeBytes} Б подготовленных версий`,
    ...report.notes.map((note) => `Внимание: ${note}`),
    ...report.leftovers.map((item) => `Не удалось удалить старый объект: ${item.key} (версия ${item.version})`),
  ];
  return lines.join("\n");
}
