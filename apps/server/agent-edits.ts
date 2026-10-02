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

// --- Changing the files of a work (docs/specs/AGENT_WORKSPACE.md) ----------
// `put` adds or replaces files, `remove` deletes them; every other file of
// the base version is copied inside the store (saveBundle with stored
// sources), so a project of any size changes without being sent again. The
// result is a new immutable version through the ordinary revise path: the same
// CAS on the latest version, the same idempotency by key, the same
// classification. A link does not move by itself.

const CHANGE_TITLE = "Files change";
const MAX_PUT_FILES = 64;

/** The mime a file gets from its extension: the same set the project CLI knows. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
};

export const agentChangeFilesObject = z
  .object({
    key: uuid,
    artifactId: uuid,
    baseRevisionId: uuid,
    put: z
      .array(
        z
          .object({
            path: z.string().min(1).max(200),
            encoding: z.enum(["utf8", "base64"]),
            data: z.string().max(7_000_000),
          })
          .strict(),
      )
      .max(MAX_PUT_FILES)
      .default([]),
    remove: z.array(z.string().min(1).max(200)).max(400).default([]),
  })
  .strict();
export const agentChangeFilesInputSchema = agentChangeFilesObject.refine(
  (value) => value.put.length + value.remove.length > 0,
  { message: "send at least one file in put or one path in remove" },
);
export type AgentChangeFilesInput = z.infer<typeof agentChangeFilesInputSchema>;

export async function changeFiles(actor: ServiceActor, raw: unknown) {
  const input = agentChangeFilesInputSchema.parse(raw);
  const base = await withServiceActorTransaction(actor, "revise", async (c, verified) => {
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
      if (!replay.rowCount) throw new BaseMismatch(artifact.latest_revision_id);
    }
    // Only a project (a folder of files): a page or a bundle changes through
    // polka_revise (a whole new version, or edits), which classifies the page again.
    if (revision.manifest?.runtime !== PROJECT_RUNTIME)
      throw new Problem(
        422,
        "unsupported",
        "polka_change_files меняет набор файлов работы-папки (проекта, runtime project-v1). Страницу или пакет сохраняйте через polka_revise: целиком или правками edits.",
      );
    return authorizedRevisionFiles(c, revision);
  });

  const stored = new Map(base.stored.map((file) => [file.path, file]));
  const lower = (value: string) => value.toLocaleLowerCase("en-US");
  const removed = new Set<string>();
  for (const path of input.remove) {
    if (!stored.has(path))
      throw new Problem(404, "not_found", `В версии нет файла ${JSON.stringify(path)}.`);
    if (path === base.manifest.entrypoint)
      throw new Problem(
        422,
        "invalid",
        `Файл ${JSON.stringify(path)} — точка входа работы: его нельзя удалить, замените его через put.`,
      );
    removed.add(path);
  }
  const put = new Map<string, { bytes: Buffer; mime: string }>();
  for (const file of input.put) {
    if (/^\/|\/$|\/\//.test(file.path))
      throw new Problem(400, "invalid", `Некорректный путь ${JSON.stringify(file.path)}: относительный, без пустых частей.`);
    // A file that exists keeps its type; a new one gets it from the extension.
    const existing = base.manifest.files.find((f) => f.path === file.path);
    const dot = file.path.lastIndexOf(".");
    const mime = existing?.mime ?? (dot > 0 ? MIME_BY_EXTENSION[file.path.slice(dot).toLowerCase()] : undefined);
    if (!mime)
      throw new Problem(
        422,
        "unsupported",
        `Тип файла ${JSON.stringify(file.path)} не определён по расширению. Поддерживаются: ${Object.keys(MIME_BY_EXTENSION).join(", ")}.`,
      );
    if (put.has(file.path) || removed.has(file.path))
      throw new Problem(400, "invalid", `Путь ${JSON.stringify(file.path)} указан дважды.`);
    const bytes =
      file.encoding === "base64" ? Buffer.from(file.data, "base64") : Buffer.from(file.data, "utf8");
    // As in polka_capture: what does not decode back is refused, not repaired silently.
    if (file.encoding === "utf8" && bytes.toString("utf8") !== file.data)
      throw new Problem(400, "invalid", `Некорректный UTF-8 в ${JSON.stringify(file.path)}.`);
    if (file.encoding === "base64" && bytes.toString("base64") !== file.data)
      throw new Problem(400, "invalid", `Некорректный base64 в ${JSON.stringify(file.path)} (без префикса data:, стандартный алфавит).`);
    put.set(file.path, { bytes, mime });
  }
  // The new set of files: kept from the store, replaced or added from `put`.
  const entries: { path: string; mime: string; size: number; sha256: string }[] = [];
  const source = new Map<string, Buffer | { objectKey: string; objectVersion: string }>();
  for (const file of base.manifest.files) {
    if (removed.has(file.path) || put.has(file.path)) continue;
    const kept = stored.get(file.path)!;
    entries.push({ path: file.path, mime: file.mime, size: file.size, sha256: file.sha256 });
    source.set(file.path, { objectKey: kept.objectKey, objectVersion: kept.objectVersion });
  }
  for (const [path, { bytes, mime }] of put) {
    entries.push({ path, mime, size: bytes.length, sha256: sha256(bytes) });
    source.set(path, bytes);
  }
  // A path that differs from another only in case collides in the manifest: say so plainly.
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const clash = seen.get(lower(entry.path));
    if (clash)
      throw new Problem(400, "invalid", `Путь ${JSON.stringify(entry.path)} совпадает с ${JSON.stringify(clash)} без учёта регистра.`);
    seen.set(lower(entry.path), entry.path);
  }
  let manifest: ReturnType<typeof canonicalizeManifest>;
  try {
    manifest = canonicalizeManifest({ ...base.manifest, files: entries });
  } catch (error) {
    // Say which rule failed: a model reading the reply can fix the path or the size.
    if (error instanceof z.ZodError)
      throw new Problem(
        400,
        "invalid",
        `Набор файлов не принят: ${error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
          .join("; ")}.`,
      );
    throw error;
  }
  return saved(actor, input as unknown as AgentEditsInput, () =>
    saveBundle(
      actor,
      "revise",
      {
        key: input.key,
        title: CHANGE_TITLE,
        artifactId: input.artifactId,
        baseRevisionId: input.baseRevisionId,
      },
      manifest,
      source,
    ),
  );
}

