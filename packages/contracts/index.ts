import { z } from "zod";
export const MAX_BYTES = 5 * 1024 * 1024;
export const MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
] as const;
export const uuid = z.string().uuid();
export const beginUploadSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(160),
    filename: z.string().trim().min(1).max(200),
    mime: z.enum(MIME),
    size: z.number().int().min(1).max(MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    artifactId: uuid.optional(),
    baseRevisionId: uuid.optional(),
    folderId: uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (x) => !!x.artifactId === !!x.baseRevisionId,
    "A revision needs its base",
  );
export type UploadInput = z.infer<typeof beginUploadSchema>;
export const shareSchema = z
  .object({
    expectedRevisionId: uuid,
    expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  })
  .strict();
export const publishSchema = z
  .object({ revisionId: uuid, expectedPublishedRevisionId: uuid })
  .strict();
export interface Revision {
  id: string;
  number: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface Share {
  id: string;
  revisionId: string;
  number: number;
  status: "active" | "behind" | "expired" | "revoked";
  url: string | null;
  expiresAt: string;
}
export interface Artifact {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: string;
  revision: Revision;
  share: Share | null;
}
export interface Folder {
  id: string;
  name: string;
}
export interface Receipt {
  uploadId: string;
  artifactId: string;
  revisionId: string;
  number: number;
  sha256: string;
}
export interface Viewer {
  title: string;
  revision: Revision;
  grant: string;
  expiresAt: string;
}
export interface Account {
  id: string;
  name: string;
}
export type ErrorCode =
  | "invalid"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "expired"
  | "quota"
  | "forbidden"
  | "internal";
