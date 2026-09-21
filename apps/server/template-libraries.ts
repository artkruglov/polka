import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor } from "./artifacts.ts";
import { audit } from "./artifacts.ts";
import { transaction } from "./db.ts";
import { missing, Problem } from "./errors.ts";
import {
  changeTemplateLibraryRoleInput,
  acceptTemplateLibraryInvitationInput,
  createTemplateLibraryInvitationInput,
  createTemplateLibraryInput,
  listTemplateLibraryEventsInput,
  publishTemplateLibraryReleaseInput,
  withdrawTemplateLibraryPublicationInput,
  type TemplateLibraryRole,
} from "../../packages/contracts/template-library.ts";
import { config } from "./config.ts";
import { sha256 } from "./storage.ts";

async function lockActorAndAccounts(
  c: PoolClient,
  actor: Actor,
  accountIds: string[] = [],
) {
  // Discovering target tenants grants nothing. Both tenant ownership and every
  // account predicate are rechecked after the ordered locks are acquired.
  const discovered = await c.query(
    "SELECT id,owner_id FROM tenants WHERE owner_id=ANY($1::uuid[])",
    [[actor.id, ...accountIds]],
  );
  const tenantIds = [...new Set(discovered.rows.map((row) => row.id))];
  const tenants = await c.query(
    "SELECT id,owner_id FROM tenants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [tenantIds],
  );
  if (
    !tenants.rows.some(
      (row) => row.id === actor.tenant && row.owner_id === actor.id,
    )
  )
    throw missing();

  const ids = [...new Set([actor.id, ...accountIds])];
  const accounts = await c.query(
    `SELECT id,disabled,deletion_requested_at FROM accounts
      WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
  const activeActor = accounts.rows.find(
    (row) =>
      row.id === actor.id &&
      !row.disabled &&
      row.deletion_requested_at === null,
  );
  if (!activeActor) throw missing();
  return { tenants: tenants.rows, accounts: accounts.rows };
}

async function lockLibrary(c: PoolClient, libraryId: string) {
  const library = (
    await c.query(
      `SELECT id,name,created_at FROM template_libraries
        WHERE id=$1 AND state='active' AND archived_at IS NULL FOR UPDATE`,
      [libraryId],
    )
  ).rows[0];
  if (!library) throw missing();
  return library;
}

async function lockMembers(
  c: PoolClient,
  libraryId: string,
  accountIds: string[],
) {
  return (
    await c.query(
      `SELECT * FROM template_library_members
        WHERE library_id=$1 AND account_id=ANY($2::uuid[])
        ORDER BY account_id FOR UPDATE`,
      [libraryId, [...new Set(accountIds)]],
    )
  ).rows;
}

function requireAdmin(rows: any[], actorId: string) {
  const member = rows.find(
    (row) =>
      row.account_id === actorId &&
      row.state === "active" &&
      row.revoked_at === null,
  );
  if (
    !member ||
    member.state !== "active" ||
    member.revoked_at !== null ||
    member.role !== "admin"
  )
    throw missing();
}

async function libraryEvent(
  c: PoolClient,
  actor: Actor,
  libraryId: string,
  action: string,
  targetType: "library" | "invitation" | "account" | "publication",
  targetId: string,
  oldRole: TemplateLibraryRole | null = null,
  newRole: TemplateLibraryRole | null = null,
) {
  await c.query(
    `INSERT INTO template_library_events(
       library_id,actor_id,action,target_type,target_object_id,target_account_id,old_role,new_role
     ) VALUES($1,$2,$3,$4,
       CASE WHEN $4='account' THEN NULL ELSE $5::uuid END,
       CASE WHEN $4='account' THEN $5::uuid ELSE NULL END,$6,$7)`,
    [libraryId, actor.id, action, targetType, targetId, oldRole, newRole],
  );
}

async function ensureAnotherActiveAdmin(
  c: PoolClient,
  libraryId: string,
  targetId: string,
) {
  const another = await c.query(
    `SELECT 1 FROM template_library_members member
       JOIN accounts account ON account.id=member.account_id
      WHERE member.library_id=$1 AND member.account_id<>$2
        AND member.role='admin' AND member.state='active' AND member.revoked_at IS NULL
        AND NOT account.disabled AND account.deletion_requested_at IS NULL
      LIMIT 1`,
    [libraryId, targetId],
  );
  if (!another.rowCount)
    throw new Problem(
      409,
      "conflict",
      "Сначала назначьте другого активного администратора.",
    );
}

export async function createTemplateLibrary(actor: Actor, body: unknown) {
  const input = createTemplateLibraryInput.parse(body);
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    const id = randomUUID();
    await c.query(
      "INSERT INTO template_libraries(id,name,created_by) VALUES($1,$2,$3)",
      [id, input.name, actor.id],
    );
    await c.query(
      "INSERT INTO template_library_members(library_id,account_id,role) VALUES($1,$2,'admin')",
      [id, actor.id],
    );
    await audit(c, actor, "template_library.created", id);
    await libraryEvent(
      c,
      actor,
      id,
      "template_library.created",
      "library",
      id,
      null,
      "admin",
    );
    return { id, name: input.name, role: "admin" as const };
  });
}

export async function listTemplateLibrariesInTransaction(
  c: PoolClient,
  actor: Actor,
) {
  const rows = (
    await c.query(
      `SELECT library.id,library.name,member.role,library.created_at AS "createdAt"
         FROM template_library_members member
         JOIN template_libraries library ON library.id=member.library_id
         JOIN tenants actor_tenant ON actor_tenant.id=$2 AND actor_tenant.owner_id=$1
         JOIN accounts actor_account ON actor_account.id=$1
        WHERE member.account_id=$1 AND member.state='active' AND member.revoked_at IS NULL
          AND library.state='active' AND library.archived_at IS NULL
          AND NOT actor_account.disabled AND actor_account.deletion_requested_at IS NULL
        ORDER BY library.created_at DESC,library.id LIMIT 101`,
      [actor.id, actor.tenant],
    )
  ).rows;
  return { items: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function listTemplateLibraries(actor: Actor) {
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    return listTemplateLibrariesInTransaction(c, actor);
  });
}

export async function listTemplateLibraryMembers(
  actor: Actor,
  libraryId: string,
) {
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    const members = await lockMembers(c, libraryId, [actor.id]);
    if (
      !members.some(
        (member) => member.state === "active" && member.revoked_at === null,
      )
    )
      throw missing();
    const rows = (
      await c.query(
        `SELECT member.account_id AS "accountId",
                COALESCE(account.display_name,account.name) AS name,
                member.role,member.joined_at AS "joinedAt"
           FROM template_library_members member
           JOIN accounts account ON account.id=member.account_id
          WHERE member.library_id=$1 AND member.state='active' AND member.revoked_at IS NULL
            AND NOT account.disabled AND account.deletion_requested_at IS NULL
          ORDER BY name,member.account_id LIMIT 501`,
        [libraryId],
      )
    ).rows;
    return { items: rows.slice(0, 500), hasMore: rows.length > 500 };
  });
}

export async function listTemplateLibraryEvents(
  actor: Actor,
  libraryId: string,
  query: unknown,
) {
  const input = listTemplateLibraryEventsInput.parse(query);
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    requireAdmin(await lockMembers(c, libraryId, [actor.id]), actor.id);
    const rows = (
      await c.query(
        `SELECT id,actor_id,action,target_type,target_object_id,target_account_id,
                old_role,new_role,created_at
           FROM template_library_events
          WHERE library_id=$1 AND ($2::bigint IS NULL OR id<$2)
          ORDER BY id DESC LIMIT $3`,
        [libraryId, input.before ?? null, input.limit + 1],
      )
    ).rows;
    const items = rows.slice(0, input.limit).map((row) => ({
      id: String(row.id),
      libraryId,
      actor: { id: row.actor_id, deleted: row.actor_id === null },
      action: row.action,
      target: {
        type: row.target_type,
        id:
          row.target_type === "account"
            ? row.target_account_id
            : row.target_object_id,
        deleted:
          row.target_type === "account" && row.target_account_id === null,
      },
      oldRole: row.old_role,
      newRole: row.new_role,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    return {
      items,
      nextBefore: rows.length > input.limit ? items.at(-1)!.id : null,
    };
  });
}

export async function changeTemplateLibraryMemberRole(
  actor: Actor,
  libraryId: string,
  accountId: string,
  body: unknown,
) {
  const input = changeTemplateLibraryRoleInput.parse(body);
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor, [accountId]);
    await lockLibrary(c, libraryId); // serializes last-admin decisions
    const rows = await lockMembers(c, libraryId, [actor.id, accountId]);
    requireAdmin(rows, actor.id);
    const target = rows.find(
      (row) =>
        row.account_id === accountId &&
        row.state === "active" &&
        row.revoked_at === null,
    );
    if (!target || target.state !== "active" || target.revoked_at !== null)
      throw missing();
    if (target.role === input.role) return { accountId, role: input.role };
    if (target.role === "admin" && input.role !== "admin")
      await ensureAnotherActiveAdmin(c, libraryId, accountId);
    await c.query(
      `UPDATE template_library_members SET role=$3
        WHERE library_id=$1 AND account_id=$2 AND state='active' AND revoked_at IS NULL`,
      [libraryId, accountId, input.role],
    );
    await audit(c, actor, "template_library.member_role_changed", accountId);
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.member_role_changed",
      "account",
      accountId,
      target.role,
      input.role,
    );
    return { accountId, role: input.role };
  });
}

export async function revokeTemplateLibraryMember(
  actor: Actor,
  libraryId: string,
  accountId: string,
) {
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor, [accountId]);
    await lockLibrary(c, libraryId);
    const rows = await lockMembers(c, libraryId, [actor.id, accountId]);
    requireAdmin(rows, actor.id);
    const target = rows.find(
      (row) =>
        row.account_id === accountId &&
        row.state === "active" &&
        row.revoked_at === null,
    );
    if (!target) {
      if (
        rows.some(
          (row) => row.account_id === accountId && row.state === "revoked",
        )
      )
        return { ok: true };
      throw missing();
    }
    if (target.state !== "active" || target.revoked_at !== null)
      throw missing();
    if (target.role === "admin")
      await ensureAnotherActiveAdmin(c, libraryId, accountId);
    await c.query(
      `UPDATE template_library_members
          SET state='revoked',revoked_at=clock_timestamp()
        WHERE library_id=$1 AND account_id=$2
          AND state='active' AND revoked_at IS NULL`,
      [libraryId, accountId],
    );
    await audit(c, actor, "template_library.member_revoked", accountId);
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.member_revoked",
      "account",
      accountId,
      target.role,
      null,
    );
    return { ok: true };
  });
}

export async function createTemplateLibraryInvitation(
  actor: Actor,
  libraryId: string,
  body: unknown,
) {
  const input = createTemplateLibraryInvitationInput.parse(body);
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    requireAdmin(await lockMembers(c, libraryId, [actor.id]), actor.id);
    const existingMember = await c.query(
      `SELECT 1 FROM template_library_members
        WHERE library_id=$1 AND state='active' AND revoked_at IS NULL
          AND account_id IN (SELECT id FROM accounts WHERE email=$2)
        LIMIT 1`,
      [libraryId, input.email],
    );
    if (existingMember.rowCount)
      throw new Problem(
        409,
        "conflict",
        "Этот аккаунт уже состоит в библиотеке.",
      );

    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const row = (
      await c.query(
        `WITH timestamp AS (SELECT clock_timestamp() AS value)
         INSERT INTO template_library_invitations(
           id,library_id,email,role,token_hash,invited_by,created_at,expires_at
         )
         SELECT $1,$2,$3,$4,$5,$6,value,value+make_interval(hours=>$7)
           FROM timestamp
         RETURNING expires_at`,
        [
          id,
          libraryId,
          input.email,
          input.role,
          sha256(token),
          actor.id,
          input.expiresInHours,
        ],
      )
    ).rows[0];
    await audit(c, actor, "template_library.invitation_created", id);
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.invitation_created",
      "invitation",
      id,
      null,
      input.role,
    );
    const fragment = new URLSearchParams({ token, libraryId }).toString();
    return {
      id,
      email: input.email,
      role: input.role,
      expiresAt: new Date(row.expires_at).toISOString(),
      invitationUrl: `${config.APP_ORIGIN}/library-invite#${fragment}`,
    };
  });
}

