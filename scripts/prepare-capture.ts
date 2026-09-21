import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import { MAX_BYTES } from "../packages/contracts/index.ts";

const mimeByExtension: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

/** Only explicitly selected files; never walks a user's directory or sends bytes. */
export async function prepareCapture(
  root: string,
  entrypoint: string,
  selected: string[],
) {
  if (!selected.length || selected.length > 64)
    throw Error("Select 1–64 files.");
  const files = [];
  const payload = [];
  let total = 0;
  for (const relative of selected) {
    const segments = relative.split("/");
    if (
      segments.length > 8 ||
      segments.some(
        (s) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s) || s.endsWith("."),
      )
    )
      throw Error(`Invalid relative path: ${relative}`);
    let current = path.resolve(root);
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())
      )
        throw Error(
          `Only regular files within the selected directory are supported: ${relative}`,
        );
      if (index === segments.length - 1 && info.size > MAX_BYTES - total)
        throw Error("Selected files exceed the 5 MiB limit.");
    }
    const mime = mimeByExtension[path.extname(relative).toLowerCase()];
    if (!mime) throw Error(`Unsupported extension: ${relative}`);
    const bytes = await readFile(current);
    total += bytes.length;
    if (total > MAX_BYTES)
      throw Error("Selected files exceed the 5 MiB limit.");
    files.push({
      path: relative,
      mime,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    payload.push({
      path: relative,
      encoding: "base64" as const,
      data: bytes.toString("base64"),
    });
  }
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint,
    runtime: "preserved-only-v1",
    files,
    provenance: {
      kind: "mcp",
      sourceUrl: null,
      capturedAt: new Date().toISOString(),
      attribution: "Uploaded by the author through an agent",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  });
  return {
    manifest,
    files: payload.sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [root, entrypoint, output, ...files] = process.argv.slice(2);
    if (!root || !entrypoint || !output || !files.length)
      throw Error(
        "Usage: tsx scripts/prepare-capture.ts ROOT ENTRYPOINT OUTPUT FILE [FILE ...]",
      );
    const result = await prepareCapture(root, entrypoint, files);
    await writeFile(output, JSON.stringify(result), {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      `Prepared ${result.files.length} files. Nothing uploaded. Output contains the selected source bytes.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Preparation failed.",
    );
    process.exitCode = 1;
  }
}
