import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LINK_MIME,
  artifactLifecycleSchema,
  updateArtifactMetadataFields,
  updateArtifactMetadataSchema,
  uuid,
} from "../../packages/contracts/index.ts";
import { inlineBuildSelect } from "./bundle-derivatives.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { updateArtifactMetadataInTransaction } from "./artifact-metadata.ts";
import { transitionArtifactLifecycleInTransaction } from "./artifact-trash.ts";
import {
  recheckServiceActor,
  type ServiceActor,
  withServiceActorTransaction,
} from "./service-auth.ts";
import { sha256 } from "./storage.ts";
import { linkOfRevision } from "./saved-link-format.ts";

const stateSchema = z.enum(["active", "trashed"]);
const datedCursorSchema = z
  .object({
    state: stateSchema,
    date: z.string().datetime({ offset: true }),
    id: uuid,
  })
  .strict();
const legacyCursorSchema = z
  .object({
    date: z.string().datetime({ offset: true }),
    id: uuid,
  })
  .strict();
const folderCursorSchema = z
  .object({ name: z.string().max(80), id: uuid })
  .strict();

export const agentArtifactListInputSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    query: z.string().trim().max(160).optional(),
    folderId: uuid.nullable().optional(),
    limit: z.number().int().min(1).max(100).default(25),
    state: stateSchema.default("active"),
  })
  .strict();

/** …/works/<id>: the page of a work on the owner's shelf, as the owner copies it. */
const WORKS_PATH =
  /\/works\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

/**
 * A work named the way the owner names it: by id, or by the address of its
 * page («Открой на Полке работу «…» (https://…/works/<id>)»). The tenant
 * check on the id is what keeps another shelf's address a neutral 404.
 */
export const artifactRef = z
  .union([uuid, z.string().max(2048).regex(WORKS_PATH)])
  .describe(
    "The work's id, or the address of its page on the owner's shelf (<origin>/works/<id>) as the owner pastes it.",
  );

export const artifactIdOf = (ref: string) =>
  WORKS_PATH.exec(ref)?.[1]?.toLowerCase() ?? ref;

export const agentGetArtifactInputSchema = z
  .object({ artifactId: artifactRef })
  .strict();

export const agentFolderListInputSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

export const agentUpdateArtifactInputSchema = z
  .object({
    key: uuid,
    artifactId: uuid,
    ...updateArtifactMetadataFields,
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.folderId !== undefined,
    { message: "At least one metadata field must be changed" },
  );

export const agentLifecycleInputSchema = artifactLifecycleSchema.extend({
  artifactId: uuid,
});

function invalidCursor(): never {
  throw new Problem(
    400,
    "invalid",
    "Обновите список: указатель страницы некорректен.",
  );
}

function parseJsonCursor(value: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return invalidCursor();
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalidCursor();
  }
}

function decodeArtifactCursor(
  value: string | undefined,
  state: "active" | "trashed",
) {
  if (!value) return null;
  const decoded = parseJsonCursor(value);
  const current = datedCursorSchema.safeParse(decoded);
  if (current.success) {
    if (current.data.state !== state) return invalidCursor();
    return { date: current.data.date, id: current.data.id };
  }
  const legacy = legacyCursorSchema.safeParse(decoded);
  if (!legacy.success || state !== "active") return invalidCursor();
  return legacy.data;
}

function encodeArtifactCursor(row: any, state: "active" | "trashed") {
  return Buffer.from(
    JSON.stringify({ state, date: row.cursor_date, id: row.id }),
  ).toString("base64url");
}

function decodeFolderCursor(value?: string) {
  if (!value) return null;
  const result = folderCursorSchema.safeParse(parseJsonCursor(value));
  if (!result.success) return invalidCursor();
  return result.data;
}

function encodeFolderCursor(row: any) {
  return Buffer.from(JSON.stringify({ name: row.name, id: row.id })).toString(
    "base64url",
  );
}

/**
 * What a work is, in one word, from its latest revision: page (HTML, one
 * file or a bundle), link (a saved link), image, text or file.
 */
export function workKind(mime: string) {
  if (mime === "text/html") return "page" as const;
  if (mime === LINK_MIME) return "link" as const;
  if (mime.startsWith("image/")) return "image" as const;
  if (mime.startsWith("text/")) return "text" as const;
  return "file" as const;
}

