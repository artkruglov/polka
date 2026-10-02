// The operator erases an account on request (docs/legal/privacy.md § 7,
// scripts/account-erase.ts): the same deletion request a confirmed deletion
// writes (requestDeletionRows closes the account, revokes its agents, links
// and grants), then the purge worker (scripts/account-purge.ts) deletes every
// object version of the shelf, records the erasure in the external ledger and
// erases the metadata through terminal_erase_account_metadata. Nothing here
// deletes by itself: the request is what the worker acts on.
//
// Refused while the shelf holds blocked content (moderation keeps it as
// evidence) or is the only administrator of a department shelf with other
// members. A dry run changes nothing and says what would go.
import { forgetAccountLater } from "./analytics.ts";
import { findMergeAccount } from "./account-merge.ts";
import { recordEvent } from "./content-moderation.ts";
import { transaction } from "./db.ts";
import { requestDeletionRows } from "./provisional-maintenance.ts";

export class ErasureRefusal extends Error {}

export type ErasurePolicy = {
  policyVersion: string;
  purgeMaxHours: number;
  backupRetentionMaxDays: number;
};

export type ErasureReport = {
  dryRun: boolean;
  account: { id: string; name: string; tenant: string };
  /** The deletion request: new, or one already under way (a rerun). */
  state: "would_request" | "requested" | "access_revoked_pending_purge" | "failed" | "purged";
  counts: {
    works: number;
    versions: number;
    bytes: number;
    activeLinks: number;
    agents: number;
    signInMethods: number;
    libraryMemberships: number;
    departmentShelves: number;
    editorialPublications: number;
  };
};

export async function requestAccountErasure(input: {
  account: string;
  dryRun: boolean;
  proof?: string;
  reason?: string;
  policy: ErasurePolicy;
}): Promise<ErasureReport> {
  if (!input.dryRun && !input.proof?.trim())
    throw new ErasureRefusal(
      "Укажите --proof <номер обращения>: на основании чего удаляется аккаунт.",
    );
  const found = await findMergeAccount(input.account);
  if (!found) throw new ErasureRefusal(`Аккаунт не найден: ${input.account}`);
  return transaction(async (c) => {
    // Tenant, then account, as everywhere else.
    await c.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [found.tenant]);
    const {
      rows: [account],
    } = await c.query(
      "SELECT id,name,disabled,deletion_requested_at FROM accounts WHERE id=$1 FOR UPDATE",
      [found.id],
    );
    if (!account) throw new ErasureRefusal(`Аккаунт не найден: ${input.account}`);
    const {
      rows: [existing],
    } = await c.query("SELECT state FROM account_deletions WHERE account_id=$1", [found.id]);
    const {
      rows: [counts],
    } = await c.query(
      `SELECT
         (SELECT count(*) FROM artifacts WHERE tenant_id=$1)::int AS works,
         (SELECT count(*) FROM revisions WHERE tenant_id=$1)::int AS versions,
         (SELECT used_bytes FROM tenants WHERE id=$1)::bigint AS bytes,
         (SELECT count(*) FROM shares WHERE tenant_id=$1 AND NOT revoked AND expires_at>now())::int AS active_links,
         (SELECT count(*) FROM agent_connections WHERE tenant_id=$1 AND revoked_at IS NULL)::int AS agents,
         (SELECT count(*) FROM account_identities WHERE account_id=$2)::int AS identities,
         (SELECT count(*) FROM template_library_members WHERE account_id=$2 AND revoked_at IS NULL)::int AS libraries,
         (SELECT count(*) FROM tenant_members WHERE account_id=$2 AND tenant_id<>$1 AND state='active')::int AS department,
         (SELECT count(*) FROM editorial_publications WHERE tenant_id=$1 AND withdrawn_at IS NULL)::int AS editorial,
         EXISTS(SELECT 1 FROM moderation_blocks WHERE tenant_id=$1 AND released_at IS NULL) AS blocked,
         EXISTS(SELECT 1 FROM tenant_members member
                 WHERE member.account_id=$2 AND member.tenant_id<>$1 AND member.state='active'
                   AND member.role='admin'
                   AND NOT EXISTS(SELECT 1 FROM tenant_members other
                                   JOIN accounts oa ON oa.id=other.account_id
                                   WHERE other.tenant_id=member.tenant_id AND other.account_id<>$2
                                     AND other.state='active' AND other.role='admin'
                                     AND NOT oa.disabled AND oa.deletion_requested_at IS NULL)
                   AND EXISTS(SELECT 1 FROM tenant_members other
                               WHERE other.tenant_id=member.tenant_id AND other.account_id<>$2
                                 AND other.state='active')) AS last_admin`,
      [found.tenant, found.id],
    );
    const report: ErasureReport = {
      dryRun: input.dryRun,
      account: { id: found.id, name: account.name, tenant: found.tenant },
      state: existing && existing.state !== "planned" ? existing.state : "would_request",
      counts: {
        works: counts.works,
        versions: counts.versions,
        bytes: Number(counts.bytes),
        activeLinks: counts.active_links,
        agents: counts.agents,
        signInMethods: counts.identities,
        libraryMemberships: counts.libraries,
        departmentShelves: counts.department,
        editorialPublications: counts.editorial,
      },
    };
    // A rerun of a request under way: the worker finishes it.
    if (report.state !== "would_request") return report;
    if (counts.blocked)
      throw new ErasureRefusal(
        "На полке есть заблокированное содержимое: модерация хранит его как доказательство. Сначала разберите блокировку (moderation:events), затем удаляйте.",
      );
    if (counts.last_admin)
      throw new ErasureRefusal(
        "Аккаунт — единственный администратор полки отдела, где есть другие участники. Сначала назначьте другого администратора (страница администратора компании).",
      );
    if (account.disabled)
      throw new ErasureRefusal(
        "Аккаунт отключён модератором. Удаление по обращению — после снятия отключения или решения оператора.",
      );
    if (input.dryRun) return report;

    // The rows a confirmed deletion locks, in the same order (account-deletion.ts).
    for (const table of ["agent_connections", "uploads", "artifacts", "shares", "revision_derivatives", "editorial_publications"])
      await c.query(`SELECT id FROM ${table} WHERE tenant_id=$1 ORDER BY id FOR UPDATE`, [found.tenant]);
    await c.query(
      "UPDATE editorial_publications SET withdrawn_at=clock_timestamp() WHERE tenant_id=$1 AND withdrawn_at IS NULL",
      [found.tenant],
    );
    const requested = await requestDeletionRows(
      c,
      { id: found.id, tenant: found.tenant },
      input.policy,
      "account.erased_by_operator",
    );
    if (!requested) throw new ErasureRefusal("Заявка на удаление уже есть; запустите команду ещё раз.");
    await c.query("DELETE FROM sessions WHERE account_id=$1", [found.id]);
    await recordEvent(c, {
      actor: "operator-script",
      action: "account.erasure_requested",
      accountId: found.id,
      tenantId: found.tenant,
      reason: input.reason ?? null,
      authority: input.proof!.trim(),
      details: { counts: report.counts },
    });
    forgetAccountLater(c, found.id);
    return { ...report, state: "requested" };
  });
}

/** The state of an account's deletion request, for the worker loop. */
export async function erasureState(accountId: string) {
  const { db } = await import("./db.ts");
  const {
    rows: [row],
  } = await db.query(
    "SELECT state,error_code,purged_at FROM account_deletions WHERE account_id=$1",
    [accountId],
  );
  return row as { state: string; error_code: string | null; purged_at: Date | null } | undefined;
}
