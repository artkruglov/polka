// Pure helpers shared by the static snapshot generator, the hosted seed and
// tests. No DB, config or storage imports.
import { z } from "zod";
import { editorialPublicationManifestSchema } from "../packages/editorial.ts";

export const STATIC_SNAPSHOT_NOTE =
  "Статичная версия. Интерактивная версия появится, когда на Полке включится интерактивный просмотр.";
export const STATIC_NOTICES =
  "Оригинальный учебный материал Редакции Полки. Статичная версия: примеры и данные демонстрационные, интерактивные элементы в ней не работают.";
export const STATIC_EVIDENCE_PATH =
  "docs/reviews/2026-09-22-editorial-static/README.md";
// Used instead of the snapshot's notices when the original is published
// through its ready interactive version.
export const INTERACTIVE_NOTICES =
  "Оригинальный учебный материал Редакции Полки. Примеры и данные демонстрационные.";
export const INTERACTIVE_EVIDENCE_PATH =
  "docs/reviews/2026-09-22-editorial-live/README.md";

// The publish service requires the source to be an index.html entry point.
export const staticSourcePath = (slug: string) =>
  `content/editorial/${slug}/static/index.html`;

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().startsWith("content/editorial/");
const metadata = {
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  title: z.string().min(1).max(200),
  topic: z.string().min(1).max(120),
  task: z.string().min(1).max(500),
  action: z.string().min(1).max(500),
  author: z.literal("Редакция Полки"),
  license: z.literal("Apache-2.0"),
};

export const interactiveCandidatesSchema = z.object({
  items: z
    .array(
      z.object({
        ...metadata,
        sourcePath: path,
        sourceSha256: sha,
        evidencePath: z.string(),
      }),
    )
    .min(1),
});

export const staticCandidateSchema = z
  .object({
    ...metadata,
    notices: z.string().min(1).max(1000),
    htmlProfile: z.literal("static"),
    sourcePath: path.endsWith("/static/index.html"),
    sourceSha256: sha,
    interactiveSourcePath: path,
    interactiveSourceSha256: sha,
    evidencePath: z.string().min(1).max(500),
  })
  .strict();
export type StaticCandidate = z.infer<typeof staticCandidateSchema>;

export const staticCandidatesSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("static-snapshots"),
    publication: z.literal("requires-explicit-registration"),
    generator: z.string(),
    items: z.array(staticCandidateSchema).min(1),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.slug)).size === value.items.length,
    "Duplicate slug",
  );

// Mirrors the operator envelope of apps/server/editorial.ts (which imports
// DB/config); the seed parses the result again with the server schema.
export const staticPublishInputSchema = z
  .object({
    publicationId: z.string().uuid(),
    expectedPublicationId: z.string().uuid().nullable(),
    manifest: editorialPublicationManifestSchema,
  })
  .strict();

export type StaticBinding = {
  tenantId: string;
  artifactId: string;
  revisionId: string;
  shareId: string;
  sourceSha256: string;
  manifestSha256: string | null;
};

export type InteractiveBinding = StaticBinding & {
  manifestSha256: string;
  derivative: {
    id: string;
    sha256: string;
    builderVersion: string;
    runtimeProfile: string;
  };
};

function publishInput(input: {
  candidate: StaticCandidate;
  notices: string;
  sourcePath: string;
  sourceSha256: string;
  evidencePath: string;
  binding: StaticBinding;
  derivative: InteractiveBinding["derivative"] | null;
  publicationId: string;
  expectedPublicationId: string | null;
  checkedAt: string;
}) {
  const { candidate, binding, derivative } = input;
  if (binding.sourceSha256 !== input.sourceSha256)
    throw new Error(`${candidate.slug}: revision hash differs from the source`);
  return staticPublishInputSchema.parse({
    publicationId: input.publicationId,
    expectedPublicationId: input.expectedPublicationId,
    manifest: {
      version: 1,
      public: {
        slug: candidate.slug,
        title: candidate.title,
        topic: candidate.topic,
        task: candidate.task,
        action: candidate.action,
        author: candidate.author,
        license: candidate.license,
        notices: input.notices,
      },
      source: {
        path: input.sourcePath,
        commit: null,
        sha256: input.sourceSha256,
      },
      runtimeProof: {
        originalRevisionId: binding.revisionId,
        originalSha256: binding.sourceSha256,
        originalManifestSha256: binding.manifestSha256,
        derivative,
        checkedAt: input.checkedAt,
        evidencePath: input.evidencePath,
      },
      binding: {
        tenantId: binding.tenantId,
        artifactId: binding.artifactId,
        revisionId: binding.revisionId,
        shareId: binding.shareId,
        sourceSha256: binding.sourceSha256,
        manifestSha256: binding.manifestSha256,
        derivativeId: derivative?.id ?? null,
        derivativeSha256: derivative?.sha256 ?? null,
        builderVersion: derivative?.builderVersion ?? null,
        runtimeProfile: derivative?.runtimeProfile ?? null,
      },
    },
  });
}

/**
 * Operator input for one static single-HTML publication: public metadata from
 * the candidate, exact binding to the uploaded revision and its catalogue
 * share, no derivative.
 */
export function buildStaticPublishInput(input: {
  candidate: StaticCandidate;
  binding: StaticBinding;
  publicationId: string;
  expectedPublicationId: string | null;
  checkedAt: string;
}) {
  return publishInput({
    ...input,
    notices: input.candidate.notices,
    sourcePath: input.candidate.sourcePath,
    sourceSha256: input.candidate.sourceSha256,
    evidencePath: input.candidate.evidencePath,
    derivative: null,
  });
}

/**
 * Operator input for the interactive original: the one-file bundle revision
 * of content/editorial/<slug>/index.html and its catalogue share, both bound
 * to the ready derivative the live viewer serves.
 */
export function buildInteractivePublishInput(input: {
  candidate: StaticCandidate;
  binding: InteractiveBinding;
  publicationId: string;
  expectedPublicationId: string | null;
  checkedAt: string;
}) {
  return publishInput({
    ...input,
    notices: INTERACTIVE_NOTICES,
    sourcePath: input.candidate.interactiveSourcePath,
    sourceSha256: input.candidate.interactiveSourceSha256,
    evidencePath: INTERACTIVE_EVIDENCE_PATH,
    derivative: input.binding.derivative,
  });
}