function artifactProjection(row: any) {
  const trashedAt = row.trashed_at
    ? new Date(row.trashed_at).toISOString()
    : null;
  const kind = workKind(row.mime);
  return {
    id: row.id,
    title: row.title,
    kind,
    ...(kind === "link" ? { linkHost: linkOfRevision(row.filename).host } : {}),
    folderId: row.folder_id,
    folderName: row.folder_name ?? null,
    createdAt: new Date(row.first_created_at ?? row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    trashedAt,
    lifecycleVersion: Number(row.lifecycle_version),
    revision: {
      id: row.revision_id,
      number: row.number,
      filename: row.filename,
      mime: row.mime,
      size: Number(row.size),
      totalSize: Number(row.total_size),
      storageKind: row.storage_kind,
      htmlProfile: row.html_profile,
      inlineBuild:
        !trashedAt && config.HTML_LIVE_ENABLED && row.inline_build
          ? {
              state: row.inline_build.state,
              runtimeProfile: row.inline_build.runtimeProfile ?? null,
            }
          : null,
      createdAt: new Date(row.created_at).toISOString(),
    },
  };
}

const artifactColumns = `artifact.id,artifact.title,artifact.folder_id,
  artifact.updated_at,artifact.trashed_at,artifact.lifecycle_version,
  r.id AS revision_id,r.number,r.filename,r.mime,r.size,r.total_size,
  r.storage_kind,r.html_profile,r.created_at,${inlineBuildSelect},
  (SELECT name FROM folders folder
   WHERE folder.tenant_id=artifact.tenant_id
     AND folder.id=artifact.folder_id) AS folder_name,
  (SELECT created_at FROM revisions first
   WHERE first.artifact_id=artifact.id AND first.number=1) AS first_created_at`;

export async function listArtifactsForAgent(
  actor: ServiceActor,
  raw: z.input<typeof agentArtifactListInputSchema>,
) {
  const verified = await recheckServiceActor(actor, "read");
  const input = agentArtifactListInputSchema.parse(raw);
  const cursor = decodeArtifactCursor(input.cursor, input.state);
  const query = input.query
    ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%`
    : null;
  const timestamp =
    input.state === "active" ? "artifact.updated_at" : "artifact.trashed_at";
  const statePredicate =
    input.state === "active"
      ? "artifact.trashed_at IS NULL"
      : "artifact.trashed_at IS NOT NULL";
  const { rows } = await db.query(
    `SELECT ${artifactColumns},
            to_char(${timestamp} AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date
     FROM artifacts artifact
     JOIN revisions r ON r.id=artifact.latest_revision_id
     WHERE artifact.tenant_id=$1 AND ${statePredicate}
       AND ($2::boolean OR artifact.folder_id IS NOT DISTINCT FROM $3::uuid)
       AND ($4::text IS NULL OR artifact.title ILIKE $4 ESCAPE '\\')
       AND ($5::timestamptz IS NULL OR (${timestamp},artifact.id)<($5,$6::uuid))
     ORDER BY ${timestamp} DESC,artifact.id DESC
     LIMIT $7`,
    [
      verified.tenantId,
      input.folderId === undefined,
      input.folderId ?? null,
      query,
      cursor?.date ?? null,
      cursor?.id ?? null,
      input.limit + 1,
    ],
  );
  const more = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    items: page.map(artifactProjection),
    nextCursor:
      more && page.length
        ? encodeArtifactCursor(page.at(-1), input.state)
        : null,
  };
}

export async function getArtifactForAgent(
  actor: ServiceActor,
  raw: z.input<typeof agentGetArtifactInputSchema>,
) {
  const verified = await recheckServiceActor(actor, "read");
  const input = agentGetArtifactInputSchema.parse(raw);
  const {
    rows: [row],
  } = await db.query(
    `SELECT ${artifactColumns}
     FROM artifacts artifact
     JOIN revisions r ON r.id=artifact.latest_revision_id
     WHERE artifact.id=$1 AND artifact.tenant_id=$2`,
    [artifactIdOf(input.artifactId), verified.tenantId],
  );
  if (!row) throw missing();
  return artifactProjection(row);
}

/**
 * Metadata for the HTTP publish API's status call. A connection with `read`
 * sees any work of the shelf; otherwise only works this connection saved.
 */
export async function artifactStatusForAgent(
  actor: ServiceActor,
  raw: z.input<typeof agentGetArtifactInputSchema>,
) {
  const verified = await recheckServiceActor(actor, "context");
  const input = agentGetArtifactInputSchema.parse(raw);
  const {
    rows: [row],
  } = await db.query(
    `SELECT ${artifactColumns}
     FROM artifacts artifact
     JOIN revisions r ON r.id=artifact.latest_revision_id
     WHERE artifact.id=$1 AND artifact.tenant_id=$2
       AND ($3::boolean OR EXISTS (
         SELECT 1 FROM uploads upload
         WHERE upload.tenant_id=artifact.tenant_id
           AND upload.connection_id=$4
           AND upload.receipt->>'artifactId'=artifact.id::text))`,
    [
      artifactIdOf(input.artifactId),
      verified.tenantId,
      verified.scopes.includes("read"),
      verified.connectionId,
    ],
  );
  if (!row) throw missing();
  return artifactProjection(row);
}

export async function listFoldersForAgent(
  actor: ServiceActor,
  raw: z.input<typeof agentFolderListInputSchema>,
) {
  const verified = await recheckServiceActor(actor, "read");
  const input = agentFolderListInputSchema.parse(raw);
  const cursor = decodeFolderCursor(input.cursor);
  const { rows } = await db.query(
    `SELECT id,name,
            (SELECT count(*) FROM artifacts artifact
             WHERE artifact.tenant_id=folder.tenant_id
               AND artifact.folder_id=folder.id
               AND artifact.trashed_at IS NULL) AS works
     FROM folders folder
     WHERE tenant_id=$1
       AND ($2::text IS NULL OR (name,id)>($2,$3::uuid))
     ORDER BY name ASC,id ASC LIMIT $4`,
    [
      verified.tenantId,
      cursor?.name ?? null,
      cursor?.id ?? null,
      input.limit + 1,
    ],
  );
  const more = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      name: row.name,
      works: Number(row.works),
    })),
    nextCursor: more && page.length ? encodeFolderCursor(page.at(-1)) : null,
  };
}

const metadataResultSchema = z
  .object({ artifactId: uuid, title: z.string(), folderId: uuid.nullable() })
  .strict();

function canonicalMetadataRequest(
  input: z.infer<typeof agentUpdateArtifactInputSchema>,
) {
  return {
    key: input.key,
    artifactId: input.artifactId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    expectedTitle: input.expectedTitle,
    expectedFolderId: input.expectedFolderId,
  };
}

const operationConflict = () =>
  new Problem(409, "conflict", "Ключ уже относится к другой операции.");

export async function updateArtifactFromAgent(
  actor: ServiceActor,
  body: unknown,
) {
  const input = agentUpdateArtifactInputSchema.parse(body);
  const request = canonicalMetadataRequest(input);
  const requestHash = sha256(JSON.stringify(request));
  return withServiceActorTransaction(actor, "manage", async (c, verified) => {
    const {
      rows: [old],
    } = await c.query(
      `SELECT * FROM agent_operations
       WHERE tenant_id=$1 AND operation='metadata' AND idempotency_key=$2
       FOR UPDATE`,
      [verified.tenantId, input.key],
    );
    if (old) {
      if (old.connection_id !== verified.connectionId)
        throw operationConflict();
      const oldRequest = canonicalMetadataRequest(
        agentUpdateArtifactInputSchema.parse(old.request),
      );
      if (
        old.request_hash !== requestHash ||
        JSON.stringify(oldRequest) !== JSON.stringify(request)
      )
        throw operationConflict();
      return {
        operation: "metadata" as const,
        key: input.key,
        applied: metadataResultSchema.parse(old.result),
        replayed: true,
      };
    }
    const metadataInput = updateArtifactMetadataSchema.parse({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      expectedTitle: input.expectedTitle,
      expectedFolderId: input.expectedFolderId,
    });
    const applied = await updateArtifactMetadataInTransaction(
      c,
      {
        id: verified.accountId,
        tenant: verified.tenantId,
        connectionId: verified.connectionId,
      },
      input.artifactId,
      metadataInput,
    );
    const result = metadataResultSchema.parse({
      artifactId: applied.id,
      title: applied.title,
      folderId: applied.folderId,
    });
    await c.query(
      `INSERT INTO agent_operations(
         id,tenant_id,account_id,connection_id,operation,idempotency_key,
         request,request_hash,result
       ) VALUES($1,$2,$3,$4,'metadata',$5,$6,$7,$8)`,
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
    return {
      operation: "metadata" as const,
      key: input.key,
      applied: result,
      replayed: false,
    };
  });
}

export async function transitionArtifactFromAgent(
  actor: ServiceActor,
  body: unknown,
  desired: "active" | "trashed",
) {
  const input = agentLifecycleInputSchema.parse(body);
  return withServiceActorTransaction(actor, "manage", (c, verified) =>
    transitionArtifactLifecycleInTransaction(
      c,
      {
        id: verified.accountId,
        tenant: verified.tenantId,
        connectionId: verified.connectionId,
      },
      input.artifactId,
      {
        expectedLifecycleVersion: input.expectedLifecycleVersion,
        expectedRevisionId: input.expectedRevisionId,
      },
      desired,
    ),
  );
}
