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
  SIGNED_UP_SQL,
  assertNewAccountLimits,
  authorStanding,
  decideModeration,
  type AuthorStanding,
  type ModerationDecision,
  type ModerationNotice,
} from "./share-moderation.ts";
import { db } from "./db.ts";
import {
  blockRevisionInTransaction,
  modelView,
  recordEvent,
  revisionBlocked,
} from "./content-moderation.ts";
import { CATEGORY_LABEL, decideContent } from "./content-filter/policy.ts";
import {
  mergeResults,
  scanText,
  type FilterResult,
} from "./content-filter/scanner.ts";

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

/** Where an owner appeals a block. */
export const appealContact = () =>
  config.OPERATOR_CONTACT ?? config.OPERATOR_EMAIL ?? null;

const blockedRefusal = () =>
  new Problem(
    403,
    "forbidden",
    `Эта работа заблокирована модератором Полки: ссылку на неё создать нельзя.${
      appealContact()
        ? ` Если считаете решение ошибочным, напишите на ${appealContact()}.`
        : ""
    }`,
  );

/**
 * The same content (sha256, or a near-duplicate text by SimHash) saved by
 * other accounts that signed up by email within a day: a spam run. Two other
 * accounts make three in all.
 */
async function duplicates(
  c: PoolClient,
  tenantId: string,
  revision: { sha256: string; size: number; content_filter: FilterResult },
) {
  const simhash = revision.content_filter?.simhash ?? null;
  const { rows } = await c.query(
    `SELECT revision.id,revision.tenant_id FROM revisions revision
     JOIN tenants tenant ON tenant.id=revision.tenant_id
     JOIN accounts account ON account.id=tenant.owner_id
     WHERE revision.created_at>now()-interval '1 day'
       AND revision.tenant_id<>$1 AND ${SIGNED_UP_SQL("account")}
       AND ((revision.sha256=$2 AND $3::bigint>=512)
         OR ($4::text IS NOT NULL AND revision.content_filter ? 'simhash'
             AND bit_count(('x'||(revision.content_filter->>'simhash'))::bit(64)
                   # ('x'||$4::text)::bit(64))<=3))
     LIMIT 200`,
    [tenantId, revision.sha256, revision.size, simhash],
  );
  const tenants = new Set(rows.map((row) => row.tenant_id));
  return tenants.size >= 2
    ? {
        revisionIds: rows.map((row) => row.id as string),
        filter: {
          v: 1,
          hits: {
            spam: {
              score: 6,
              terms: [`то же содержимое ещё у ${tenants.size} аккаунтов за сутки`],
            },
          },
        } satisfies FilterResult,
      }
    : null;
}

/**
 * What the content filter says about linking this revision: its save-time
 * findings, the work's title, duplicates across accounts and the model's
 * verdicts. Other accounts' links to the same spam are held too.
 */
