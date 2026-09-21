import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POSIX_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const sha256Schema = z.string().regex(SHA256);
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const urlSchema = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }, "recipientUrl must use http or https");

/** Immutable source identity kept for editorial audit, separate from public text. */
export const editorialSourceSchema = z
  .object({
    path: z.string().min(1).max(500).regex(POSIX_PATH),
    commit: z.string().regex(COMMIT).nullable(),
    sha256: sha256Schema,
  })
  .strict();

/** Runtime evidence binds the exact original revision and optional ready derivative. */
export const editorialRuntimeProofSchema = z
  .object({
    originalRevisionId: uuidSchema,
    originalSha256: sha256Schema,
    originalManifestSha256: sha256Schema.nullable(),
    derivative: z
      .object({
        id: uuidSchema,
        sha256: sha256Schema,
        runtimeProfile: z.string().min(1).max(120),
        builderVersion: z.string().min(1).max(120),
      })
      .strict()
      .nullable(),
    checkedAt: timestampSchema,
    evidencePath: z.string().min(1).max(500).regex(POSIX_PATH),
  })
  .strict()
  ;

export const editorialBindingSchema = z
  .object({
    tenantId: uuidSchema,
    artifactId: uuidSchema,
    revisionId: uuidSchema,
    shareId: uuidSchema,
    sourceSha256: sha256Schema,
    manifestSha256: sha256Schema.nullable(),
    derivativeId: uuidSchema.nullable(),
    derivativeSha256: sha256Schema.nullable(),
    builderVersion: z.string().min(1).max(120).nullable(),
    runtimeProfile: z.string().min(1).max(120).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const derivativeFields = [
      value.derivativeId,
      value.derivativeSha256,
      value.builderVersion,
      value.runtimeProfile,
    ];
    const anyDerivative = derivativeFields.some((field) => field !== null);
    const allDerivative = derivativeFields.every((field) => field !== null);
    if (anyDerivative && !allDerivative) {
      ctx.addIssue({
        code: "custom",
        path: ["derivativeId"],
        message: "Derivative binding fields must be all present or all null",
      });
    }
  });

export const editorialPublicMetadataSchema = z
  .object({
    slug: z.string().regex(SLUG).max(80),
    title: nonEmptyText(200),
    topic: nonEmptyText(120),
    task: nonEmptyText(500),
    action: nonEmptyText(500),
    author: z.literal("Редакция Полки"),
    license: z.literal("Apache-2.0"),
    notices: nonEmptyText(1000),
  })
  .strict();

/** Server-owned response fields are never accepted as editorial input. */
export const editorialPublicResponseSchema = editorialPublicMetadataSchema
  .extend({
    publishedAt: timestampSchema,
    recipientUrl: urlSchema,
  })
  .strict();

export const editorialPublicationManifestSchema = z
  .object({
    version: z.literal(1),
    public: editorialPublicMetadataSchema,
    source: editorialSourceSchema,
    runtimeProof: editorialRuntimeProofSchema,
    binding: editorialBindingSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source.sha256 !== value.runtimeProof.originalSha256) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeProof", "originalSha256"],
        message: "Source and runtime proof hashes must match",
      });
    }
    if (value.binding.sourceSha256 !== value.runtimeProof.originalSha256) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "sourceSha256"],
        message: "Binding must point at the runtime proof source hash",
      });
    }
    if (value.binding.manifestSha256 !== value.runtimeProof.originalManifestSha256) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "manifestSha256"],
        message: "Binding manifest hash does not match runtime proof",
      });
    }
    if (value.binding.revisionId !== value.runtimeProof.originalRevisionId) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "revisionId"],
        message: "Binding revision does not match runtime proof",
      });
    }
    if (
      value.runtimeProof.derivative === null &&
      value.binding.derivativeId !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "derivativeId"],
        message: "Binding cannot include a derivative absent from runtime proof",
      });
    }
    if (value.runtimeProof.derivative) {
      if (value.runtimeProof.originalManifestSha256 === null) {
        ctx.addIssue({
          code: "custom",
          path: ["runtimeProof", "originalManifestSha256"],
          message: "A derivative proof requires the original manifest hash",
        });
      }
      if (value.binding.derivativeId !== value.runtimeProof.derivative.id) {
        ctx.addIssue({
          code: "custom",
          path: ["binding", "derivativeId"],
          message: "Binding derivative id does not match runtime proof",
        });
      }
      if (value.binding.derivativeSha256 !== value.runtimeProof.derivative.sha256) {
        ctx.addIssue({
          code: "custom",
          path: ["binding", "derivativeSha256"],
          message: "Binding derivative hash does not match runtime proof",
        });
      }
      if (value.binding.builderVersion !== value.runtimeProof.derivative.builderVersion) {
        ctx.addIssue({
          code: "custom",
          path: ["binding", "builderVersion"],
          message: "Binding builder does not match runtime proof",
        });
      }
      if (value.binding.runtimeProfile !== value.runtimeProof.derivative.runtimeProfile) {
        ctx.addIssue({
          code: "custom",
          path: ["binding", "runtimeProfile"],
          message: "Binding runtime profile does not match runtime proof",
        });
      }
    }
  });

export type EditorialSource = z.infer<typeof editorialSourceSchema>;
export type EditorialRuntimeProof = z.infer<typeof editorialRuntimeProofSchema>;
export type EditorialBinding = z.infer<typeof editorialBindingSchema>;
export type EditorialPublicMetadata = z.infer<
  typeof editorialPublicMetadataSchema
>;
export type EditorialPublicResponse = z.infer<
  typeof editorialPublicResponseSchema
>;
export type EditorialPublicationManifest = z.infer<
  typeof editorialPublicationManifestSchema
>;

export function validateEditorialPublication(input: unknown): EditorialPublicationManifest {
  return editorialPublicationManifestSchema.parse(input);
}

/** Public projection is explicit and never derives a token, share, or URL. */
export function toEditorialPublicMetadata(
  input: EditorialPublicationManifest,
): EditorialPublicMetadata {
  return editorialPublicMetadataSchema.parse(input.public);
}
