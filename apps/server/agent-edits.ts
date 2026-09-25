import { PROJECT_RUNTIME } from "../../packages/contracts/bundle.ts";
// Patch edits of a saved work (docs/specs/COMMENTS.md, «Агенты»): an agent
// sends `edits: [{oldText, newText}]` against `baseRevisionId` instead of the
// whole file. The server applies them to the base version's text file
// (edit-patch.ts) and saves the result through the ordinary revise path
// (captureFromAgent): the same CAS on the latest version, the same
// idempotency by key, the same classification and phishing signals of the
// new revision. Nothing else of the base version changes.
import { createHash } from "node:crypto";
import { z } from "zod";
import { editsSchema } from "../../packages/contracts/comments.ts";
import { uuid } from "../../packages/contracts/index.ts";
import { captureFromAgent } from "./agent-capture.ts";
import { readAuthorizedRevisionSource } from "./artifacts.ts";
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
  const prepared = await withServiceActorTransaction(
    actor,
    "revise",
    async (c, verified) => {
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
      // A project is saved whole (docs/specs/PROJECTS.md): a new version
      // goes through POST /api/v1/projects or its CLI, not a patch.
      if (revision.manifest?.runtime === PROJECT_RUNTIME)
        throw new Problem(
          422,
          "unsupported",
          "Это проект из многих файлов: правка патчем для него пока не поддерживается. Загрузите новую версию проекта целиком (polka-publish-project.mjs с --artifact и --base-revision).",
        );
      if (artifact.latest_revision_id !== input.baseRevisionId) {
        const replay = await c.query(
          `SELECT 1 FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2
             AND connection_id=$3 AND receipt IS NOT NULL`,
          [verified.tenantId, input.key, verified.connectionId],
        );
        if (!replay.rowCount)
          throw new BaseMismatch(artifact.latest_revision_id);
      }
      return readAuthorizedRevisionSource(c, revision);
    },
  );
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
  try {
    return (await captureFromAgent(
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
    )) as {
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