async function moderationFor(
  c: PoolClient,
  standing: AuthorStanding,
  tenantId: string,
  artifactTitle: string | null,
  revisionId: string,
  notices: ModerationNotice[],
): Promise<ModerationDecision> {
  const {
    rows: [revision],
  } = await c.query(
    `SELECT phishing_signals,content_filter,sha256,size,mime,
       EXISTS(SELECT 1 FROM revision_files file
              WHERE file.revision_id=revisions.id AND file.mime LIKE 'image/%') AS bundle_images
     FROM revisions WHERE id=$1
     -- The models' verdict is written to this row after a save: either it is
     -- here now, or its writer waits for this link to commit and then
     -- reconsiders it (content-moderation.ts, reconsiderLinks).
     FOR SHARE OF revisions`,
    [revisionId],
  );
  const stored = (revision?.content_filter ?? {}) as FilterResult;
  const model = modelView(stored);
  const spam =
    config.CONTENT_FILTER_MODE !== "off" && !standing.operatorCreated && revision
      ? await duplicates(c, tenantId, { ...revision, size: Number(revision.size) })
      : null;
  const content = decideContent({
    filter: mergeResults(stored, scanText(artifactTitle ?? ""), spam?.filter),
    model,
    standing,
    mode: config.CONTENT_FILTER_MODE,
    autoblock: config.CONTENT_FILTER_AUTOBLOCK,
    fraud: config.SHARE_MODERATION !== "off",
  });
  if (spam) {
    const held = await c.query(
      `UPDATE shares share SET moderation='held',moderation_reason='spam:duplicate',
         moderated_at=now()
       FROM tenants tenant JOIN accounts account ON account.id=tenant.owner_id
       WHERE share.revision_id=ANY($1::uuid[]) AND share.moderation='none'
         AND NOT share.revoked AND share.expires_at>now()
         AND tenant.id=share.tenant_id AND ${SIGNED_UP_SQL("account")}
       RETURNING share.id,share.tenant_id,share.revision_id`,
      [spam.revisionIds],
    );
    for (const row of held.rows) {
      notices.push({ kind: "held", shareId: row.id });
      await recordEvent(c, {
        actor: "filter",
        action: "share.held",
        category: "spam",
        tenantId: row.tenant_id,
        revisionId: row.revision_id,
        shareId: row.id,
        reason: "то же содержимое опубликовано с нескольких аккаунтов",
      });
    }
  }
  // Images no model has looked at: none configured, not yet, failed, out of
  // budget, or images not sent (CONTENT_MODEL_IMAGES=false).
  const images =
    !!revision &&
    (String(revision.mime).startsWith("image/") ||
      revision.bundle_images ||
      (stored.images ?? 0) > 0) &&
    !(model.state === "checked" && config.CONTENT_MODEL_IMAGES);
  return decideModeration(
    standing,
    (revision?.phishing_signals ?? []) as string[],
    config.SHARE_MODERATION,
    content,
    images,
  );
}

/**
 * Act on a decision for a link that now exists: block (and maybe disable),
 * hold or report; journal it; queue the operator's letter.
 */
async function applyDecision(
  c: PoolClient,
  actor: Actor,
  share: { id: string; artifact_id: string; revision_id: string },
  decision: ModerationDecision,
  notices: ModerationNotice[],
) {
  const base = {
    accountId: actor.id,
    tenantId: actor.tenant,
    artifactId: share.artifact_id,
    revisionId: share.revision_id,
    shareId: share.id,
  };
  const details = decision.content
    ? { findings: decision.content.findings.map((finding) =>
        finding.category === "csam"
          ? { category: finding.category, score: finding.score, source: finding.source }
          : finding) }
    : {};
  if (decision.block) {
    const outcome = await blockRevisionInTransaction(c, {
      tenantId: actor.tenant,
      accountId: actor.id,
      artifactId: share.artifact_id,
      revisionId: share.revision_id,
      category: decision.block,
      actor: "filter",
      reason: `фильтр содержимого: ${CATEGORY_LABEL[decision.block]}`,
      freeze: !!decision.freeze,
      details,
    });
    notices.push({
      kind: "blocked",
      shareId: share.id,
      revisionId: share.revision_id,
      category: decision.block,
      frozen: outcome.frozen,
      by: "filter",
      content: decision.content,
    });
    return "blocked" as const;
  }
  if (decision.hold) {
    await recordEvent(c, {
      actor: "filter",
      action: "share.held",
      category: decision.content?.category ?? null,
      reason: decision.hold,
      details,
      ...base,
    });
    notices.push({ kind: "held", shareId: share.id, content: decision.content });
  } else if (decision.notify) {
    await recordEvent(c, {
      actor: "filter",
      action: "share.flagged",
      category: decision.content?.category ?? "fraud",
      details,
      ...base,
    });
    notices.push({ kind: "suspicious", shareId: share.id, content: decision.content });
  }
  return null;
}

