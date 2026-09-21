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
