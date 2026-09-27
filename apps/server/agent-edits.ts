import { assertArtifactInAgentScope } from "./agent-scope.ts";
import { PROJECT_RUNTIME, canonicalizeManifest } from "../../packages/contracts/bundle.ts";
// Patch edits of a saved work (docs/specs/COMMENTS.md, «Агенты»): an agent
// sends `edits: [{oldText, newText}]` against `baseRevisionId` instead of the
// whole file. The server applies them to the base version's text file
// (edit-patch.ts) and saves the result through the ordinary revise path
// (captureFromAgent): the same CAS on the latest version, the same
// idempotency by key, the same classification and phishing signals of the
// new revision. Nothing else of the base version changes. In a project the
// other files are not read at all: S3 copies them (saveBundle), so a patch
// works for a project of any size (docs/specs/PROJECTS.md).
import { createHash } from "node:crypto";
import { z } from "zod";
import { editsSchema } from "../../packages/contracts/comments.ts";
import { uuid } from "../../packages/contracts/index.ts";
import { captureFromAgent, saveBundle } from "./agent-capture.ts";
import { authorizedRevisionFiles, readAuthorizedRevisionSource } from "./artifacts.ts";
import { readBlob, sha256 } from "./storage.ts";
import { db } from "./db.ts";
import { applyEdits } from "./edit-patch.ts";
import { Problem, missing } from "./errors.ts";
import {
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";

export const agentEditsInputSchema = z
  .object({
    key: uuid,
    artifactId: uuid,
    baseRevisionId: uuid,
    edits: editsSchema,
    /** The file to edit; the entrypoint (the HTML page) by default. */
    path: z.string().min(1).max(200).optional(),
  })
  .strict();
export type AgentEditsInput = z.infer<typeof agentEditsInputSchema>;

const TEXT_MIMES = new Set([
  "text/html",
  "text/markdown",
  "text/plain",
  "text/css",
  "text/javascript",
  "application/json",
  "image/svg+xml",
]);

// Revise requests carry a title for the upload record only; it never renames
// the work. A fixed one keeps a retry's request identical.
const PATCH_TITLE = "Patch edit";

/** The version a patch was written against moved on: 409 naming the latest. */
export class BaseMismatch extends Problem {
  constructor(currentRevisionId: string) {
    super(
      409,
      "conflict",
      `Правки написаны к другой версии. Текущая версия: ${currentRevisionId}. Прочитайте её и пришлите правки заново.`,
      { currentRevisionId },
    );
  }
}

export async function reviseWithEdits(actor: ServiceActor, raw: unknown) {
  const input = agentEditsInputSchema.parse(raw);
  // The base version, read under the connection's own checks. A replay of a
  // saved key is recognized by captureFromAgent even after the work moved on.
  const base = await withServiceActorTransaction(
    actor,
    "revise",
    async (c, verified) => {
      // An agent limited to folders revises only works in them (agent-scope.ts).
      await assertArtifactInAgentScope(
        c,
        { id: verified.accountId, tenant: verified.tenantId, connectionId: verified.connectionId },
        input.artifactId,
      );
      const {
        rows: [artifact],
      } = await c.query(
        `SELECT latest_revision_id FROM artifacts
         WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR SHARE`,
        [input.artifactId, verified.tenantId],
      );
      if (!artifact) throw missing();
      const {
        rows: [revision],
      } = await c.query(
        "SELECT * FROM revisions WHERE id=$1 AND artifact_id=$2 AND tenant_id=$3",
        [input.baseRevisionId, input.artifactId, verified.tenantId],
      );
      if (!revision) throw missing();
      if (artifact.latest_revision_id !== input.baseRevisionId) {
        const replay = await c.query(
          `SELECT 1 FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2
             AND connection_id=$3 AND receipt IS NOT NULL`,
          [verified.tenantId, input.key, verified.connectionId],
        );
        if (!replay.rowCount)
          throw new BaseMismatch(artifact.latest_revision_id);
      }
      // A project's files are only located here; one of them is read below.
      return revision.manifest?.runtime === PROJECT_RUNTIME
        ? { project: await authorizedRevisionFiles(c, revision) }
        : { bundle: await readAuthorizedRevisionSource(c, revision) };
    },
  );
  if (base.project) return reviseProjectFile(actor, input, base.project);
  const prepared = base.bundle!;
  const path = input.path ?? prepared.manifest.entrypoint;
  const target = prepared.files.find((file) => file.path === path);
  if (!target)
    throw new Problem(
      404,
      "not_found",
      `В версии нет файла ${JSON.stringify(path)}.`,
    );
  if (!TEXT_MIMES.has(target.mime))
    throw new Problem(
      422,
      "unsupported",
      "Патчем правится только текстовый файл (HTML, CSS, JavaScript, JSON, SVG, текст).",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(target.bytes);
  } catch {
    throw new Problem(422, "unsupported", "Файл не в UTF-8: патч не применить.");
  }
  const bytes = Buffer.from(applyEdits(text, input.edits), "utf8");
  const manifest = {
    ...prepared.manifest,
    files: prepared.manifest.files.map((file) =>
      file.path === path
        ? {
            ...file,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }
        : file,
    ),
  };
  const files = prepared.files.map((file) => {
    const data = file.path === path ? bytes : file.bytes;
    return TEXT_MIMES.has(file.mime) && isUtf8(data)
      ? { path: file.path, encoding: "utf8" as const, data: data.toString("utf8") }
      : { path: file.path, encoding: "base64" as const, data: data.toString("base64") };
  });
  return saved(actor, input, () =>
    captureFromAgent(
      actor,
      {
        key: input.key,
        title: PATCH_TITLE,
        artifactId: input.artifactId,
        baseRevisionId: input.baseRevisionId,
        manifest,
        files,
      },
      "revise",
    ),
  );
}

/** Edits one text file of a project; S3 copies the others. */
async function reviseProjectFile(
  actor: ServiceActor,
  input: AgentEditsInput,
  base: Awaited<ReturnType<typeof authorizedRevisionFiles>>,
) {
  const path = input.path ?? base.manifest.entrypoint;
  const target = base.stored.find((file) => file.path === path);
  if (!target)
    throw new Problem(404, "not_found", `В проекте нет файла ${JSON.stringify(path)}.`);
  if (!TEXT_MIMES.has(target.mime))
    throw new Problem(
      422,
      "unsupported",
      "Патчем правится только текстовый файл (Markdown, HTML, CSS, JavaScript, JSON, SVG, текст). Картинку или новый файл добавьте новой версией проекта целиком.",
    );
  const original = await readBlob(target.objectKey, target.objectVersion);
  if (original.length !== target.size || sha256(original) !== target.sha256)
    throw new Error("Revision file checksum mismatch");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(original);
  } catch {
    throw new Problem(422, "unsupported", "Файл не в UTF-8: патч не применить.");
  }
  const bytes = Buffer.from(applyEdits(text, input.edits), "utf8");
  const manifest = canonicalizeManifest({
    ...base.manifest,
    files: base.manifest.files.map((file) =>
      file.path === path ? { ...file, size: bytes.length, sha256: sha256(bytes) } : file,
    ),
  });
  const source = new Map(
    base.stored.map(({ path: filePath, objectKey, objectVersion }) => [
      filePath,
      filePath === path ? bytes : { objectKey, objectVersion },
    ]),
  );
  return saved(actor, input, () =>
    saveBundle(
      actor,
      "revise",
      {
        key: input.key,
        title: PATCH_TITLE,
        artifactId: input.artifactId,
        baseRevisionId: input.baseRevisionId,
      },
      manifest,
      source,
    ),
  );
}

/** The save of a patched version; a version that landed meanwhile is a BaseMismatch. */
async function saved(
  actor: ServiceActor,
  input: AgentEditsInput,
  save: () => Promise<unknown>,
) {
  try {
    return (await save()) as {
      uploadId: string;
      artifactId: string;
      revisionId: string;
      number: number;
      htmlProfile?: string | null;
    };
  } catch (error) {
    // Another version landed between the read and the save (a key used for
    // another request stays that conflict).
    if (error instanceof Problem && error.status === 409) {
      const {
        rows: [state],
      } = await db.query(
        "SELECT latest_revision_id FROM artifacts WHERE id=$1 AND tenant_id=$2",
        [input.artifactId, actor.tenantId],
      );
      // The key refusals of the upload path name the key; they stay as is.
      if (
        state &&
        state.latest_revision_id !== input.baseRevisionId &&
        !/ключ/i.test(error.message)
      )
        throw new BaseMismatch(state.latest_revision_id);
    }
    throw error;
  }
}

function isUtf8(bytes: Buffer) {
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}
