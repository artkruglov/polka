// Projects over the HTTP API (docs/specs/PROJECTS.md): an agent with a
// folder (Claude Code, Codex, a script) begins an upload with the manifest,
// sends each file, then finalizes. The same bundle functions as a browser
// upload, each step in its own transaction that rechecks the connection and
// its scope: capture for a new work, revise for a new version.
import { z } from "zod";
import type { PoolClient } from "pg";
import {
  PROJECT_RUNTIME,
  canonicalizeManifest,
} from "../../packages/contracts/bundle.ts";
import { MAX_TITLE, uuid } from "../../packages/contracts/index.ts";
import {
  beginBundleUploadInTransaction,
  finalizeBundleUploadInTransaction,
  normalizeBundleRequest,
  uploadBundleFileInTransaction,
  type Actor,
} from "./artifacts.ts";
import { Problem, missing } from "./errors.ts";
import {
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";

export const beginProjectSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(MAX_TITLE),
    manifest: z.unknown(),
    folderId: uuid.nullable().optional(),
    artifactId: uuid.optional(),
    baseRevisionId: uuid.optional(),
  })
  .strict()
  .refine(
    (value) => !!value.artifactId === !!value.baseRevisionId,
    "A new version needs artifactId and baseRevisionId together",
  );

const owner = (actor: ServiceActor): Actor => ({
  id: actor.accountId,
  tenant: actor.tenantId,
  connectionId: actor.connectionId,
});

export async function beginProjectUpload(actor: ServiceActor, body: unknown) {
  const input = beginProjectSchema.parse(body);
  const manifest = canonicalizeManifest(input.manifest);
  if (manifest.runtime !== PROJECT_RUNTIME)
    throw new Problem(422, "invalid", `manifest.runtime must be ${PROJECT_RUNTIME}`);
  const mode = input.artifactId ? "revise" : "capture";
  return withServiceActorTransaction(actor, mode, async (c, verified) => {
    const who = owner(verified);
    const old = (
      await c.query(
        "SELECT connection_id FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2",
        [who.tenant, input.key],
      )
    ).rows[0];
    if (old && old.connection_id !== (who.connectionId ?? null))
      throw new Problem(409, "conflict", "Ключ уже относится к другой операции.");
    const result = await beginBundleUploadInTransaction(
      c,
      who,
      normalizeBundleRequest({
        key: input.key,
        title: input.title,
        manifest,
        ...(input.folderId ? { folderId: input.folderId } : {}),
        ...(input.artifactId
          ? { artifactId: input.artifactId, baseRevisionId: input.baseRevisionId }
          : {}),
      }),
    );
    await c.query(
      "UPDATE uploads SET connection_id=$2 WHERE id=$1 AND tenant_id=$3",
      [result.uploadId, who.connectionId ?? null, who.tenant],
    );
    return {
      uploadId: result.uploadId,
      receipt: result.receipt,
      files: result.manifest.files.map((file, index) => ({ index, path: file.path })),
    };
  });
}

/** The upload of this connection, locked, and the scope its operation needs. */
async function lockProjectUpload(c: PoolClient, who: Actor, uploadId: string) {
  const row = (
    await c.query(
      `SELECT request FROM uploads
       WHERE id=$1 AND tenant_id=$2 AND kind='bundle'
         AND connection_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
      [uploadId, who.tenant, who.connectionId ?? null],
    )
  ).rows[0];
  if (!row || row.request?.manifest?.runtime !== PROJECT_RUNTIME) throw missing();
  return row.request as { artifactId?: string };
}

const scopeOf = async (actor: ServiceActor, uploadId: string) =>
  withServiceActorTransaction(actor, "capture", async (c, verified) =>
    (await lockProjectUpload(c, owner(verified), uploadId)).artifactId
      ? ("revise" as const)
      : ("capture" as const),
  ).catch(async (error) => {
    // A revise-only connection may still send files of its new version.
    if (error instanceof Problem && error.status === 403)
      return withServiceActorTransaction(actor, "revise", async (c, verified) => {
        const request = await lockProjectUpload(c, owner(verified), uploadId);
        if (!request.artifactId) throw error;
        return "revise" as const;
      });
    throw error;
  });

export async function putProjectFile(
  actor: ServiceActor,
  uploadId: string,
  index: number,
  bytes: Buffer,
) {
  const scope = await scopeOf(actor, uploadId);
  return withServiceActorTransaction(actor, scope, async (c, verified) => {
    const who = owner(verified);
    await lockProjectUpload(c, who, uploadId);
    return uploadBundleFileInTransaction(c, who, uploadId, index, bytes);
  });
}

export async function finalizeProjectUpload(actor: ServiceActor, uploadId: string) {
  const scope = await scopeOf(actor, uploadId);
  return withServiceActorTransaction(actor, scope, async (c, verified) => {
    const who = owner(verified);
    await lockProjectUpload(c, who, uploadId);
    return finalizeBundleUploadInTransaction(c, who, uploadId);
  });
}