/**
 * The models answered about a revision after links to it were made: decide
 * those links again, only ever more strictly (an open link may be held or
 * blocked; nothing held is opened by a model).
 */
export async function reconsiderLinks(revisionId: string) {
  const { rows } = await db.query(
    `SELECT share.id,share.tenant_id,tenant.owner_id FROM shares share
     JOIN tenants tenant ON tenant.id=share.tenant_id
     WHERE share.revision_id=$1 AND NOT share.revoked AND share.expires_at>now()
       AND share.moderation IN ('none','held')`,
    [revisionId],
  );
  const notices: ModerationNotice[] = [];
  for (const row of rows) {
    const actor: Actor = { id: row.owner_id, tenant: row.tenant_id };
    await transaction(async (c) => {
      await lockActiveOwnerTenant(c, actor).catch(() => null);
      const {
        rows: [share],
      } = await c.query(
        `SELECT share.*,artifact.title FROM shares share
         JOIN artifacts artifact ON artifact.id=share.artifact_id
         WHERE share.id=$1 AND NOT share.revoked FOR UPDATE OF share`,
        [row.id],
      );
      if (!share || share.moderation === "blocked") return;
      const decision = await moderationFor(
        c,
        await authorStanding(c, actor.tenant),
        actor.tenant,
        share.title,
        revisionId,
        notices,
      );
      if (decision.block) {
        await c.query(
          "UPDATE shares SET moderation_reason=$2 WHERE id=$1",
          [share.id, `blocked:${decision.block}`],
        );
        await applyDecision(c, actor, share, decision, notices);
      } else if (share.moderation === "none" && decision.content?.action === "hold") {
        await c.query(
          `UPDATE shares SET moderation='held',moderation_reason=$2,moderated_at=now()
           WHERE id=$1`,
          [share.id, decision.hold],
        );
        await applyDecision(c, actor, share, decision, notices);
      } else if (share.moderation === "none" && decision.content?.action === "notify")
        await applyDecision(c, actor, share, { ...decision, hold: null, notify: true }, notices);
    });
  }
  void dispatchModerationNotices(notices);
}

/** A link the filter blocked: the caller learns it after the block commits. */
function throwIfBlocked(notices: ModerationNotice[]) {
  if (notices.some((notice) => notice.kind === "blocked")) throw blockedRefusal();
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
    // A blocked link is not handed out again, to the owner or an agent.
    if (existing.moderation === "blocked") throw blockedRefusal();
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
  if (await revisionBlocked(c, artifact.latest_revision_id)) throw blockedRefusal();
  const derivativeId = await assertLinkable(c, artifact.latest_revision_id);
  const standing = await authorStanding(c, actor.tenant);
  await assertNewAccountLimits(c, standing, actor.tenant, input.expiresInDays);
  const decision = await moderationFor(
    c,
    standing,
    actor.tenant,
    artifact.title,
    artifact.latest_revision_id,
    notices,
  );
  const holdReason = decision.block ? `blocked:${decision.block}` : decision.hold;
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
      holdReason,
    ],
  );
  await audit(c, actor, "share.enabled", shareId);
  await applyDecision(c, actor, created, decision, notices);
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
  if (share.moderation === "blocked") throw blockedRefusal();
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
  if (await revisionBlocked(c, input.revisionId)) throw blockedRefusal();
  const derivativeId = await assertLinkable(c, input.revisionId);
  // A new version is new content: an approved link of an untrusted author
  // waits again, and a suspicious version is reported like a new link. The
  // content filter decides again even for a waiting link (it may block).
  const {
    rows: [artifact],
  } = await c.query("SELECT title FROM artifacts WHERE id=$1", [share.artifact_id]);
  const decision = await moderationFor(
    c,
    await authorStanding(c, actor.tenant),
    actor.tenant,
    artifact?.title ?? null,
    input.revisionId,
    notices,
  );
  if (share.moderation !== "none" && !decision.block) {
    decision.hold = null;
    decision.notify = false;
  }
  const holdReason = decision.block ? `blocked:${decision.block}` : decision.hold;
  await c.query(
    `UPDATE shares SET revision_id=$2,derivative_id=$3,
       moderation=CASE WHEN $4::text IS NULL THEN moderation ELSE 'held' END,
       moderation_reason=COALESCE($4,moderation_reason),
       moderated_at=CASE WHEN $4::text IS NULL THEN moderated_at ELSE now() END
     WHERE id=$1`,
    [shareId, input.revisionId, derivativeId, holdReason],
  );
  await applyDecision(
    c,
    actor,
    { id: shareId, artifact_id: share.artifact_id, revision_id: input.revisionId },
    decision,
    notices,
  );
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
    await enableShareInTransaction(
      c,
      actor,
      artifactId,
      input,
      "web",
      notices,
    );
  });
  void dispatchModerationNotices(notices);
  throwIfBlocked(notices);
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
  throwIfBlocked(notices);
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
  const moderation = (
    share?.moderation === "blocked" ? "blocked" : active ? share.moderation : "none"
  ) as "none" | "held" | "paused" | "blocked";
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
  throwIfBlocked(notices);
  return response;
}