export async function listTemplateLibraryInvitations(
  actor: Actor,
  libraryId: string,
) {
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    requireAdmin(await lockMembers(c, libraryId, [actor.id]), actor.id);
    const rows = (
      await c.query(
        `SELECT id,email,role,
                CASE WHEN state='pending' AND expires_at<=now() THEN 'expired' ELSE state END AS status,
                created_at AS "createdAt",expires_at AS "expiresAt",
                accepted_at AS "acceptedAt",revoked_at AS "revokedAt"
           FROM template_library_invitations
          WHERE library_id=$1 AND state<>'redacted'
          ORDER BY created_at DESC,id DESC LIMIT 501`,
        [libraryId],
      )
    ).rows;
    return { items: rows.slice(0, 500), hasMore: rows.length > 500 };
  });
}

export async function revokeTemplateLibraryInvitation(
  actor: Actor,
  libraryId: string,
  invitationId: string,
) {
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    requireAdmin(await lockMembers(c, libraryId, [actor.id]), actor.id);
    const invitation = (
      await c.query(
        `SELECT state,role FROM template_library_invitations
          WHERE id=$1 AND library_id=$2 FOR UPDATE`,
        [invitationId, libraryId],
      )
    ).rows[0];
    if (!invitation) throw missing();
    if (invitation.state === "revoked") return { ok: true };
    if (invitation.state !== "pending")
      throw new Problem(
        409,
        "conflict",
        "Принятое приглашение нельзя отозвать.",
      );
    await c.query(
      `UPDATE template_library_invitations
          SET state='revoked',revoked_at=clock_timestamp(),token_hash=NULL
        WHERE id=$1`,
      [invitationId],
    );
    await audit(c, actor, "template_library.invitation_revoked", invitationId);
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.invitation_revoked",
      "invitation",
      invitationId,
      invitation.role,
      null,
    );
    return { ok: true };
  });
}

