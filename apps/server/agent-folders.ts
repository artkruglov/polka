import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { uuid } from "../../packages/contracts/index.ts";
import { Problem } from "./errors.ts";
import {
  MAX_MOVE_BATCH,
  createFolderInTransaction,
  deleteFolderInTransaction,
  folderNameSchema,
  moveArtifactsInTransaction,
  renameFolderInTransaction,
} from "./folders.ts";
import {
  type ServiceActor,
  withServiceActorTransaction,
} from "./service-auth.ts";
import { sha256 } from "./storage.ts";

/*
 * Folder tools for agents (scope manage): create, rename, delete an empty
 * folder, and move a batch of works. Each is keyed like polka_update_artifact:
 * the same key with the same request from the same connection returns the
 * stored result (replayed: true); the same key with anything else is a
 * conflict. The rules themselves are the web's (folders.ts).
 */

const key = uuid.describe(
  "A fresh UUID per operation; reuse it only to retry the same call.",
);
const folderId = uuid.describe("A folder id from polka_list_folders.");

export const agentCreateFolderInputSchema = z
  .object({
    key,
    name: folderNameSchema.describe(
      "The folder's name, 1-80 characters, unique on the shelf.",
    ),
  })
  .strict();

export const agentRenameFolderInputSchema = z
  .object({
    key,
    folderId,
    name: folderNameSchema.describe(
      "The new name, 1-80 characters, unique on the shelf.",
    ),
  })
  .strict();

export const agentDeleteFolderInputSchema = z
  .object({ key, folderId })
  .strict();

export const agentMoveInputSchema = z
  .object({
    key,
    artifactIds: z
      .array(uuid)
      .min(1)
      .max(MAX_MOVE_BATCH)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Each work once",
      })
      .describe(
        `Ids of works on the shelf (polka_list), 1-${MAX_MOVE_BATCH}, each once.`,
      ),
    folderId: uuid
      .nullable()
      .describe("The destination folder's id, or null for «без папки»."),
  })
  .strict();

type Operation = "folder-create" | "folder-rename" | "folder-delete" | "move";

const operationConflict = () =>
  new Problem(409, "conflict", "Ключ уже относится к другой операции.");

/** One keyed agent operation: replay it, or apply it and store the result. */
async function keyed<T extends Record<string, unknown>>(
  actor: ServiceActor,
  operation: Operation,
  request: { key: string } & Record<string, unknown>,
  apply: (
    c: PoolClient,
    owner: { id: string; tenant: string; connectionId: string },
  ) => Promise<T>,
) {
  const requestHash = sha256(JSON.stringify(request));
  return withServiceActorTransaction(actor, "manage", async (c, verified) => {
    const {
      rows: [old],
    } = await c.query(
      `SELECT connection_id,request_hash,result FROM agent_operations
       WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3
       FOR UPDATE`,
      [verified.tenantId, operation, request.key],
    );
    if (old) {
      if (
        old.connection_id !== verified.connectionId ||
        old.request_hash !== requestHash
      )
        throw operationConflict();
      return {
        operation,
        key: request.key,
        applied: old.result as T,
        replayed: true,
      };
    }
    const applied = await apply(c, {
      id: verified.accountId,
      tenant: verified.tenantId,
      connectionId: verified.connectionId,
    });
    await c.query(
      `INSERT INTO agent_operations(
         id,tenant_id,account_id,connection_id,operation,idempotency_key,
         request,request_hash,result
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        verified.tenantId,
        verified.accountId,
        verified.connectionId,
        operation,
        request.key,
        request,
        requestHash,
        applied,
      ],
    );
    return { operation, key: request.key, applied, replayed: false };
  });
}

export async function createFolderFromAgent(
  actor: ServiceActor,
  body: unknown,
) {
  const input = agentCreateFolderInputSchema.parse(body);
  return keyed(
    actor,
    "folder-create",
    { key: input.key, name: input.name },
    (c, owner) => createFolderInTransaction(c, owner, input.name),
  );
}

export async function renameFolderFromAgent(
  actor: ServiceActor,
  body: unknown,
) {
  const input = agentRenameFolderInputSchema.parse(body);
  return keyed(
    actor,
    "folder-rename",
    { key: input.key, folderId: input.folderId, name: input.name },
    (c, owner) =>
      renameFolderInTransaction(c, owner, input.folderId, input.name),
  );
}

export async function deleteFolderFromAgent(
  actor: ServiceActor,
  body: unknown,
) {
  const input = agentDeleteFolderInputSchema.parse(body);
  return keyed(
    actor,
    "folder-delete",
    { key: input.key, folderId: input.folderId },
    (c, owner) => deleteFolderInTransaction(c, owner, input.folderId),
  );
}

export async function moveFromAgent(actor: ServiceActor, body: unknown) {
  const input = agentMoveInputSchema.parse(body);
  return keyed(
    actor,
    "move",
    {
      key: input.key,
      artifactIds: input.artifactIds.map((id) => id.toLowerCase()),
      folderId: input.folderId?.toLowerCase() ?? null,
    },
    (c, owner) =>
      moveArtifactsInTransaction(c, owner, input.artifactIds, input.folderId),
  );
}
