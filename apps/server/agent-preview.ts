import type { PoolClient } from "pg";
import { z } from "zod";
import {
  uuid,
  type AgentScope,
  type InlineBuildStatus,
} from "../../packages/contracts/index.ts";
import {
  buildInlineRevisionWithRunner,
  type DerivativeTransactionRunner,
} from "./bundle-derivatives.ts";
import {
  derivativePreferenceSql,
  derivativeVersionSql,
} from "./bundle-runtime-contract.ts";
import { config } from "./config.ts";
import { missing } from "./errors.ts";
import {
  withServiceActorDerivedScopeTransaction,
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";

export const agentPreviewInputSchema = z
  .object({ uploadId: uuid.optional(), key: uuid.optional() })
  .strict()
  .refine((value) => !!value.uploadId !== !!value.key, {
    message: "Provide exactly one of uploadId or key",
  });

type ResolvedUpload = {
  uploadId: string;
  revisionId: string;
  scope: Extract<AgentScope, "capture" | "revise">;
};

function scopeForRequest(request: any): ResolvedUpload["scope"] {
  return request?.artifactId ? "revise" : "capture";
}

async function findFinalizedUpload(
  c: PoolClient,
  actor: ServiceActor,
  input: z.infer<typeof agentPreviewInputSchema>,
  lock: boolean,
) {
  const {
    rows: [upload],
  } = await c.query(
    `SELECT id,kind,request,receipt
     FROM uploads
     WHERE tenant_id=$1 AND account_id=$2 AND connection_id=$3
       AND ($4::uuid IS NULL OR id=$4)
       AND ($5::uuid IS NULL OR idempotency_key=$5)
     ${lock ? "FOR UPDATE" : ""}`,
    [
      actor.tenantId,
      actor.accountId,
      actor.connectionId,
      input.uploadId ?? null,
      input.key ?? null,
    ],
  );
  if (!upload || upload.kind !== "bundle" || !upload.receipt) throw missing();
  const revisionId = uuid.parse(upload.receipt.revisionId);
  return {
    uploadId: upload.id as string,
    revisionId,
    scope: scopeForRequest(upload.request),
  } satisfies ResolvedUpload;
}

async function resolveUpload(
  actor: ServiceActor,
  input: z.infer<typeof agentPreviewInputSchema>,
) {
  return withServiceActorDerivedScopeTransaction(
    actor,
    async (c, verified) => {
      const value = await findFinalizedUpload(c, verified, input, true);
      return { scope: value.scope, value };
    },
    async (_c, _verified, value) => value,
  );
}

function transactionRunner(
  actor: ServiceActor,
  resolved: ResolvedUpload,
): DerivativeTransactionRunner {
  return (operation) =>
    withServiceActorTransaction(actor, resolved.scope, async (c, verified) => {
      const current = await findFinalizedUpload(
        c,
        verified,
        { uploadId: resolved.uploadId },
        false,
      );
      if (
        current.revisionId !== resolved.revisionId ||
        current.scope !== resolved.scope
      )
        throw missing();
      return operation(c);
    });
}

export async function previewStatusInTransaction(
  c: PoolClient,
  tenantId: string,
  revisionId: string,
): Promise<InlineBuildStatus | null> {
  if (!config.HTML_LIVE_ENABLED) return null;
  const {
    rows: [row],
  } = await c.query(
    `SELECT derivative.state,derivative.runtime_profile,derivative.reason,
            derivative.error_path
     FROM revisions revision
     JOIN artifacts artifact ON artifact.id=revision.artifact_id
     LEFT JOIN LATERAL (
       SELECT * FROM revision_derivatives d
       WHERE d.revision_id=revision.id
         AND d.source_manifest_sha256=revision.manifest_sha256
         AND ${derivativeVersionSql("d")}
       ORDER BY ${derivativePreferenceSql("d")}
       LIMIT 1
     ) derivative ON true
     WHERE revision.id=$1 AND revision.tenant_id=$2
       AND revision.storage_kind='bundle' AND artifact.trashed_at IS NULL`,
    [revisionId, tenantId],
  );
  if (!row?.state) return null;
  return {
    state: row.state,
    runtimeProfile: row.runtime_profile ?? null,
    reason: row.reason ?? null,
    path: row.error_path ?? null,
  };
}

export async function preparePreviewFromAgent(
  actor: ServiceActor,
  body: unknown,
) {
  if (!config.HTML_LIVE_ENABLED) throw missing();
  const input = agentPreviewInputSchema.parse(body);
  const resolved = await resolveUpload(actor, input);
  const built = await buildInlineRevisionWithRunner(
    {
      id: actor.accountId,
      tenant: actor.tenantId,
      connectionId: actor.connectionId,
    },
    resolved.revisionId,
    transactionRunner(actor, resolved),
  );
  return {
    uploadId: resolved.uploadId,
    revisionId: resolved.revisionId,
    concurrent: built.concurrent,
    ...built.status,
  };
}
