#!/usr/bin/env node
// Publish a folder of linked pages to Полка as one project and print where it
// is (docs/specs/PROJECTS.md). No dependencies: Node 22+ (global fetch). The
// token is read from POLKA_TOKEN only.
//
//   POLKA_ENDPOINT=https://polka.example.com POLKA_TOKEN=… \
//     node polka-publish-project.mjs ./Y360-v2 --title "Яндекс 360 + агенты"
//   node polka-publish-project.mjs ./Y360-v2 --dry-run
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 48 * 1024 * 1024;
const MAX_FILES = 400;
const ATTEMPTS = 3;
const TIMEOUT_MS = 180_000;
const MIME = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
};
// Never part of what a reader opens.
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".venv", "venv"]);
const SKIP_FILE = /^\.|\.pyc$/;
// A path segment Полка accepts (packages/contracts/bundle.ts).
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const ENTRY_ORDER = ["README.md", "index.md", "index.html"];

const USAGE = `Usage: polka-publish-project <folder> [options]

Publishes a folder of linked pages (Markdown, HTML with its CSS, scripts,
fonts and pictures) to your Полка shelf as one project: a tree of pages with
links between them. Prints the project's address on the shelf.

Options:
  --title <text>     Title on the shelf (default: the first heading of README.md or the folder name)
  --entry <path>     Page to open first (default: README.md, index.md or index.html in the folder)
  --exclude <name>   Skip files or folders with this name; repeat for more
  --folder <uuid>    Save into this shelf folder
  --key <uuid>       Idempotency key; reuse it only to retry the same publish
  --endpoint <url>   Полка address (or $POLKA_ENDPOINT)
  --dry-run          List what would be sent and skipped, send nothing
  --json             Print the full JSON result
  -h, --help         Show this help

Skipped without asking: hidden files, node_modules, __pycache__, .git, *.pyc,
files over 5 MB, unsupported types and names outside [A-Za-z0-9._-].

Environment:
  POLKA_TOKEN        Agent token from Полка → Агенты (required; never pass it as an argument)
  POLKA_ENDPOINT     Полка address, e.g. https://polka.example.com`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

async function walk(root, exclude) {
  const files = [];
  const skipped = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: "symbolic link" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || exclude.has(entry.name))
          continue;
        await visit(full);
        continue;
      }
      if (SKIP_FILE.test(entry.name) || exclude.has(entry.name)) continue;
      const mime = MIME[extname(entry.name).toLowerCase()];
      const size = (await stat(full)).size;
      if (!mime) skipped.push({ path, reason: "unsupported type" });
      else if (!path.split("/").every((segment) => SEGMENT.test(segment) && !segment.endsWith(".")) || path.split("/").length > 8 || path.length > 200)
        skipped.push({ path, reason: "name outside [A-Za-z0-9._-] or too deep" });
      else if (size > MAX_FILE) skipped.push({ path, reason: `larger than 5 MB (${(size / 1048576).toFixed(1)} MB)` });
      else if (size === 0) skipped.push({ path, reason: "empty" });
      else files.push({ path, full, mime, size });
    }
  }
  await visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