/**
 * Point an existing link at the work's newest version (docs/specs/COMMENTS.md:
 * after a patch, the discussion moves with the link). The link keeps its
 * token, expiry and threads; a new version is new content, so moderation
 * decides again, as for the owner's «Обновить ссылку». Idempotent by key.
 */
export const agentMoveShareSchema = z
  .object({
    key: uuid,
    artifactId: uuid,
    shareId: uuid,
    expectedRevisionId: uuid,
  })
  .strict();

export async function moveShareFromAgent(actor: ServiceActor, body: unknown) {
  const input = agentMoveShareSchema.parse(body);
  const request = { ...input };
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
         WHERE tenant_id=$1 AND operation='share-move' AND idempotency_key=$2
         FOR UPDATE`,
        [verified.tenantId, input.key],
      );
      if (old) {
        if (
          old.connection_id !== verified.connectionId ||
          old.request_hash !== requestHash
        )
          throw new Problem(
            409,
            "conflict",
            "Ключ уже относится к другой операции.",
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
      const artifact = await lockArtifact(c, owner, input.artifactId);
      if (artifact.latest_revision_id !== input.expectedRevisionId)
        throw new Problem(
          409,
          "conflict",
          `Работа изменилась: последняя версия ${artifact.latest_revision_id}. Переносите ссылку на неё.`,
        );
      const {
        rows: [share],
      } = await c.query(
        `SELECT * FROM shares WHERE id=$1 AND tenant_id=$2 AND artifact_id=$3
         FOR UPDATE`,
        [input.shareId, owner.tenant, input.artifactId],
      );
      if (!share) throw missing();
      if (share.revision_id !== input.expectedRevisionId)
        await publishShareInTransaction(
          c,
          owner,
          input.shareId,
          {
            revisionId: input.expectedRevisionId,
            expectedPublishedRevisionId: share.revision_id,
          },
          notices,
        );
      const {
        rows: [moved],
      } = await c.query("SELECT * FROM shares WHERE id=$1", [input.shareId]);
      const result: AgentShareResult = {
        shareId: moved.id,
        artifactId: moved.artifact_id,
        revisionId: moved.revision_id,
        derivativeId: moved.derivative_id ?? null,
        expiresAt: new Date(moved.expires_at).toISOString(),
      };
      await c.query(
        `INSERT INTO agent_operations(
           id,tenant_id,account_id,connection_id,operation,idempotency_key,
           request,request_hash,result
         ) VALUES($1,$2,$3,$4,'share-move',$5,$6,$7,$8)`,
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
  throwIfBlocked(notices);
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
