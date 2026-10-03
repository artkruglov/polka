// A saved version's files for an agent's CLI (docs/PUBLISH_API.md, «polka
// pull»): the list, then each file's bytes, so a folder can be written back
// to disk, changed and pushed as the next version. The same scope and checks
// as polka_read_source (source:read, the agent's folders), without base64 in
// one response: a project may be 48 MiB.
import type { PoolClient } from "pg";
import { assertArtifactInAgentScope } from "./agent-scope.ts";
import { authorizedRevisionFiles } from "./artifacts.ts";
import { Problem, missing } from "./errors.ts";
import { isVideoMime } from "../../packages/contracts/constants.ts";
import { readBlob, readStream, sha256 } from "./storage.ts";
import { withServiceActorTransaction, type ServiceActor } from "./service-auth.ts";

type StoredFile = {
  path: string;
  mime: string;
  size: number;
  sha256: string;
  objectKey: string;
  objectVersion: string;
};

/** The work, the version (the latest by default) and where its files are. */
async function locate(
  c: PoolClient,
  actor: ServiceActor,
  artifactId: string,
  revisionId?: string,
) {
  await assertArtifactInAgentScope(
    c,
    { id: actor.accountId, tenant: actor.tenantId, connectionId: actor.connectionId },
    artifactId,
  );
  const {
    rows: [artifact],
  } = await c.query(
    "SELECT id,title,latest_revision_id FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL",
    [artifactId, actor.tenantId],
  );
  if (!artifact) throw missing();
  const {
    rows: [revision],
  } = await c.query(
    "SELECT * FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3",
    [revisionId ?? artifact.latest_revision_id, artifactId, actor.tenantId],
  );
  if (!revision) throw missing();
  return { artifact, revision, ...(await storedRevisionFiles(c, revision)) };
}

/**
 * Where a saved version's files are, without reading them: a manifest's
 * files, or the one file of a version without a manifest (an image, a text,
 * a document). Also used by the shelf export (shelf-export.ts).
 */
export async function storedRevisionFiles(c: Pick<PoolClient, "query">, revision: any) {
  let files: StoredFile[];
  let entrypoint: string;
  let runtime: string | null;
  if (revision.manifest) {
    const { manifest, stored } = await authorizedRevisionFiles(c, revision);
    files = stored;
    entrypoint = manifest.entrypoint;
    runtime = manifest.runtime;
  } else {
    files = [
      {
        path: revision.filename,
        mime: revision.mime,
        size: Number(revision.size),
        sha256: revision.sha256,
        objectKey: revision.object_key,
        objectVersion: revision.object_version,
      },
    ];
    entrypoint = revision.filename;
    runtime = null;
  }
  return { files, entrypoint, runtime };
}

export function workFilesForAgent(
  actor: ServiceActor,
  artifactId: string,
  revisionId?: string,
) {
  return withServiceActorTransaction(actor, "source:read", async (c, verified) => {
    const { artifact, revision, files, entrypoint, runtime } = await locate(
      c,
      verified,
      artifactId,
      revisionId,
    );
    return {
      artifactId,
      title: artifact.title as string,
      revisionId: revision.id as string,
      number: revision.number as number,
      latestRevisionId: artifact.latest_revision_id as string,
      runtime,
      entrypoint,
      files: files.map(({ path, mime, size, sha256 }, index) => ({
        index,
        path,
        mime,
        size,
        sha256,
      })),
    };
  });
}

/** One file's bytes, checked against the version's record of it. */
export async function workFileForAgent(
  actor: ServiceActor,
  artifactId: string,
  revisionId: string,
  index: number,
) {
  const file = await withServiceActorTransaction(
    actor,
    "source:read",
    async (c, verified) => (await locate(c, verified, artifactId, revisionId)).files[index],
  );
  if (!file) throw missing();
  return readStoredFile(file);
}

/** A stored file's bytes, checked against the version's record of it. */
export async function readStoredFile(file: StoredFile) {
  // A video is streamed, never held whole; its size and SHA-256 were checked
  // against the store's record when it was saved (the CLI checks it again).
  if (isVideoMime(file.mime))
    return { ...file, stream: await readStream(file.objectKey, file.objectVersion) };
  const bytes = await readBlob(file.objectKey, file.objectVersion);
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
    throw new Error("Revision file checksum mismatch");
  return { ...file, bytes };
}

/** The largest file read through a chat tool in one call; bigger ones go through the CLI or HTTP. */
export const READ_FILE_MAX_BYTES = 256 * 1024;

const TEXT_FILE_MIMES = new Set([
  "text/html",
  "text/markdown",
  "text/plain",
  "text/css",
  "text/javascript",
  "application/json",
  "image/svg+xml",
]);

/**
 * One file of a version by its path (the latest version by default): text as
 * UTF-8, anything else as base64, at most READ_FILE_MAX_BYTES (the MCP reply
 * must stay small). The file is checked against the version's record of it.
 */
export async function readWorkFileByPath(
  actor: ServiceActor,
  artifactId: string,
  path: string,
  revisionId?: string,
) {
  const listing = await workFilesForAgent(actor, artifactId, revisionId);
  const entry = listing.files.find((file) => file.path === path);
  if (!entry)
    throw new Problem(404, "not_found", `В версии нет файла ${JSON.stringify(path)}.`);
  if (isVideoMime(entry.mime))
    throw new Problem(
      422,
      "unsupported",
      "Видео не читается через чат: скачайте его через polka pull или HTTP API.",
    );
  if (entry.size > READ_FILE_MAX_BYTES)
    throw new Problem(
      413,
      "quota",
      `Файл ${entry.size} байт, через чат читается не больше ${READ_FILE_MAX_BYTES}. Скачайте его через polka pull или GET /api/v1/works/:id/revisions/:rev/files/:index.`,
    );
  const file = await workFileForAgent(actor, artifactId, listing.revisionId, entry.index);
  if (!("bytes" in file))
    throw new Problem(422, "unsupported", "Файл нельзя прочитать целиком через чат.");
  let encoding: "utf8" | "base64" = "base64";
  let data = file.bytes.toString("base64");
  if (TEXT_FILE_MIMES.has(file.mime)) {
    try {
      data = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      encoding = "utf8";
    } catch {
      // not UTF-8: sent as base64
    }
  }
  return {
    artifactId,
    revisionId: listing.revisionId,
    number: listing.number,
    path: file.path,
    mime: file.mime,
    size: file.size,
    sha256: file.sha256,
    encoding,
    data,
  };
}
