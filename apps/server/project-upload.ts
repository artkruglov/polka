// Projects over the HTTP API (docs/specs/PROJECTS.md): an agent with a
// folder (Claude Code, Codex, a script) begins an upload with the manifest,
// sends each file, then finalizes. The same bundle functions as a browser
// upload, each step in its own transaction that rechecks the connection and
// its scope: capture for a new work, revise for a new version.
import { randomBytes, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { PoolClient } from "pg";
import { PROJECT_RUNTIME, canonicalizeManifest } from "../../packages/contracts/bundle.ts";
import { MAX_TITLE, uuid } from "../../packages/contracts/index.ts";
import {
  authorizedRevisionFiles,
  beginBundleUploadInTransaction,
  finalizeBundleUploadInTransaction,
  normalizeBundleRequest,
  prepareBundleFinalize,
  stageBundleFile,
  stageBundleFileCopy,
  stageBundleMedia,
  uploadBundleFileInTransaction,
  type Actor,
} from "./artifacts.ts";
import { Problem, missing } from "./errors.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import {
  MCP_AUDIENCE,
  PROJECT_UPLOAD_AUDIENCE,
  withServiceActorDerivedScopeTransaction,
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";
import { sha256 } from "./storage.ts";

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
      await c.query("SELECT connection_id FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2", [
        who.tenant,
        input.key,
      ])
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
        ...(input.artifactId ? { artifactId: input.artifactId, baseRevisionId: input.baseRevisionId } : {}),
      }),
    );
    await c.query("UPDATE uploads SET connection_id=$2 WHERE id=$1 AND tenant_id=$3", [
      result.uploadId,
      who.connectionId ?? null,
      who.tenant,
    ]);
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
    (await lockProjectUpload(c, owner(verified), uploadId)).artifactId ? ("revise" as const) : ("capture" as const),
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

export async function putProjectFile(actor: ServiceActor, uploadId: string, index: number, bytes: Buffer) {
  const scope = await scopeOf(actor, uploadId);
  // Stored before the transaction (artifacts.ts, stageBundleFile); the
  // transaction rechecks the connection and records it.
  const staged = await stageBundleFile(owner(actor), uploadId, index, bytes);
  return withServiceActorTransaction(actor, scope, async (c, verified) => {
    const who = owner(verified);
    await lockProjectUpload(c, who, uploadId);
    return uploadBundleFileInTransaction(c, who, uploadId, index, bytes, staged);
  });
}

/**
 * A video file (docs/specs/PROJECT_VIDEO.md): streamed to the store as it
 * arrives, checked against its manifest entry on the way, then recorded like
 * any other file.
 */
export async function putProjectMedia(actor: ServiceActor, uploadId: string, index: number, body: Readable) {
  const scope = await scopeOf(actor, uploadId);
  const staged = await stageBundleMedia(owner(actor), uploadId, index, body, () => body.resume());
  return withServiceActorTransaction(actor, scope, async (c, verified) => {
    const who = owner(verified);
    await lockProjectUpload(c, who, uploadId);
    return uploadBundleFileInTransaction(c, who, uploadId, index, null, staged);
  });
}

/**
 * A new version of a project sends only what changed (polka push): every
 * file whose path, type and SHA-256 are those of a file in the base
 * version is copied inside S3 instead of being sent. Returns the indexes
 * now stored; the CLI sends the rest. Safe to repeat.
 */
export async function reuseProjectFiles(actor: ServiceActor, uploadId: string) {
  const scope = await scopeOf(actor, uploadId);
  if (scope !== "revise") return { reused: [] as number[] };
  const plan = await withServiceActorTransaction(actor, scope, async (c, verified) => {
    const who = owner(verified);
    await lockProjectUpload(c, who, uploadId);
    const {
      rows: [upload],
    } = await c.query("SELECT request FROM uploads WHERE id=$1", [uploadId]);
    const request = normalizeBundleRequest(upload.request, true);
    const {
      rows: [revision],
    } = await c.query("SELECT * FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3", [
      request.baseRevisionId,
      request.artifactId,
      who.tenant,
    ]);
    if (!revision?.manifest) return [];
    const base = new Map((await authorizedRevisionFiles(c, revision)).stored.map((file) => [file.path, file]));
    return request.manifest.files.flatMap((file, index) => {
      const same = base.get(file.path);
      return same && same.sha256 === file.sha256 && same.mime === file.mime && same.size === file.size
        ? [{ index, objectKey: same.objectKey, objectVersion: same.objectVersion }]
        : [];
    });
  });
  const copied: Array<{ index: number; staged: string }> = [];
  for (const { index, ...from } of plan) {
    const staged = await stageBundleFileCopy(owner(actor), uploadId, index, from);
    if (staged) copied.push({ index, staged });
  }
  if (copied.length)
    await withServiceActorTransaction(actor, scope, async (c, verified) => {
      const who = owner(verified);
      await lockProjectUpload(c, who, uploadId);
      for (const { index, staged } of copied)
        await uploadBundleFileInTransaction(c, who, uploadId, index, null, staged);
    });
  return { reused: plan.map(({ index }) => index) };
}

