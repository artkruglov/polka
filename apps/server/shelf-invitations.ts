// Invitation links to a department shelf (docs/specs/TEAM_SHELVES.md,
// «Приглашение ссылкой»), for colleagues who have never signed in to Полка
// and so cannot be added by address. The pattern is the template library's
// (template-libraries.ts): the secret lives only in the link's fragment, the
// database keeps its hash, the link expires within 7 days and can be revoked.
// Unlike a library invitation it is not bound to an address: a shelf link is
// handed over in the company's own chat, and whoever opens it signed in
// joins. Hence the uses limit (1 by default) and the roles: never admin, and
// a curator invites only readers and authors.
//
// Lock order is shelf-members.ts's: the shelf, the accounts by id, their
// memberships; the link's row after the shelf.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { isUnclaimed } from "./provisional.ts";
import { lockAccounts, lockMemberships, lockTeamShelf, roleOf } from "./shelf-members.ts";
import type { ShelfRole } from "./shelves.ts";
import { sha256 } from "./storage.ts";

type Actor = { id: string };

export const INVITATION_ROLES = ["reader", "author", "curator"] as const;
type InvitationRole = (typeof INVITATION_ROLES)[number];

export const createShelfInvitationInput = z
  .object({
    role: z.enum(INVITATION_ROLES).default("author"),
    expiresInHours: z.number().int().min(1).max(168).default(72),
    maxUses: z.number().int().min(1).max(50).default(1),
  })
  .strict();

const acceptInput = z.object({ token: z.string().min(32).max(512) }).strict();

/** An admin hands out any role below its own; a curator, reader and author. */
export const mayInvite = (inviter: ShelfRole, role: InvitationRole) =>
  inviter === "admin" || (inviter === "curator" && role !== "curator");

function assertMayInvite(inviter: ShelfRole, role: InvitationRole) {
  if (inviter !== "admin" && inviter !== "curator")
    throw new Problem(403, "forbidden", "Приглашать на полку могут её администратор и куратор.");
  if (!mayInvite(inviter, role))
    throw new Problem(403, "forbidden", "Куратор приглашает читателей и авторов. Кураторов приглашает администратор.");
}

const journal = (
  c: PoolClient,
  shelfId: string,
  actor: Actor,
  action: "invitation_created" | "invitation_revoked" | "invitation_accepted",
  invitationId: string,
  role: string,
) =>
  c.query(
    `INSERT INTO tenant_member_events(tenant_id,actor_id,action,target_account_id,old_role,new_role,invitation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      shelfId,
      actor.id,
      action,
      action === "invitation_accepted" ? actor.id : null,
      action === "invitation_revoked" ? role : null,
      action === "invitation_revoked" ? null : role,
      invitationId,
    ],
  );

export async function createShelfInvitation(actor: Actor, shelfId: string, body: unknown) {
  const input = createShelfInvitationInput.parse(body);
  return transaction(async (c) => {
    const shelf = await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id]);
    assertMayInvite(roleOf(await lockMemberships(c, shelfId, [actor.id]), active, actor.id), input.role);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const {
      rows: [row],
    } = await c.query(
      `WITH moment AS (SELECT clock_timestamp() AS value)
       INSERT INTO tenant_invitations(id,tenant_id,role,token_hash,max_uses,invited_by,created_at,expires_at)
       SELECT $1,$2,$3,$4,$5,$6,value,value+make_interval(hours=>$7) FROM moment
       RETURNING created_at,expires_at`,
      [id, shelfId, input.role, sha256(token), input.maxUses, actor.id, input.expiresInHours],
    );
    await journal(c, shelfId, actor, "invitation_created", id, input.role);
    const fragment = new URLSearchParams({ token, shelfId }).toString();
    return {
      id,
      shelfName: shelf.name,
      role: input.role,
      maxUses: input.maxUses,
      uses: 0,
      status: "active" as const,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      // Shown once: only the hash is kept.
      invitationUrl: `${config.APP_ORIGIN}/shelf-invite#${fragment}`,
    };
  });
}

