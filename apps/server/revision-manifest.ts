import { createHash } from "node:crypto";
import {
  canonicalizeManifest,
  type BundleManifest,
} from "../../packages/contracts/bundle.ts";
import type { HtmlProfile } from "../../packages/contracts/index.ts";

const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

export function createSingleHtmlRevisionManifest(
  bytes: Buffer,
  htmlProfile: HtmlProfile,
  capturedAt = new Date(),
): { manifest: BundleManifest; manifestSha256: string } {
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime:
      htmlProfile === "static" || htmlProfile === "limited"
        ? "static-sandbox-v1"
        : "preserved-only-v1",
    files: [
      {
        path: "index.html",
        mime: "text/html",
        size: bytes.length,
        sha256: digest(bytes),
      },
    ],
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: capturedAt.toISOString(),
      attribution: "Загружено владельцем; авторство не подтверждено",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  });
  return {
    manifest,
    manifestSha256: digest(JSON.stringify(manifest)),
  };
}

// A bundle holding only its HTML entrypoint is the page a single upload would
// be. When classified static or limited, it uses the same sandboxed static
// view and links without a runtime derivative; the schema enforces the shape.
export const isStaticSingleFileBundle = (revision: any) =>
  revision?.storage_kind === "bundle" &&
  revision.mime === "text/html" &&
  (revision.html_profile === "static" || revision.html_profile === "limited") &&
  Array.isArray(revision.manifest?.files) &&
  revision.manifest.files.length === 1 &&
  revision.manifest.files[0].path === revision.manifest.entrypoint;

/** SQL twin of isStaticSingleFileBundle for the revision alias `r`. */
export const staticSingleFileBundleSql = (r: string) =>
  `(${r}.storage_kind='bundle' AND ${r}.mime='text/html'
    AND ${r}.html_profile IN ('static','limited')
    AND jsonb_array_length(${r}.manifest->'files')=1)`;
