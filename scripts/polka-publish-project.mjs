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
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// Empty in the repository: the address is required. An installation that
// serves this file (GET /api/v1/cli/polka-publish-project.mjs) fills in its own origin.
const DEFAULT_ENDPOINT = "";
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
  --artifact <uuid>  Save a new version of this project (with --base-revision)
  --base-revision <uuid>  The version you started from (from polka_list or the last result)
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
      if (!entry.isFile()) {
        skipped.push({ path, reason: "not a regular file" });
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
  // Полка refuses paths that differ only by case: name them now, not at upload.
  const byCase = new Map();
  const kept = [];
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (byCase.has(key))
      skipped.push({ path: file.path, reason: `differs only by case from ${byCase.get(key)}` });
    else {
      byCase.set(key, file.path);
      kept.push(file);
    }
  }
  return { files: kept, skipped };
}

function titleOf(markdown) {
  // The first heading outside code blocks («# comment» in a shell block is not one).
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const heading = /^#{1,2}\s+(.+)$/.exec(line);
      if (heading) return heading[1].replace(/[*_`]/g, "").trim();
    }
  }
  return "";
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 60) * 1000));
// Retry-After is seconds or an HTTP date.
const retryAfter = (value, fallback) => {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : fallback;
};

async function call(endpoint, token, method, path, body, contentType) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS;
    let response;
    try {
      response = await fetch(new URL(path.replace(/^\//, ""), endpoint.replace(/\/?$/, "/")), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // The network or a timeout: wait a little, then try again.
      lastError = new CliError(`Network error: ${error?.message ?? error}`);
      if (!last) await sleep(attempt * 2);
      continue;
    }
    const text = await response.text();
    // A proxy in front of Полка may answer with HTML (502, 413).
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (response.ok) return json;
    const message = `${json.message ?? `HTTP ${response.status}${text && !json.message ? ` ${text.slice(0, 120).replace(/\s+/g, " ")}` : ""}`}${json.fields ? ` (${json.fields.join(", ")})` : ""}`;
    if (response.status === 429 || response.status >= 500) {
      lastError = new CliError(message);
      if (!last) await sleep(retryAfter(response.headers.get("retry-after"), attempt * 2));
      continue;
    }
    throw new CliError(message);
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
      artifact: { type: "string" },
      "base-revision": { type: "string" },
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
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new CliError(`${root} is not a folder`, 2);
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
    values.title ?? (entryFile.mime === "text/markdown" ? titleOf(entryFile.bytes.toString("utf8")) : "");
  const report = {
    title: (title.trim() || basename(resolve(root))).slice(0, 160),
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
  const endpoint = values.endpoint ?? process.env.POLKA_ENDPOINT ?? (DEFAULT_ENDPOINT || undefined);
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
  if (!!values.artifact !== !!values["base-revision"])
    throw new CliError("A new version needs both --artifact and --base-revision.", 2);
  const key = values.key ?? randomUUID();
  const begun = await call(endpoint, token, "POST", "/api/v1/projects", JSON.stringify({
    key,
    title: report.title,
    manifest,
    ...(values.folder ? { folderId: values.folder } : {}),
    ...(values.artifact ? { artifactId: values.artifact, baseRevisionId: values["base-revision"] } : {}),
  }), "application/json");
  let receipt = begun.receipt;
  // After the upload has begun, a rerun with the same key continues it.
  if (!receipt) try {
    const byPath = new Map(files.map((file) => [file.path, file]));
    // A terminal gets one updating line; an agent's log gets a line now and then.
    let sent = 0;
    const total = begun.files.length;
    for (const { index, path } of begun.files) {
      await call(endpoint, token, "PUT", `/api/v1/projects/${begun.uploadId}/files/${index}`, byPath.get(path).bytes, "application/octet-stream");
      sent++;
      if (process.stderr.isTTY) process.stderr.write(`\r${sent}/${total} files sent`);
      else if (sent % 25 === 0 || sent === total) process.stderr.write(`${sent}/${total} files sent\n`);
    }
    if (process.stderr.isTTY) process.stderr.write("\n");
    receipt = await call(endpoint, token, "POST", `/api/v1/projects/${begun.uploadId}/finalize`, "{}", "application/json");
  } catch (error) {
    if (error instanceof CliError) error.message += `\nRetry with --key ${key} to continue this upload.`;
    throw error;
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
