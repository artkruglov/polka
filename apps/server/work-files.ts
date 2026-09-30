// A saved version's files for an agent's CLI (docs/PUBLISH_API.md, «polka
// pull»): the list, then each file's bytes, so a folder can be written back
// to disk, changed and pushed as the next version. The same scope and checks
// as polka_read_source (source:read, the agent's folders), without base64 in
// one response: a project may be 48 MiB.
import type { PoolClient } from "pg";
import { assertArtifactInAgentScope } from "./agent-scope.ts";
import { authorizedRevisionFiles } from "./artifacts.ts";
import { missing } from "./errors.ts";
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
  let files: StoredFile[];
  let entrypoint: string;
  let runtime: string | null;
  if (revision.manifest) {
    const { manifest, stored } = await authorizedRevisionFiles(c, revision);
    files = stored;
    entrypoint = manifest.entrypoint;
    runtime = manifest.runtime;
  } else {
    // A single file without a manifest: an image, a text, a document.
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
  return { artifact, revision, files, entrypoint, runtime };
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
  // A video is streamed, never held whole; its size and SHA-256 were checked
  // against the store's record when it was saved (the CLI checks it again).
  if (isVideoMime(file.mime))
    return { ...file, stream: await readStream(file.objectKey, file.objectVersion) };
  const bytes = await readBlob(file.objectKey, file.objectVersion);
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
    throw new Error("Revision file checksum mismatch");
  return { ...file, bytes };
}
