import { z } from "zod";
import { uuid } from "./index.ts";
export const contextPurpose = z.enum(["base", "source", "style"]);
export const templateCatalogInput = z
  .object({
    query: z.string().trim().max(200).default(""),
    includePrevious: z.boolean().default(false),
    libraryId: uuid.optional(),
  })
  .strict();
export const contextInput = z
  .object({
    artifactId: uuid,
    revisionId: uuid,
    libraryId: uuid.optional(),
    publicationId: uuid.optional(),
    purpose: contextPurpose.optional(),
  })
  .refine(
    (value) => Boolean(value.libraryId) === Boolean(value.publicationId),
    {
      message: "libraryId and publicationId must be supplied together",
    },
  )
  .strict();
export const templateReleaseInput = z
  .object({
    revisionId: uuid,
    summary: z.string().trim().min(1).max(600),
    rules: z.string().trim().min(1).max(6000),
    questions: z.string().trim().max(3000).default(""),
  })
  .strict();
export type AgentContext = {
  schemaVersion: 1;
  artifactId: string;
  revisionId: string;
  libraryId?: string;
  publicationId?: string;
  title: string;
  revisionNumber: number;
  purpose: z.infer<typeof contextPurpose>;
  releaseId: string | null;
  summary: string;
  rules: string;
  questions: string;
  availableContent: Array<{
    path: string;
    mime: string;
    size: number;
    sha256: string;
  }>;
  sourceAccess: {
    scope: "source:read";
    tool: "polka_read_source";
    packageUrl: string;
  };
  clipboardText: string;
};

export type SingleFileSourceDescriptor = {
  kind: "single-file";
  schema: 1;
  files: Array<{
    path: string;
    mime: "text/plain" | "image/png" | "image/jpeg" | "image/webp";
    size: number;
    sha256: string;
  }>;
};