function titleOf(markdown) {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  return heading ? heading[1].replace(/[*_`]/g, "").trim().slice(0, 160) : "";
}

async function call(endpoint, token, method, path, body, contentType) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(new URL(path, endpoint), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (response.ok) return json;
      if (response.status === 429 || response.status >= 500) {
        lastError = new CliError(json.message ?? `HTTP ${response.status}`);
        const wait = Number(response.headers.get("retry-after") ?? attempt * 2);
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60) * 1000));
        continue;
      }
      throw new CliError(`${json.message ?? `HTTP ${response.status}`}${json.fields ? ` (${json.fields.join(", ")})` : ""}`);
    } catch (error) {
      if (error instanceof CliError && !String(error.message).startsWith("HTTP 5")) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: "string" },
      entry: { type: "string" },
      exclude: { type: "string", multiple: true },
      folder: { type: "string" },
      key: { type: "string" },
      endpoint: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const root = positionals[0];
  if (!(await stat(root)).isDirectory()) throw new CliError(`${root} is not a folder`, 2);
  const { files, skipped } = await walk(root, new Set(values.exclude ?? []));
  if (!files.length) throw new CliError("Nothing to publish in this folder.", 2);
  if (files.length > MAX_FILES)
    throw new CliError(`${files.length} files; a project holds at most ${MAX_FILES}. Use --exclude.`, 2);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL) {
    // Name the heaviest folders, so the caller knows what to --exclude.
    const byFolder = new Map();
    for (const file of files) {
      const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + file.size);
    }
    const heaviest = [...byFolder]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([folder, size]) => `  ${folder} — ${(size / 1048576).toFixed(1)} MB`)
      .join("\n");
    throw new CliError(
      `${(total / 1048576).toFixed(1)} MB; a project holds at most 48 MB. Use --exclude <folder name>. Heaviest folders:\n${heaviest}`,
      2,
    );
  }
  const entry = values.entry ?? ENTRY_ORDER.find((name) => files.some((file) => file.path === name));
  const entryFile = files.find((file) => file.path === entry);
  if (!entryFile || !["text/markdown", "text/html"].includes(entryFile.mime))
    throw new CliError("No README.md, index.md or index.html at the top; pass --entry <path>.", 2);
  for (const file of files) {
    file.bytes = await readFile(file.full);
    file.sha256 = createHash("sha256").update(file.bytes).digest("hex");
  }
  const title =
    values.title ??
    (entryFile.mime === "text/markdown" ? titleOf(entryFile.bytes.toString("utf8")) : "") ??
    "";
  const report = {
    title: title || basename(root.replace(/\/+$/, "")),
    entry,
    files: files.length,
    megabytes: Number((total / 1048576).toFixed(1)),
    skipped,
  };
  if (values["dry-run"]) {
    console.log(JSON.stringify({ ...report, dryRun: true, paths: files.map((file) => file.path) }, null, 2));
    return;
  }
  const token = process.env.POLKA_TOKEN;
  if (!token) throw new CliError("Set POLKA_TOKEN (Полка → Агенты).", 2);
  const endpoint = values.endpoint ?? process.env.POLKA_ENDPOINT;
  if (!endpoint) throw new CliError("Pass --endpoint or set POLKA_ENDPOINT.", 2);
  const manifest = {
    version: 1,
    entrypoint: entry,
    runtime: "project-v1",
    files: files.map(({ path, mime, size, sha256 }) => ({ path, mime, size, sha256 })),
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: new Date().toISOString(),
      attribution: "unknown",
      license: "unknown",
    },
    dependencies: { status: "unknown", unresolved: [] },
  };
  const begun = await call(endpoint, token, "POST", "/api/v1/projects", JSON.stringify({
    key: values.key ?? randomUUID(),
    title: report.title,
    manifest,
    ...(values.folder ? { folderId: values.folder } : {}),
  }), "application/json");
  let receipt = begun.receipt;
  if (!receipt) {
    const byPath = new Map(files.map((file) => [file.path, file]));
    for (const { index, path } of begun.files) {
      await call(endpoint, token, "PUT", `/api/v1/projects/${begun.uploadId}/files/${index}`, byPath.get(path).bytes, "application/octet-stream");
      process.stderr.write(`\r${index + 1}/${begun.files.length} files sent`);
    }
    process.stderr.write("\n");
    receipt = await call(endpoint, token, "POST", `/api/v1/projects/${begun.uploadId}/finalize`, "{}", "application/json");
  }
  const result = { ...report, artifactId: receipt.artifactId, revisionId: receipt.revisionId, shelfUrl: receipt.shelfUrl ?? `${endpoint.replace(/\/$/, "")}/works/${receipt.artifactId}` };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Saved «${result.title}»: ${result.files} files, ${result.megabytes} MB.`);
    console.log(result.shelfUrl);
    if (skipped.length) {
      console.log(`Skipped ${skipped.length}:`);
      for (const item of skipped) console.log(`  ${item.path} — ${item.reason}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof CliError ? error.message : error?.stack ?? String(error));
  process.exitCode = error instanceof CliError ? error.code : 1;
});
