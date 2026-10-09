// Operator report for docs/specs/AGENT_ACCESS_AND_MEMORY.md, «Метрики»: counts
// only, read-only, no names, no content. Run on the installation's database.
//
//   npm run metrics:agent-access
//
// Main metric: accepted versions that someone other than the author opened in
// the last 7 days through a link on that very version (share_open_days counts
// recipients' openings, not the owner's). The machine share of reads has no
// counter before 0.5.1 (agent_read_days, 061); counting_since says from when.
// The share is agent reads / (agent reads + recipients' link opens), a baseline
// to watch for 30 days, not a target.
import { db } from "../apps/server/db.ts";

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] ?? {};
try {
  const accepted = await one(
    `SELECT count(*)::int AS accepted_versions,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM shares s JOIN share_open_days d ON d.share_id=s.id
              WHERE s.artifact_id=a.id AND s.revision_id=a.accepted_revision_id
                AND d.day >= (now() AT TIME ZONE 'UTC')::date - 6))::int AS opened_by_others_7d
     FROM artifacts a
     WHERE a.accepted_revision_id IS NOT NULL AND a.trashed_at IS NULL AND a.purged_at IS NULL`,
  );
  const tokens = await one(
    `SELECT count(*) FILTER (WHERE principal_type='human' AND parent_id IS NULL
                             AND last_seen_at > now() - interval '30 days')::int AS people_agent_tokens_seen_30d,
            count(*) FILTER (WHERE principal_type='service' AND parent_id IS NULL
                             AND last_seen_at > now() - interval '30 days')::int AS service_tokens_seen_30d,
            count(*) FILTER (WHERE parent_id IS NOT NULL AND principal_type='service'
                             AND created_at > now() - interval '30 days')::int AS task_tokens_issued_30d
     FROM agent_connections`,
  );
  const principals = await one(
    `SELECT count(*) FILTER (WHERE status='active')::int AS service_accounts_active,
            count(*) FILTER (WHERE status='frozen')::int AS service_accounts_frozen
     FROM service_principals`,
  );
  // Machine reads (agent_read_days, from 0.5.1) against recipients' link opens.
  const reads = await one(
    `SELECT COALESCE(sum(reads) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29),0)::int AS agent_reads_30d,
            COALESCE(sum(reads) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29 AND principal_type='service'),0)::int AS service_reads_30d,
            min(day)::text AS counting_since
     FROM agent_read_days`,
  );
  const opens = await one(
    `SELECT COALESCE(sum(opens),0)::int AS recipient_opens_30d FROM share_open_days
     WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29`,
  );
  const readShare =
    reads.agent_reads_30d + opens.recipient_opens_30d > 0
      ? Math.round((100 * reads.agent_reads_30d) / (reads.agent_reads_30d + opens.recipient_opens_30d))
      : null;
  const owners = await one(
    `SELECT count(*) FILTER (WHERE owner_account_id IS NOT NULL)::int AS works_with_owner,
            count(*)::int AS works
     FROM artifacts WHERE trashed_at IS NULL AND purged_at IS NULL`,
  );
  console.log(
    JSON.stringify(
      {
        event: "agent_access_metrics",
        at: new Date().toISOString(),
        ...accepted,
        ...tokens,
        ...principals,
        ...owners,
        ...reads,
        ...opens,
        machine_read_share_percent: readShare,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
