import { z } from "zod";
import { uuid } from "../../packages/contracts/index.ts";
import { transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { audit } from "./artifacts.ts";
import { lockShelf } from "./shelves.ts";

type Actor = { id: string; tenant: string };

const acceptInput = z.object({ revisionId: uuid.nullable() }).strict();
const ownerInput = z.object({ ownerAccountId: uuid.nullable() }).strict();

async function lockWork(c: Parameters<Parameters<typeof transaction>[0]>[0], actor: Actor, artifactId: string) {
  // Marking a version accepted and naming the owner are a curator's.
  await lockShelf(c, actor, "curator");
  const {
    rows: [artifact],
  } = await c.query(
    `SELECT id,accepted_revision_id,owner_account_id FROM artifacts WHERE id=$1 AND tenant_id=$2
       AND trashed_at IS NULL AND purged_at IS NULL FOR UPDATE`,
    [artifactId, actor.tenant],
  );
  if (!artifact) throw missing();
  return artifact as { id: string; accepted_revision_id: string | null; owner_account_id: string | null };
}

/** A curator marks a version of the work accepted, or clears the mark (null). */
export async function acceptRevision(actor: Actor, artifactId: string, body: unknown) {
  const { revisionId } = acceptInput.parse(body);
  return transaction(async (c) => {
    const work = await lockWork(c, actor, artifactId);
    if ((work.accepted_revision_id ?? null) === revisionId) return { artifactId, acceptedRevisionId: revisionId };
    if (revisionId) {
      const found = await c.query("SELECT 1 FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3", [
        revisionId,
        artifactId,
        actor.tenant,
      ]);
      if (!found.rowCount) throw missing();
    }
    await c.query("UPDATE artifacts SET accepted_revision_id=$2,updated_at=clock_timestamp() WHERE id=$1", [
      artifactId,
      revisionId,
    ]);
    await audit(c, actor, "revision.accepted", artifactId, { artifactId, revisionId });
    return { artifactId, acceptedRevisionId: revisionId };
  });
}

/** A curator names the person responsible for the work, or clears it (null). */
export async function setWorkOwner(actor: Actor, artifactId: string, body: unknown) {
  const { ownerAccountId } = ownerInput.parse(body);
  return transaction(async (c) => {
    const work = await lockWork(c, actor, artifactId);
    if ((work.owner_account_id ?? null) === ownerAccountId) return { artifactId, ownerAccountId };
    if (ownerAccountId) {
      const member = await c.query(
        `SELECT 1 FROM tenant_members m JOIN accounts a ON a.id=m.account_id
         WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.state='active'
           AND NOT a.disabled AND a.deletion_requested_at IS NULL`,
        [actor.tenant, ownerAccountId],
      );
      if (!member.rowCount) throw new Problem(422, "invalid", "Ответственным может быть только участник этой полки.");
    }
    await c.query("UPDATE artifacts SET owner_account_id=$2,updated_at=clock_timestamp() WHERE id=$1", [
      artifactId,
      ownerAccountId,
    ]);
    await audit(c, actor, "owner.changed", artifactId, { artifactId, ownerAccountId });
    return { artifactId, ownerAccountId };
  });
}
