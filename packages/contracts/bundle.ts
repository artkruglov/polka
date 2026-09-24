import { z } from "zod";
import { MAX_BYTES, MAX_TITLE, MIME, sourceUrlSchema, uuid } from "./index.ts";

const BUNDLE_MIME = [
  ...MIME,
  "text/css",
  "text/javascript",
  "application/json",
  "image/svg+xml",
  "font/woff2",
] as const;

const pathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => {
    const segments = value.split("/");
    return (
      segments.length <= 8 &&
      segments.every(
        (segment) =>
          /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?![\s\S])/.test(segment) &&
          !segment.endsWith("."),
      )
    );
  }, "path must be a relative POSIX path with valid ASCII segments");

const capturedAtSchema = z.string().refine((value) => {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})(?![\s\S])/,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, timezone] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const timezoneMatch =
    timezone === "Z" ? null : timezone.match(/^[+-](\d{2}):(\d{2})$/);
  return (
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <=
      new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate() &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    (!timezoneMatch ||
      (Number(timezoneMatch[1]) <= 23 && Number(timezoneMatch[2]) <= 59))
  );
}, "capturedAt must be an RFC3339 timestamp with timezone");

const fileSchema = z
  .object({
    path: pathSchema,
    mime: z.enum(BUNDLE_MIME),
    size: z.number().int().min(0).max(MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  })
  .strict();

const provenanceSchema = z
  .object({
    kind: z.enum(["file", "mcp", "url"]),
    sourceUrl: sourceUrlSchema.nullable(),
    capturedAt: capturedAtSchema,
    attribution: z.string().min(1).max(500),
    license: z.string().min(1).max(200),
  })
  .strict();

const dependenciesSchema = z
  .object({
    status: z.enum(["self-contained", "incomplete", "unknown"]),
    unresolved: z.array(z.string().min(1).max(500)).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "self-contained" && value.unresolved.length > 0)
      context.addIssue({
        code: "custom",
        path: ["unresolved"],
        message: "self-contained bundles cannot have unresolved dependencies",
      });
    if (value.status === "incomplete" && value.unresolved.length === 0)
      context.addIssue({
        code: "custom",
        path: ["unresolved"],
        message: "incomplete bundles must list unresolved dependencies",
      });
  });

const manifestInputSchema = z
  .object({
    version: z.literal(1),
    entrypoint: pathSchema,
    runtime: z.enum([
      "static-sandbox-v1",
      "inline-live-experimental-v1",
      "preserved-only-v1",
    ]),
    files: z.array(fileSchema).min(1).max(64),
    provenance: provenanceSchema,
    dependencies: dependenciesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Map<
      string,
      { path: string; size: number; index: number }
    >();
    let total = 0;
    for (const [index, file] of value.files.entries()) {
      total += file.size;
      const key = file.path.toLocaleLowerCase("en-US");
      const previous = paths.get(key);
      if (previous)
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: `path collides case-insensitively with ${previous.path}`,
        });
      else paths.set(key, { path: file.path, size: file.size, index });
    }
    if (total < 1 || total > MAX_BYTES)
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `total file size must be between 1 and ${MAX_BYTES} bytes`,
      });
    const entry = value.files.find((file) => file.path === value.entrypoint);
    if (!entry)
      context.addIssue({
        code: "custom",
        path: ["entrypoint"],
        message: "entrypoint must exactly match one file path",
      });
    else {
      if (entry.mime !== "text/html")
        context.addIssue({
          code: "custom",
          path: ["entrypoint"],
          message: "entrypoint must be text/html",
        });
      if (entry.size === 0)
        context.addIssue({
          code: "custom",
          path: ["entrypoint"],
          message: "entrypoint must be non-empty",
        });
    }
  });

export const bundleManifestSchema = manifestInputSchema;
export type BundleManifest = z.infer<typeof bundleManifestSchema>;

/** Parse and return a stable manifest whose files are ordered by ASCII path. */
export function canonicalizeManifest(input: unknown): BundleManifest {
  const manifest = bundleManifestSchema.parse(input);
  return {
    version: manifest.version,
    entrypoint: manifest.entrypoint,
    runtime: manifest.runtime,
    files: [...manifest.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => ({
        path: file.path,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
      })),
    provenance: {
      kind: manifest.provenance.kind,
      sourceUrl: manifest.provenance.sourceUrl,
      capturedAt: manifest.provenance.capturedAt,
      attribution: manifest.provenance.attribution,
      license: manifest.provenance.license,
    },
    dependencies: {
      status: manifest.dependencies.status,
      unresolved: [...manifest.dependencies.unresolved],
    },
  };
}

export const beginBundleUploadSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(MAX_TITLE),
    manifest: bundleManifestSchema,
    artifactId: uuid.optional(),
    baseRevisionId: uuid.optional(),
    folderId: uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => !!value.artifactId === !!value.baseRevisionId,
    "A revision needs its base",
  );

export type BundleUploadInput = z.infer<typeof beginBundleUploadSchema>;

export interface BundleExport {
  manifest: BundleManifest;
  manifestSha256: string;
  files: Array<{
    path: string;
    mime: string;
    size: number;
    sha256: string;
    encoding: "base64";
    data: string;
  }>;
}
