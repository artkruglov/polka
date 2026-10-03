// A personal shelf moved to another installation (docs/specs/SHELF_TRANSFER.md):
// the inventory GET /api/v1/export pages through, the file polka-export.mjs
// writes from it, and what scripts/shelf-import.ts reads back.
import { z } from "zod";

export const SHELF_EXPORT_FORMAT = "polka-shelf-export/1";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const at = z.iso.datetime({ offset: true });

export const exportFileSchema = z
  .object({
    index: z.number().int().min(0),
    path: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().min(0),
    sha256: sha,
  })
  .strict();

export const exportRevisionSchema = z
  .object({
    id,
    number: z.number().int().min(1),
    createdAt: at,
    filename: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().min(0),
    sha256: sha,
    totalSize: z.number().int().min(0),
    storageKind: z.enum(["single", "bundle"]),
    manifest: z.unknown().nullable(),
    manifestSha256: sha.nullable(),
    /** The bytes are not given out: moderation isolated them, or deleted them. */
    unavailable: z.enum(["blocked", "removed"]).nullable(),
    files: z.array(exportFileSchema),
  })
  .strict();

export const exportItemSchema = z
  .object({
    id,
    title: z.string().min(1),
    folderId: id.nullable(),
    updatedAt: at,
    trashedAt: at.nullable(),
    /** The shelf's owner was named responsible for the work. */
    ownerIsSelf: z.boolean(),
    acceptedRevisionId: id.nullable(),
    acceptedAt: at.nullable(),
    revisions: z.array(exportRevisionSchema).min(1),
  })
  .strict();

export const exportFolderSchema = z.object({ id, name: z.string().min(1) }).strict();

export const exportSourceSchema = z
  .object({
    origin: z.string().url(),
    shelfId: id,
    accountEmail: z.string().nullable(),
    polkaVersion: z.string(),
  })
  .strict();

export const exportShelfSchema = z
  .object({
    cardMd: z.string().nullable(),
    folders: z.array(exportFolderSchema),
  })
  .strict();

/** One page of GET /api/v1/export. */
export const shelfExportPageSchema = z
  .object({
    format: z.literal(SHELF_EXPORT_FORMAT),
    exportedAt: at,
    source: exportSourceSchema,
    shelf: exportShelfSchema,
    items: z.array(exportItemSchema),
    /** The id of the last work on this page; null on the last page. */
    nextCursor: id.nullable(),
  })
  .strict();

/** polka-export.json: every page joined, plus the run's id kept across reruns. */
export const shelfExportFileSchema = z
  .object({
    format: z.literal(SHELF_EXPORT_FORMAT),
    exportId: id,
    exportedAt: at,
    source: exportSourceSchema,
    shelf: exportShelfSchema,
    items: z.array(exportItemSchema),
  })
  .strict();

export type ShelfExportPage = z.infer<typeof shelfExportPageSchema>;
export type ShelfExportFile = z.infer<typeof shelfExportFileSchema>;
export type ShelfExportItem = z.infer<typeof exportItemSchema>;
export type ShelfExportRevision = z.infer<typeof exportRevisionSchema>;