export async function acceptTemplateLibraryInvitation(
  actor: Actor,
  libraryId: string,
  body: unknown,
) {
  const input = acceptTemplateLibraryInvitationInput.parse(body);
  return transaction(async (c) => {
    // Discover the issuer only to acquire the established account-before-library
    // lock order. The invitation is re-read and authenticated under lock below.
    const discovered = (
      await c.query(
        `SELECT invited_by FROM template_library_invitations
          WHERE token_hash=$1 AND library_id=$2`,
        [sha256(input.token), libraryId],
      )
    ).rows[0];
    if (!discovered) throw missing();
    await lockActorAndAccounts(
      c,
      actor,
      discovered.invited_by ? [discovered.invited_by] : [],
    );
    await lockLibrary(c, libraryId);
    const invitation = (
      await c.query(
        `SELECT *,expires_at>clock_timestamp() AS fresh FROM template_library_invitations
          WHERE token_hash=$1 AND library_id=$2 FOR UPDATE`,
        [sha256(input.token), libraryId],
      )
    ).rows[0];
    if (!invitation) throw missing();
    if (invitation.invited_by !== discovered.invited_by) throw missing();
    if (invitation.state === "accepted") {
      if (invitation.accepted_by !== actor.id) throw missing();
      const epoch = await c.query(
        `SELECT member.role FROM template_library_invitations accepted
           JOIN template_library_members member
             ON member.library_id=accepted.library_id
            AND member.account_id=accepted.accepted_by
            AND member.joined_at=accepted.accepted_membership_joined_at
          WHERE accepted.id=$1 AND accepted.library_id=$2 AND accepted.accepted_by=$3
            AND member.state='active' AND member.revoked_at IS NULL`,
        [invitation.id, libraryId, actor.id],
      );
      if (!epoch.rowCount)
        throw new Problem(
          409,
          "conflict",
          "Это приглашение уже было использовано, а доступ отозван.",
        );
      return { libraryId, role: epoch.rows[0].role };
    }
    if (invitation.state !== "pending")
      throw new Problem(409, "conflict", "Приглашение уже недействительно.");
    if (!invitation.fresh)
      throw new Problem(409, "conflict", "Срок действия приглашения истёк.");
    const account = (
      await c.query(
        `SELECT email,email_verified_at FROM accounts
          WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL`,
        [actor.id],
      )
    ).rows[0];
    if (!account || account.email !== invitation.email)
      throw new Problem(
        403,
        "forbidden",
        "Приглашение предназначено для другого подтверждённого адреса.",
      );
    if (!account.email_verified_at)
      throw new Problem(
        403,
        "forbidden",
        "Сначала подтвердите адрес электронной почты аккаунта.",
      );
    const issuer = await c.query(
      `SELECT 1 FROM template_library_members member
         JOIN accounts account ON account.id=member.account_id
        WHERE member.library_id=$1 AND member.account_id=$2
          AND member.role='admin' AND member.state='active' AND member.revoked_at IS NULL
          AND NOT account.disabled AND account.deletion_requested_at IS NULL`,
      [libraryId, invitation.invited_by],
    );
    if (!issuer.rowCount)
      throw new Problem(
        409,
        "conflict",
        "Администратор, создавший приглашение, больше не может выдавать доступ.",
      );
    const active = await c.query(
      `SELECT 1 FROM template_library_members
        WHERE library_id=$1 AND account_id=$2 AND state='active' AND revoked_at IS NULL`,
      [libraryId, actor.id],
    );
    if (active.rowCount)
      throw new Problem(409, "conflict", "Аккаунт уже состоит в библиотеке.");
    await c.query(
      `INSERT INTO template_library_members(library_id,account_id,role)
       VALUES($1,$2,$3)`,
      [libraryId, actor.id, invitation.role],
    );
    await c.query(
      `UPDATE template_library_invitations
          SET state='accepted',accepted_at=clock_timestamp(),accepted_by=$2,
              accepted_membership_joined_at=(
                SELECT joined_at FROM template_library_members
                 WHERE library_id=$3 AND account_id=$2
                   AND state='active' AND revoked_at IS NULL
              )
        WHERE id=$1`,
      [invitation.id, actor.id, libraryId],
    );
    await audit(
      c,
      actor,
      "template_library.invitation_accepted",
      invitation.id,
    );
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.invitation_accepted",
      "account",
      actor.id,
      null,
      invitation.role,
    );
    return { libraryId, role: invitation.role };
  });
}

