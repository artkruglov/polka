// Operator report for docs/specs/AGENT_ACCESS_AND_MEMORY.md, «Метрики»: counts
// only, read-only, no names, no content. Run on the installation's database.
//
//   npm run metrics:agent-access
//
// Main metric: accepted versions that someone other than the author opened in
// the last 7 days through a link on that very version (share_open_days counts
// recipients' openings, not the owner's). The machine share of reads has no
// counter yet: the API does not log reads. This report shows what the database
// can answer today, so the 30-day baseline of agent tokens can start.
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
  const owners = await one(
    `SELECT count(*) FILTER (WHERE owner_account_id IS NOT NULL)::int AS works_with_owner,
            count(*)::int AS works
     FROM artifacts WHERE trashed_at IS NULL AND purged_at IS NULL`,
  );
  console.log(
    JSON.stringify({ event: "agent_access_metrics", at: new Date().toISOString(), ...accepted, ...tokens, ...principals, ...owners }, null, 2),
  );
} finally {
  await db.end();
}
