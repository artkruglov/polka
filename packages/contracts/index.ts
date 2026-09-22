import { z } from "zod";
// The zod-free constants live in constants.ts so the browser's initial chunk
// does not pull in zod; this module re-exports them.
export {
  MAX_BYTES,
  MAX_TITLE,
  MIME,
  looksLikeHtml,
  REPORT_REASONS,
  AGENT_SCOPES,
} from "./constants.ts";
export type { UploadMime, ReportReason } from "./constants.ts";
import { MAX_BYTES, MAX_TITLE, MIME, REPORT_REASONS, AGENT_SCOPES } from "./constants.ts";
// How a saved HTML page may be shown. "static" and "limited" render in a
// scriptless, networkless sandbox; "unsupported" needs a runtime profile that
// this build does not have, so it gets no link.
export const HTML_PROFILES = ["static", "limited", "unsupported"] as const;
export type HtmlProfile = (typeof HTML_PROFILES)[number];
export type InlineBuildStatus = {
  state: "pending" | "ready" | "unsupported" | "failed";
  runtimeProfile: string | null;
  reason: string | null;
  path: string | null;
};
export const uuid = z.string().uuid();
export const agentScopeSchema = z.enum(AGENT_SCOPES);
export type AgentScope = z.infer<typeof agentScopeSchema>;
export const updateArtifactMetadataFields = {
  title: z.string().trim().min(1).max(MAX_TITLE).optional(),
  folderId: uuid.nullable().optional(),
  expectedTitle: z.string().max(200),
  expectedFolderId: uuid.nullable(),
} as const;
export const updateArtifactMetadataSchema = z
  .object(updateArtifactMetadataFields)
  .strict()
  .refine(
    (value) => value.title !== undefined || value.folderId !== undefined,
    {
      message: "At least one metadata field must be changed",
    },
  );
export type UpdateArtifactMetadata = z.infer<
  typeof updateArtifactMetadataSchema
>;
export const issueAgentConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(agentScopeSchema).min(1).max(AGENT_SCOPES.length),
    audience: z.string().url().max(2048),
    ttlDays: z.number().int().min(1).max(30).default(7),
  })
  .strict()
  .transform((value) => ({
    ...value,
    scopes: [...new Set(value.scopes)].sort() as AgentScope[],
  }));
export type AgentConnection = {
  id: string;
  name: string;
  scopes: AgentScope[];
  audience: string;
  status: "issued" | "seen" | "expired" | "revoked";
  /** token: issued on the agents page; oauth: granted to a chat connector. */
  kind: "token" | "oauth";
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
};
/** What the consent page shows for one pending connector authorization. */
export type OAuthConsentDetails = {
  requestId: string;
  client: { name: string; redirectHost: string };
  scopes: AgentScope[];
  defaultScopes: AgentScope[];
  accessMinutes: number;
  refreshDays: number;
  maxDays: number;
  replaces: boolean;
  expiresAt: string;
};
export const beginUploadSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(MAX_TITLE),
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
export const artifactLifecycleSchema = z
  .object({
    expectedLifecycleVersion: z.number().int().min(0),
    expectedRevisionId: uuid,
  })
  .strict();
export type ArtifactLifecycleInput = z.infer<typeof artifactLifecycleSchema>;
export type ArtifactLifecycleSnapshot = {
  id: string;
  trashedAt: string | null;
  lifecycleVersion: number;
};
export const reportSchema = z
  .object({
    key: uuid,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    reason: z.enum(REPORT_REASONS),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();
export interface Revision {
  manifest?: import("./bundle.ts").BundleManifest | null;
  manifestSha256?: string | null;
  id: string;
  number: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  storageKind: "single" | "bundle";
  totalSize: number;
  htmlProfile: HtmlProfile | null;
  inlineBuild: InlineBuildStatus | null;
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
  trashedAt: string | null;
  lifecycleVersion: number;
  revision: Revision;
  share: Share | null;
}
export interface Folder {
  id: string;
  name: string;
}
export interface Receipt {
  // Absent on older receipts and non-HTML uploads.
  manifestSha256?: string | null;
  uploadId: string;
  artifactId: string;
  revisionId: string;
  number: number;
  sha256: string;
  storageKind?: "single" | "bundle";
  totalSize?: number;
  // Absent on receipts saved before HTML support.
  htmlProfile?: HtmlProfile | null;
}
// Legacy browser-only URL classification shapes. These are NOT the durable
// /api/imports job contract implemented in server/url-import; no receipt here.
export type ImportStatus =
  "not_https" | "closed" | "unsupported_host" | "ready" | "provider";
export interface ImportProvenance {
  sourceUrl: string;
  sourceHost: string;
  fetchedAt: string;
}
export interface ImportPreview {
  status: ImportStatus;
  title: string | null;
  htmlProfile: HtmlProfile | null;
  provenance: ImportProvenance | null;
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
  | "unsupported"
  | "internal";