async function requirePublisher(
  c: PoolClient,
  libraryId: string,
  actorId: string,
) {
  const rows = await lockMembers(c, libraryId, [actorId]);
  const member = rows.find(
    (row) =>
      row.account_id === actorId &&
      row.state === "active" &&
      row.revoked_at === null,
  );
  if (
    !member ||
    member.state !== "active" ||
    member.revoked_at !== null ||
    !(["curator", "admin"] as TemplateLibraryRole[]).includes(member.role)
  )
    throw missing();
  return member;
}

export async function publishTemplateLibraryRelease(
  actor: Actor,
  libraryId: string,
  body: unknown,
) {
  const input = publishTemplateLibraryReleaseInput.parse(body);
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    await requirePublisher(c, libraryId, actor.id);
    const release = (
      await c.query(
        `SELECT release.id,release.artifact_id,release.revision_id
           FROM template_releases release
           JOIN artifacts artifact ON artifact.id=release.artifact_id
           JOIN revisions revision ON revision.id=release.revision_id
             AND revision.artifact_id=artifact.id AND revision.tenant_id=artifact.tenant_id
          WHERE release.id=$1 AND artifact.tenant_id=$2 AND artifact.created_by=$3
            AND artifact.trashed_at IS NULL
          FOR UPDATE OF artifact,revision`,
        [input.releaseId, actor.tenant, actor.id],
      )
    ).rows[0];
    if (!release) throw missing();
    const existing = (
      await c.query(
        "SELECT * FROM template_library_publications WHERE library_id=$1 AND release_id=$2 FOR UPDATE",
        [libraryId, input.releaseId],
      )
    ).rows[0];
    if (existing) {
      if (existing.state === "active" && existing.withdrawn_at === null)
        return {
          id: existing.id,
          releaseId: existing.release_id,
          state: "active" as const,
        };
      throw new Problem(
        409,
        "conflict",
        "Этот выпуск уже был отозван из библиотеки.",
      );
    }

    const id = randomUUID();
    await c.query(
      `INSERT INTO template_library_publications(
         id,library_id,release_id,artifact_id,revision_id,publisher_id
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        libraryId,
        release.id,
        release.artifact_id,
        release.revision_id,
        actor.id,
      ],
    );
    await audit(c, actor, "template_library.release_published", id);
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.release_published",
      "publication",
      id,
    );
    return { id, releaseId: release.id, state: "active" as const };
  });
}

export async function withdrawTemplateLibraryPublication(
  actor: Actor,
  libraryId: string,
  publicationId: string,
  body: unknown,
) {
  const input = withdrawTemplateLibraryPublicationInput.parse(body);
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    const publisher = await requirePublisher(c, libraryId, actor.id);
    const publication = (
      await c.query(
        `SELECT publication.* FROM template_library_publications publication
          WHERE publication.id=$1 AND publication.library_id=$2
          FOR UPDATE OF publication`,
        [publicationId, libraryId],
      )
    ).rows[0];
    if (!publication) throw missing();
    // Curators withdraw only their own publications; admins withdraw any.
    if (publisher.role !== "admin" && publication.publisher_id !== actor.id)
      throw missing();
    if (publication.state === "withdrawn" && publication.withdrawn_at !== null)
      return { ok: true };
    if (publication.state !== "active" || publication.withdrawn_at !== null)
      throw missing();
    await c.query(
      `UPDATE template_library_publications
          SET state='withdrawn',withdrawn_at=clock_timestamp(),withdrawal_reason=$2
        WHERE id=$1`,
      [publicationId, input.reason],
    );
    await audit(
      c,
      actor,
      "template_library.publication_withdrawn",
      publicationId,
    );
    await libraryEvent(
      c,
      actor,
      libraryId,
      "template_library.publication_withdrawn",
      "publication",
      publicationId,
    );
    return { ok: true };
  });
}

export async function listTemplateLibraryPublications(
  actor: Actor,
  libraryId: string,
) {
  return transaction(async (c) => {
    await lockActorAndAccounts(c, actor);
    await lockLibrary(c, libraryId);
    const members = await lockMembers(c, libraryId, [actor.id]);
    if (
      !members[0] ||
      members[0].state !== "active" ||
      members[0].revoked_at !== null
    )
      throw missing();
    const rows = (
      await c.query(
        `SELECT publication.id,publication.release_id AS "releaseId",
                publication.artifact_id AS "artifactId",
                publication.revision_id AS "revisionId",release.title,release.summary,
                publication.published_at AS "publishedAt"
           FROM template_library_publications publication
           JOIN template_releases release ON release.id=publication.release_id
             AND release.artifact_id=publication.artifact_id
             AND release.revision_id=publication.revision_id
           JOIN artifacts artifact ON artifact.id=publication.artifact_id
           JOIN revisions revision ON revision.id=publication.revision_id
             AND revision.artifact_id=artifact.id AND revision.tenant_id=artifact.tenant_id
           JOIN tenants source_tenant ON source_tenant.id=artifact.tenant_id
           JOIN accounts source_account ON source_account.id=source_tenant.owner_id
          WHERE publication.library_id=$1 AND publication.state='active'
            AND publication.withdrawn_at IS NULL AND artifact.trashed_at IS NULL
            AND NOT source_account.disabled AND source_account.deletion_requested_at IS NULL
          ORDER BY publication.published_at DESC,publication.id LIMIT 101`,
        [libraryId],
      )
    ).rows;
    return { items: rows.slice(0, 100), hasMore: rows.length > 100 };
  });
}
