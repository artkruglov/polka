import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  publishSchema,
  shareSchema,
  uuid,
} from "../../packages/contracts/index.ts";
import {
  assertLinkable,
  audit,
  getArtifact,
  tokenFor,
  type Actor,
} from "./artifacts.ts";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import {
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";
import { sha256 } from "./storage.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";
import { dispatchModerationNotices } from "./moderation-mail.ts";
import {
  MODERATION_MESSAGE,
  assertNewAccountLimits,
  authorStanding,
  decideModeration,
  type ModerationNotice,
} from "./share-moderation.ts";

type ShareInput = z.infer<typeof shareSchema>;
type PublishInput = z.infer<typeof publishSchema>;

export const agentShareSchema = shareSchema.extend({
  key: uuid,
  artifactId: uuid,
});

export const agentRevokeShareSchema = z.object({ shareId: uuid }).strict();

type ExistingPolicy = "web" | "agent-exact";

async function lockArtifact(
  c: PoolClient,
  actor: Actor,
  artifactId: string,
  requireActive = true,
) {
  const {
    rows: [artifact],
  } = await c.query(
    `SELECT * FROM artifacts
     WHERE id=$1 AND tenant_id=$2
       AND ($3::boolean=false OR trashed_at IS NULL)
     FOR UPDATE`,
    [artifactId, actor.tenant, requireActive],
  );
  if (!artifact) throw missing();
  return artifact;
}

async function revisionSignals(c: PoolClient, revisionId: string) {
  const {
    rows: [row],
  } = await c.query("SELECT phishing_signals FROM revisions WHERE id=$1", [
    revisionId,
  ]);
  return (row?.phishing_signals ?? []) as string[];
}

/**
 * The single place a link is created. New accounts meet their limits here,
 * and SHARE_MODERATION decides whether the link waits for the operator
 * (docs/specs/ABUSE_PROTECTION.md). Letters to the operator are collected in
 * `notices` and sent by the caller after commit.
 */
async function enableShareInTransaction(
  c: PoolClient,
  actor: Actor,
  artifactId: string,
  input: ShareInput,
  existingPolicy: ExistingPolicy,
  notices: ModerationNotice[] = [],
) {
  const artifact = await lockArtifact(c, actor, artifactId);
  if (artifact.latest_revision_id !== input.expectedRevisionId)
    throw new Problem(
      409,
      "conflict",
      "Работа изменилась. Проверьте текущую версию перед отправкой.",
    );
  const {
    rows: [existing],
  } = await c.query(
    `SELECT * FROM shares
     WHERE artifact_id=$1 AND NOT revoked AND expires_at>now()
     FOR UPDATE`,
    [artifactId],
  );
  if (existing) {
    if (existingPolicy === "agent-exact") {
      if (existing.revision_id !== input.expectedRevisionId)
        throw new Problem(
          409,
          "conflict",
          "Активная ссылка указывает на другую версию.",
        );
      const derivativeId = await assertLinkable(c, existing.revision_id);
      if (existing.derivative_id !== derivativeId)
        throw new Problem(
          409,
          "conflict",
          "Активная ссылка использует другую подготовленную версию.",
        );
    }
    return existing;
  }
  const derivativeId = await assertLinkable(c, artifact.latest_revision_id);
  const standing = await authorStanding(c, actor.tenant);
  await assertNewAccountLimits(c, standing, actor.tenant, input.expiresInDays);
  const decision = decideModeration(
    standing,
    await revisionSignals(c, artifact.latest_revision_id),
  );
  await c.query("UPDATE shares SET revoked=true WHERE artifact_id=$1", [
    artifactId,
  ]);
  const shareId = randomUUID();
  const {
    rows: [created],
  } = await c.query(
    `INSERT INTO shares(
       id,tenant_id,artifact_id,revision_id,derivative_id,token_hash,expires_at,
       moderation,moderation_reason,moderated_at
     ) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 day',
       CASE WHEN $8::text IS NULL THEN 'none' ELSE 'held' END,$8,
       CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
     RETURNING *`,
    [
      shareId,
      actor.tenant,
      artifactId,
      artifact.latest_revision_id,
      derivativeId,
      sha256(tokenFor(shareId)),
      input.expiresInDays,
      decision.hold,
    ],
  );
  await audit(c, actor, "share.enabled", shareId);
  if (decision.hold) notices.push({ kind: "held", shareId });
  else if (decision.notify) notices.push({ kind: "suspicious", shareId });
  return created;
}

async function artifactIdForShare(
  c: PoolClient,
  actor: Actor,
  shareId: string,
) {
  return (
    await c.query(
      "SELECT artifact_id FROM shares WHERE id=$1 AND tenant_id=$2",
      [shareId, actor.tenant],
    )
  ).rows[0]?.artifact_id as string | undefined;
}

export async function revokeLockedShareInTransaction(
  c: PoolClient,
  actor: Actor,
  share: any,
) {
  if (!share) return { ok: true };
  if (share.tenant_id !== actor.tenant) throw missing();
  if (share.revoked) return { ok: true };
  await c.query("UPDATE shares SET revoked=true WHERE id=$1", [share.id]);
  await audit(c, actor, "share.revoked", share.id);
  return { ok: true };
}

export async function revokeShareInTransaction(
  c: PoolClient,
  actor: Actor,
  shareId: string,
) {
  const artifactId = await artifactIdForShare(c, actor, shareId);
  if (!artifactId) return { ok: true };
  await lockArtifact(c, actor, artifactId, false);
  const {
    rows: [share],
  } = await c.query(
    "SELECT * FROM shares WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [shareId, actor.tenant],
  );
  return revokeLockedShareInTransaction(c, actor, share);
}

async function publishShareInTransaction(
  c: PoolClient,
  actor: Actor,
  shareId: string,
  input: PublishInput,
  notices: ModerationNotice[] = [],
) {
  const artifactId = await artifactIdForShare(c, actor, shareId);
  if (!artifactId) throw missing();
  await lockArtifact(c, actor, artifactId);
  const {
    rows: [share],
  } = await c.query(
    "SELECT * FROM shares WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [shareId, actor.tenant],
  );
  if (!share) throw missing();
  if (share.revoked || new Date(share.expires_at).getTime() <= Date.now())
    throw new Problem(410, "expired", "Ссылка уже закрыта или истекла.");
  if (
    (
      await c.query("SELECT 1 FROM editorial_publications WHERE share_id=$1", [
        shareId,
      ])
    ).rowCount
  )
    throw new Problem(
      409,
      "conflict",
      "Версия ссылки зафиксирована редакционной публикацией.",
    );
  if (share.revision_id !== input.expectedPublishedRevisionId)
    throw new Problem(
      409,
      "conflict",
      "Ссылка уже обновлена. Проверьте отправленную версию.",
    );
  if (
    !(
      await c.query(
        "SELECT 1 FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3",
        [input.revisionId, share.artifact_id, actor.tenant],
      )
    ).rowCount
  )
    throw missing();
  const derivativeId = await assertLinkable(c, input.revisionId);
  // A new version is new content: an approved link of an untrusted author
  // waits again, and a suspicious version is reported like a new link.
  const decision =
    share.moderation === "none"
      ? decideModeration(
          await authorStanding(c, actor.tenant),
          await revisionSignals(c, input.revisionId),
        )
      : { hold: null, notify: false };
  await c.query(
    `UPDATE shares SET revision_id=$2,derivative_id=$3,
       moderation=CASE WHEN $4::text IS NULL THEN moderation ELSE 'held' END,
       moderation_reason=COALESCE($4,moderation_reason),
       moderated_at=CASE WHEN $4::text IS NULL THEN moderated_at ELSE now() END
     WHERE id=$1`,
    [shareId, input.revisionId, derivativeId, decision.hold],
  );
  if (decision.hold) notices.push({ kind: "held", shareId });
  else if (decision.notify) notices.push({ kind: "suspicious", shareId });
  await audit(c, actor, "share.published", shareId);
  return { ok: true };
}

export async function enableOwnerShare(
  actor: Actor,
  artifactId: string,
  body: unknown,
) {
  const input = shareSchema.parse(body);
  const notices: ModerationNotice[] = [];
  await transaction(async (c) => {
    await lockActiveOwnerTenant(c, actor);
    await enableShareInTransaction(c, actor, artifactId, input, "web", notices);
  });
  void dispatchModerationNotices(notices);
  return getArtifact(actor, artifactId);
}

export async function revokeOwnerShare(actor: Actor, shareId: string) {
  return transaction(async (c) => {
    await lockActiveOwnerTenant(c, actor);
    return revokeShareInTransaction(c, actor, shareId);
  });
}

export async function publishOwnerShare(
  actor: Actor,
  shareId: string,
  body: unknown,
) {
  const input = publishSchema.parse(body);
  const notices: ModerationNotice[] = [];
  const result = await transaction(async (c) => {
    await lockActiveOwnerTenant(c, actor);
    return publishShareInTransaction(c, actor, shareId, input, notices);
  });
  void dispatchModerationNotices(notices);
  return result;
}

type AgentShareResult = {
  shareId: string;
  artifactId: string;
  revisionId: string;
  derivativeId: string | null;
  expiresAt: string;
};

const agentShareResultSchema = z
  .object({
    shareId: uuid,
    artifactId: uuid,
    revisionId: uuid,
    derivativeId: uuid.nullable(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const canonicalAgentShareRequest = (
  input: z.infer<typeof agentShareSchema>,
) => ({
  key: input.key,
  artifactId: input.artifactId,
  expectedRevisionId: input.expectedRevisionId,
  expiresInDays: input.expiresInDays,
});

async function agentShareResponse(
  c: PoolClient,
  actor: ServiceActor,
  result: AgentShareResult,
) {
  const {
    rows: [share],
  } = await c.query(
    `SELECT share.*,artifact.trashed_at FROM shares share
     JOIN artifacts artifact ON artifact.id=share.artifact_id
     WHERE share.id=$1 AND share.tenant_id=$2 AND share.artifact_id=$3`,
    [result.shareId, actor.tenantId, result.artifactId],
  );
  const active =
    share &&
    !share.trashed_at &&
    !share.revoked &&
    new Date(share.expires_at).getTime() > Date.now() &&
    share.revision_id === result.revisionId &&
    share.derivative_id === result.derivativeId;
  const moderation = (active ? share.moderation : "none") as
    | "none"
    | "held"
    | "paused";
  return {
    ...result,
    state: active ? ("active" as const) : ("closed" as const),
    url: active ? `${config.APP_ORIGIN}/s#${tokenFor(result.shareId)}` : null,
    // A waiting link is not a finished one: the agent must say so. Present
    // only while the link waits, so ordinary answers keep their shape.
    ...(moderation !== "none"
      ? { moderation, moderationMessage: MODERATION_MESSAGE[moderation] }
      : {}),
  };
}

export async function shareFromAgent(actor: ServiceActor, body: unknown) {
  const input = agentShareSchema.parse(body);
  const request = canonicalAgentShareRequest(input);
  const requestHash = sha256(JSON.stringify(request));
  const notices: ModerationNotice[] = [];
  const response = await withServiceActorTransaction(
    actor,
    "share",
    async (c, verified) => {
    const {
      rows: [old],
    } = await c.query(
      `SELECT * FROM agent_operations
       WHERE tenant_id=$1 AND operation='share' AND idempotency_key=$2
       FOR UPDATE`,
      [verified.tenantId, input.key],
    );
    if (old) {
      if (old.connection_id !== verified.connectionId)
        throw new Problem(
          409,
          "conflict",
          "Ключ уже относится к другой операции.",
        );
      if (
        old.request_hash !== requestHash ||
        JSON.stringify(
          canonicalAgentShareRequest(agentShareSchema.parse(old.request)),
        ) !== JSON.stringify(request)
      )
        throw new Problem(
          409,
          "conflict",
          "Этот повтор относится к другой ссылке.",
        );
      return agentShareResponse(
        c,
        verified,
        agentShareResultSchema.parse(old.result),
      );
    }
    const owner: Actor = {
      id: verified.accountId,
      tenant: verified.tenantId,
      connectionId: verified.connectionId,
    };
    const share = await enableShareInTransaction(
      c,
      owner,
      input.artifactId,
      input,
      "agent-exact",
      notices,
    );
    const result: AgentShareResult = {
      shareId: share.id,
      artifactId: share.artifact_id,
      revisionId: share.revision_id,
      derivativeId: share.derivative_id ?? null,
      expiresAt: new Date(share.expires_at).toISOString(),
    };
    await c.query(
      `INSERT INTO agent_operations(
         id,tenant_id,account_id,connection_id,operation,idempotency_key,
         request,request_hash,result
       ) VALUES($1,$2,$3,$4,'share',$5,$6,$7,$8)`,
      [
        randomUUID(),
        verified.tenantId,
        verified.accountId,
        verified.connectionId,
        input.key,
        request,
        requestHash,
        result,
      ],
    );
    return agentShareResponse(c, verified, result);
    },
  );
  void dispatchModerationNotices(notices);
  return response;
}

export async function revokeShareFromAgent(actor: ServiceActor, body: unknown) {
  const { shareId } = agentRevokeShareSchema.parse(body);
  return withServiceActorTransaction(actor, "share", (c, verified) =>
    revokeShareInTransaction(
      c,
      {
        id: verified.accountId,
        tenant: verified.tenantId,
        connectionId: verified.connectionId,
      },
      shareId,
    ),
  );
}