export async function finalizeProjectUpload(actor: ServiceActor, uploadId: string) {
  const scope = await scopeOf(actor, uploadId);
  const prepared = await prepareBundleFinalize(owner(actor), uploadId);
  return withServiceActorTransaction(actor, scope, async (c, verified) => {
    const who = owner(verified);
    await lockProjectUpload(c, who, uploadId);
    return finalizeBundleUploadInTransaction(c, who, uploadId, prepared);
  });
}

export const PROJECT_TOKEN_MINUTES = 30;
const PROJECT_TOKENS_PER_HOUR = 10;

/**
 * polka_project_upload: a token for the CLIs (scripts/polka-publish-project.mjs
 * for a folder, scripts/polka-publish.mjs for one page or React component)
 * that an agent asks for over MCP, so the person copies nothing and the agent
 * never pastes a file into a tool argument. It is a child of the asking
 * connection: the same shelf and account, only its capture/revise/share
 * scopes, the project and publish routes only (PROJECT_UPLOAD_AUDIENCE),
 * 30 minutes, and it stops when its parent is revoked.
 */
export async function issueProjectUploadToken(actor: ServiceActor) {
  await limitAttempts(`project-upload-token:${actor.connectionId}`, PROJECT_TOKENS_PER_HOUR, "1 hour");
  const token = randomBytes(32).toString("base64url");
  const row = await withServiceActorDerivedScopeTransaction(
    actor,
    async (_c, verified) => ({
      scope: verified.scopes.includes("capture") ? ("capture" as const) : ("revise" as const),
      value: null,
    }),
    async (c, verified) => {
      if (verified.shelf?.role === "reader")
        throw new Problem(403, "forbidden", "На этой полке вы читатель: загружать проекты нельзя.");
      if (verified.audience !== MCP_AUDIENCE)
        throw new Problem(403, "forbidden", "Этот токен сам выдан для загрузки проекта.");
      // source:read, when the connection has it, lets the CLI pull a
      // version into a folder before pushing the next one.
      const scopes = verified.scopes.filter(
        (scope) => scope === "capture" || scope === "revise" || scope === "share" || scope === "source:read",
      );
      const {
        rows: [inserted],
      } = await c.query(
        `INSERT INTO agent_connections(
           id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,parent_id,
           principal_type,service_principal_id
         ) SELECT $1,$2,$3,$4,left('Загрузка проекта · '||parent.name,80),$5,$6,
                  now()+make_interval(mins=>$7),parent.id,
                  parent.principal_type,parent.service_principal_id
           FROM agent_connections parent WHERE parent.id=$8 AND parent.parent_id IS NULL
         RETURNING expires_at`,
        [
          randomUUID(),
          verified.tenantId,
          verified.accountId,
          sha256(token),
          scopes,
          PROJECT_UPLOAD_AUDIENCE,
          PROJECT_TOKEN_MINUTES,
          verified.connectionId,
        ],
      );
      // A task token (a child itself) cannot ask for another child.
      if (!inserted)
        throw new Problem(
          403,
          "forbidden",
          "Этот токен сам выдан для задачи: загрузку проекта запрашивает исходное подключение.",
        );
      return { ...inserted, canPull: scopes.includes("source:read") };
    },
  );
  const cli = `${config.APP_ORIGIN}/api/v1/cli/polka-publish-project.mjs`;
  const pullCli = `${config.APP_ORIGIN}/api/v1/cli/polka-pull.mjs`;
  const pageCli = `${config.APP_ORIGIN}/api/v1/cli/polka-publish.mjs`;
  return {
    token,
    expiresAt: new Date(row.expires_at).toISOString(),
    cliUrl: cli,
    command: `curl -fsSLO ${cli} && POLKA_TOKEN=${token} node polka-publish-project.mjs <folder> --dry-run`,
    pageCliUrl: pageCli,
    pageCommand: `curl -fsSLO ${pageCli} && POLKA_TOKEN=${token} node polka-publish.mjs <App.jsx|page.html> --title "<title>"`,
    ...(row.canPull
      ? {
          pullCliUrl: pullCli,
          pullCommand: `curl -fsSLO ${pullCli} && POLKA_TOKEN=${token} node polka-pull.mjs <artifactId> <folder>`,
        }
      : {}),
    note: `The token works only for uploads (a project, or one page or React component)${row.canPull ? " and for downloading a saved version into a folder (polka-pull.mjs, which also records the version so the next polka-publish-project.mjs of that folder saves a new version and sends only changed files)" : ""}, for ${PROJECT_TOKEN_MINUTES} minutes, and only while this connection is live. Pass it in the environment of that one command; never write it to a file, a commit or a message. A project takes no .jsx/.tsx files, but its HTML pages may load React, Babel or Tailwind from a CDN or use module scripts: Полка compiles those pages offline and lists any it could not in pagesNotBuilt. A folder whose only page is one React component is saved as that component and runs, and so does a component sent through polka-publish.mjs.`,
  };
}