/** The shelf's links, newest first; for its admins and curators. */
export async function listShelfInvitations(actor: Actor, shelfId: string) {
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id]);
    const role = roleOf(await lockMemberships(c, shelfId, [actor.id]), active, actor.id);
    if (role !== "admin" && role !== "curator")
      throw new Problem(403, "forbidden", "Приглашения видят администратор и куратор полки.");
    const { rows } = await c.query(
      `SELECT invitation.id,invitation.role,invitation.max_uses AS "maxUses",invitation.uses,
              CASE WHEN invitation.state='revoked' THEN 'revoked'
                   WHEN invitation.uses>=invitation.max_uses THEN 'used'
                   WHEN invitation.expires_at<=now() THEN 'expired'
                   ELSE 'active' END AS status,
              invitation.created_at AS "createdAt",invitation.expires_at AS "expiresAt",
              invitation.revoked_at AS "revokedAt",
              invitation.invited_by AS "invitedBy",
              COALESCE(inviter.display_name,inviter.name) AS "inviterName"
       FROM tenant_invitations invitation
       LEFT JOIN accounts inviter ON inviter.id=invitation.invited_by
       WHERE invitation.tenant_id=$1
       ORDER BY invitation.created_at DESC,invitation.id DESC LIMIT 101`,
      [shelfId],
    );
    return { items: rows.slice(0, 100), hasMore: rows.length > 100 };
  });
}

/** The admin revokes any link; a curator, the ones it issued. Idempotent. */
export async function revokeShelfInvitation(actor: Actor, shelfId: string, invitationId: string) {
  return transaction(async (c) => {
    await lockTeamShelf(c, shelfId);
    const active = await lockAccounts(c, [actor.id]);
    const role = roleOf(await lockMemberships(c, shelfId, [actor.id]), active, actor.id);
    if (role !== "admin" && role !== "curator")
      throw new Problem(403, "forbidden", "Приглашения отзывают администратор и куратор полки.");
    const {
      rows: [invitation],
    } = await c.query("SELECT state,role,invited_by FROM tenant_invitations WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [
      invitationId,
      shelfId,
    ]);
    if (!invitation) throw missing();
    if (role === "curator" && invitation.invited_by !== actor.id)
      throw new Problem(403, "forbidden", "Куратор отзывает только свои приглашения.");
    if (invitation.state === "revoked") return { ok: true };
    await c.query(
      `UPDATE tenant_invitations SET state='revoked',revoked_at=clock_timestamp(),token_hash=NULL
       WHERE id=$1`,
      [invitationId],
    );
    await journal(c, shelfId, actor, "invitation_revoked", invitationId, invitation.role);
    return { ok: true };
  });
}

/**
 * The signed-in person who opened the link joins the shelf with its role.
 * Someone already on the shelf keeps the role they have and spends no use.
 * The link works only while whoever issued it may still hand out that role.
 */
export async function acceptShelfInvitation(actor: Actor, shelfId: string, body: unknown) {
  const { token } = acceptInput.parse(body);
  return transaction(async (c) => {
    const shelf = await lockTeamShelf(c, shelfId);
    const {
      rows: [invitation],
    } = await c.query(
      `SELECT *,expires_at>clock_timestamp() AS fresh FROM tenant_invitations
       WHERE token_hash=$1 AND tenant_id=$2 FOR UPDATE`,
      [sha256(token), shelfId],
    );
    if (!invitation) throw missing();
    const inviter: string | null = invitation.invited_by;
    const active = await lockAccounts(c, inviter ? [actor.id, inviter] : [actor.id]);
    if (!active.has(actor.id)) throw missing();
    const memberships = await lockMemberships(c, shelfId, inviter ? [actor.id, inviter] : [actor.id]);
    const mine = memberships.get(actor.id);
    if (mine?.state === "active") return { shelfId, name: shelf.name, role: mine.role as ShelfRole, joined: false };
    if (invitation.state !== "active") throw new Problem(409, "conflict", "Приглашение отозвано.");
    if (!invitation.fresh) throw new Problem(409, "conflict", "Срок действия приглашения истёк.");
    if (invitation.uses >= invitation.max_uses) throw new Problem(409, "conflict", "Приглашение уже использовано.");
    const issuer = inviter ? memberships.get(inviter) : undefined;
    if (!inviter || !active.has(inviter) || issuer?.state !== "active" || !mayInvite(issuer.role, invitation.role))
      throw new Problem(409, "conflict", "Тот, кто пригласил, больше не может выдавать доступ к этой полке.");
    if (await isUnclaimed(c, actor.id))
      throw new Problem(
        403,
        "forbidden",
        "Временная полка не может вступить в полку отдела. Войдите в Полку, затем откройте ссылку снова.",
      );
    await c.query(
      `INSERT INTO tenant_members(tenant_id,account_id,role,invited_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (tenant_id,account_id) DO UPDATE
         SET role=EXCLUDED.role,state='active',revoked_at=NULL,
             joined_at=now(),invited_by=EXCLUDED.invited_by`,
      [shelfId, actor.id, invitation.role, inviter],
    );
    await c.query("UPDATE tenant_invitations SET uses=uses+1 WHERE id=$1", [invitation.id]);
    await journal(c, shelfId, actor, "invitation_accepted", invitation.id, invitation.role);
    return { shelfId, name: shelf.name, role: invitation.role as ShelfRole, joined: true };
  });
}
