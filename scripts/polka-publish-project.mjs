#!/usr/bin/env node
// Publish a folder of linked pages to Полка as one project and print where it
// is (docs/specs/PROJECTS.md). No dependencies: Node 22+ (global fetch). The
// token is read from POLKA_TOKEN only.
//
//   POLKA_ENDPOINT=https://polka.example.com POLKA_TOKEN=… \
//     node polka-publish-project.mjs ./Y360-v2 --title "Яндекс 360 + агенты"
//   node polka-publish-project.mjs ./Y360-v2 --dry-run
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";

// Empty in the repository: the address is required. An installation that
// serves this file (GET /api/v1/cli/polka-publish-project.mjs) fills in its own origin.
const DEFAULT_ENDPOINT = "";
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 48 * 1024 * 1024;
// Video (docs/specs/PROJECT_VIDEO.md): apart from the 48 MB of pages, pictures and text.
const MAX_VIDEO_FILE = 200 * 1024 * 1024;
const MAX_VIDEO_TOTAL = 400 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 30 * 60_000;
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
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
const isVideo = (mime) => mime.startsWith("video/");
// Never part of what a reader opens.
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".venv", "venv"]);
const SKIP_FILE = /^\.|\.pyc$/;
// A path segment Полка accepts (packages/contracts/bundle.ts).
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** The address as an origin, so a trailing slash or letter case is not a difference. */
function originOf(address) {
  try {
    return new URL(address).origin;
  } catch {
    return String(address);
  }
}

/** The token travels over https, or to this machine while developing. */
function assertHttps(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new CliError("The endpoint must be a URL such as https://polka.example.com.", 2);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new CliError("The endpoint must use https.", 2);
}

/** .polka.json is a file in the folder, so anyone may have written it: only its shape is trusted, never its words. */
function pulledState(text) {
  if (text === null) return null;
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !state ||
    typeof state !== "object" ||
    !UUID.test(state.artifactId) ||
    !UUID.test(state.revisionId) ||
    typeof state.endpoint !== "string"
  )
    return null;
  return {
    ...state,
    title: String(state.title ?? "")
      .replace(CONTROL, " ")
      .slice(0, 120),
    runtime: typeof state.runtime === "string" ? state.runtime : null,
  };
}
const ENTRY_ORDER = ["README.md", "index.md", "index.html"];
// React source: a project shows files as they are and does not build it, so
// a lone component goes to Полка as a component, which it builds.
const COMPONENT = /\.[jt]sx$/i;
const MAX_COMPONENT = 7_000_000;

const USAGE = `Usage: polka-publish-project <folder> [options]

Publishes a folder of linked pages (Markdown, HTML with its CSS, scripts,
fonts and pictures) to your Полка shelf as one project: a tree of pages with
links between them. Prints the project's address on the shelf.

A folder whose only page is one React component (App.jsx or App.tsx, without
README.md, index.md or index.html) is saved as that component instead: Полка
builds it and it runs. A project takes no .jsx/.tsx files, but its HTML pages
may load React, Babel or Tailwind from a CDN or use <script type=module> (.js
files with JSX): Полка compiles those pages offline with its own copies of the
libraries and names any page it could not compile.

Options:
  --title <text>     Title on the shelf (default: the first heading of README.md or the folder name)
  --entry <path>     Page to open first (default: README.md, index.md or index.html in the folder)
  --exclude <name>   Skip files or folders with this name; repeat for more
  --folder <uuid>    Save into this shelf folder
  --key <uuid>       Idempotency key; reuse it only to retry the same publish
  --artifact <uuid>  Save a new version of this project (with --base-revision)
  --base-revision <uuid>  The version you started from (from polka_list or the last result)
  --new              Save as a new project even if the folder was pulled (.polka.json)
  --endpoint <url>   Полка address (or $POLKA_ENDPOINT)
  --dry-run          List what would be sent and skipped, send nothing
  --json             Print the full JSON result
  -h, --help         Show this help

A folder downloaded with polka-pull.mjs has .polka.json: publishing it saves
the next version of that project (no --artifact needed), sends only the files
that changed (Полка copies the rest) and records the new version there.

Skipped without asking: hidden files, node_modules, __pycache__, .git, *.pyc,
files over 5 MB (video: 200 MB), unsupported types and names outside [A-Za-z0-9._-].

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
  const components = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: "symbolic link" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || exclude.has(entry.name)) continue;
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
      if (COMPONENT.test(entry.name)) components.push({ path, full, size });
      else if (!mime) skipped.push({ path, reason: "unsupported type" });
      else if (
        !path.split("/").every((segment) => SEGMENT.test(segment) && !segment.endsWith(".")) ||
        path.split("/").length > 8 ||
        path.length > 200
      )
        skipped.push({ path, reason: "name outside [A-Za-z0-9._-] or too deep" });
      else if (size > (isVideo(mime) ? MAX_VIDEO_FILE : MAX_FILE))
        skipped.push({ path, reason: `larger than ${isVideo(mime) ? 200 : 5} MB (${(size / 1048576).toFixed(1)} MB)` });
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
    if (byCase.has(key)) skipped.push({ path: file.path, reason: `differs only by case from ${byCase.get(key)}` });
    else {
      byCase.set(key, file.path);
      kept.push(file);
    }
  }
  components.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: kept, skipped, components };
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

/** `stream`: { path, size } sends that file as a stream (a video), never held whole. */
async function call(endpoint, token, method, path, body, contentType, stream) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS;
    let response;
    try {
      response = await fetch(new URL(path.replace(/^\//, ""), endpoint.replace(/\/?$/, "/")), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined || stream ? { "content-type": contentType } : {}),
          ...(stream ? { "content-length": String(stream.size) } : {}),
        },
        body: stream ? Readable.toWeb(createReadStream(stream.path)) : body,
        ...(stream ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(stream ? VIDEO_TIMEOUT_MS : TIMEOUT_MS),
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

/** One component from the folder, through POST /api/v1/publish: Полка builds it. */
async function publishComponent(values, file, skipped) {
  if (file.size > MAX_COMPONENT) throw new CliError(`${file.path} is over 7 MB; a component holds at most 7 MB.`, 2);
  const source = await readFile(file.full, "utf8");
  if (!source.trim()) throw new CliError(`${file.path} is empty.`, 2);
  const report = {
    as: "component",
    title: (values.title?.trim() || basename(file.path, extname(file.path))).slice(0, 160),
    entry: file.path,
    files: 1,
    megabytes: Number((file.size / 1048576).toFixed(1)),
    skipped,
  };
  if (values["dry-run"]) {
    console.log(JSON.stringify({ ...report, dryRun: true, paths: [file.path] }, null, 2));
    return;
  }
  const token = process.env.POLKA_TOKEN;
  if (!token) throw new CliError("Set POLKA_TOKEN (Полка → Агенты).", 2);
  const endpoint = values.endpoint ?? process.env.POLKA_ENDPOINT ?? (DEFAULT_ENDPOINT || undefined);
  if (!endpoint) throw new CliError("Pass --endpoint or set POLKA_ENDPOINT.", 2);
  assertHttps(endpoint);
  if (!!values.artifact !== !!values["base-revision"])
    throw new CliError("A new version needs both --artifact and --base-revision.", 2);
  const key = values.key ?? randomUUID();
  const receipt = await call(
    endpoint,
    token,
    "POST",
    "/api/v1/publish",
    JSON.stringify({
      key,
      title: report.title,
      component: source,
      componentLanguage: /\.tsx$/i.test(file.path) ? "tsx" : "jsx",
      ...(values.folder ? { folderId: values.folder } : {}),
      ...(values.artifact ? { artifactId: values.artifact, baseRevisionId: values["base-revision"] } : {}),
    }),
    "application/json",
  );
  const result = {
    ...report,
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
    shelfUrl: receipt.shelfUrl ?? `${endpoint.replace(/\/$/, "")}/works/${receipt.artifactId}`,
    ...(receipt.url ? { url: receipt.url } : {}),
  };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Saved «${result.title}» as a React component: Полка builds it, and it runs.`);
    console.log(result.url ?? result.shelfUrl);
    if (skipped.length) {
      console.log(`Skipped ${skipped.length}:`);
      for (const item of skipped) console.log(`  ${item.path} — ${item.reason}`);
    }
  }
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
      new: { type: "boolean" },
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
  // A folder from polka-pull.mjs: its next version, unless told otherwise.
  const statePath = join(root, ".polka.json");
  const pulled =
    values.artifact || values.new ? null : pulledState(await readFile(statePath, "utf8").catch(() => null));
  if (pulled) {
    if (pulled.runtime !== "project-v1")
      throw new CliError(
        `This folder holds «${pulled.title}», which is not a project. Publish one page with polka-publish.mjs --artifact ${pulled.artifactId} --base-revision ${pulled.revisionId}, or pass --new to save the folder as a new project.`,
        2,
      );
    values.artifact = pulled.artifactId;
    values["base-revision"] = pulled.revisionId;
  }
  const { files, skipped, components } = await walk(root, new Set(values.exclude ?? []));
  const hasEntry = values.entry
    ? files.some((file) => file.path === values.entry)
    : ENTRY_ORDER.some((name) => files.some((file) => file.path === name));
  const wanted = values.entry && components.find((file) => file.path === values.entry);
  if (pulled && (wanted || (!hasEntry && components.length === 1)))
    throw new CliError(
      "This folder was pulled as a project and now has no page to open, only a React component. Add an index.html, or pass --new to save the component as a new work.",
      2,
    );
  if (wanted || (!hasEntry && components.length === 1))
    return publishComponent(values, wanted || components[0], skipped);
  if (!hasEntry && components.length > 1)
    throw new CliError(
      `This folder is a React app (${components.length} .jsx/.tsx files): a project shows files as they are and does not build React.\n` +
        "  - one self-contained component: pass --entry <file.jsx> to save it as a component, which Полка builds;\n" +
        "  - an app of many files: build it with relative paths (e.g. vite build --base ./) and publish the output folder (dist).",
      2,
    );
  // Beside pages, React source is kept out: a project would not run it.
  for (const file of components)
    skipped.push({ path: file.path, reason: "React source: a project does not build it; save it alone with --entry" });
  if (!files.length) throw new CliError("Nothing to publish in this folder.", 2);
  if (files.length > MAX_FILES)
    throw new CliError(`${files.length} files; a project holds at most ${MAX_FILES}. Use --exclude.`, 2);
  const videoTotal = files.filter((file) => isVideo(file.mime)).reduce((sum, file) => sum + file.size, 0);
  if (videoTotal > MAX_VIDEO_TOTAL)
    throw new CliError(
      `${(videoTotal / 1048576).toFixed(0)} MB of video; a project holds at most 400 MB of it. Use --exclude or shorten the videos.`,
      2,
    );
  const total = files.reduce((sum, file) => sum + file.size, 0) - videoTotal;
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
    if (isVideo(file.mime)) {
      // Hashed as a stream; sent as a stream.
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file.full)) hash.update(chunk);
      file.sha256 = hash.digest("hex");
      continue;
    }
    file.bytes = await readFile(file.full);
    file.sha256 = createHash("sha256").update(file.bytes).digest("hex");
  }
  const title = values.title ?? (entryFile.mime === "text/markdown" ? titleOf(entryFile.bytes.toString("utf8")) : "");
  const report = {
    title: (title.trim() || basename(resolve(root))).slice(0, 160),
    entry,
    files: files.length,
    megabytes: Number(((total + videoTotal) / 1048576).toFixed(1)),
    skipped,
  };
  if (values["dry-run"]) {
    console.log(JSON.stringify({ ...report, dryRun: true, paths: files.map((file) => file.path) }, null, 2));
    return;
  }
  const token = process.env.POLKA_TOKEN;
  if (!token) throw new CliError("Set POLKA_TOKEN (Полка → Агенты).", 2);
  // The token goes only to an address the operator chose; .polka.json is a file
  // in the folder and can come from anyone, so it is checked, never trusted.
  const endpoint = values.endpoint ?? process.env.POLKA_ENDPOINT ?? (DEFAULT_ENDPOINT || undefined);
  if (!endpoint) throw new CliError("Pass --endpoint or set POLKA_ENDPOINT.", 2);
  assertHttps(endpoint);
  if (pulled?.endpoint && originOf(pulled.endpoint) !== originOf(endpoint))
    throw new CliError(
      `This folder was pulled from ${pulled.endpoint}, not ${endpoint}. Pass --new to save it there as a new project.`,
      2,
    );
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
  const begun = await call(
    endpoint,
    token,
    "POST",
    "/api/v1/projects",
    JSON.stringify({
      key,
      title: report.title,
      manifest,
      ...(values.folder ? { folderId: values.folder } : {}),
      ...(values.artifact ? { artifactId: values.artifact, baseRevisionId: values["base-revision"] } : {}),
    }),
    "application/json",
  );
  let receipt = begun.receipt;
  // After the upload has begun, a rerun with the same key continues it.
  if (!receipt)
    try {
      const byPath = new Map(files.map((file) => [file.path, file]));
      // A new version: Полка copies the files the base version already has.
      const reused = new Set(
        values.artifact
          ? ((await call(endpoint, token, "POST", `/api/v1/projects/${begun.uploadId}/reuse`, "{}", "application/json"))
              .reused ?? [])
          : [],
      );
      report.unchanged = reused.size;
      const toSend = begun.files.filter(({ index }) => !reused.has(index));
      // A terminal gets one updating line; an agent's log gets a line now and then.
      let sent = 0;
      const total = toSend.length;
      for (const { index, path } of toSend) {
        const file = byPath.get(path);
        if (isVideo(file.mime)) {
          if (process.stderr.isTTY) process.stderr.write(`\r${path} (${(file.size / 1048576).toFixed(0)} MB)…`);
          await call(
            endpoint,
            token,
            "PUT",
            `/api/v1/projects/${begun.uploadId}/media/${index}`,
            undefined,
            "application/octet-stream",
            { path: file.full, size: file.size },
          );
        } else
          await call(
            endpoint,
            token,
            "PUT",
            `/api/v1/projects/${begun.uploadId}/files/${index}`,
            file.bytes,
            "application/octet-stream",
          );
        sent++;
        if (process.stderr.isTTY) process.stderr.write(`\r${sent}/${total} files sent`);
        else if (sent % 25 === 0 || sent === total) process.stderr.write(`${sent}/${total} files sent\n`);
      }
      if (process.stderr.isTTY) process.stderr.write("\n");
      receipt = await call(
        endpoint,
        token,
        "POST",
        `/api/v1/projects/${begun.uploadId}/finalize`,
        "{}",
        "application/json",
      );
    } catch (error) {
      if (error instanceof CliError) error.message += `\nRetry with --key ${key} to continue this upload.`;
      throw error;
    }
  const result = {
    ...report,
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
    shelfUrl: receipt.shelfUrl ?? `${endpoint.replace(/\/$/, "")}/works/${receipt.artifactId}`,
    ...(receipt.pagesNotBuilt ? { pagesNotBuilt: receipt.pagesNotBuilt } : {}),
  };
  // The pulled folder now holds this version: the next publish builds on it.
  if (pulled)
    await writeFile(
      statePath,
      `${JSON.stringify({ ...pulled, revisionId: receipt.revisionId, number: receipt.number ?? pulled.number, title: report.title, pushedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Saved «${result.title}»: ${result.files} files, ${result.megabytes} MB${result.unchanged ? ` (${result.unchanged} unchanged, copied by Полка)` : ""}.`,
    );
    console.log(result.shelfUrl);
    if (result.pagesNotBuilt?.length) {
      console.log(`Not compiled, shown as saved (${result.pagesNotBuilt.length}):`);
      for (const page of result.pagesNotBuilt) console.log(`  ${page.path} — ${page.reason}`);
    }
    if (skipped.length) {
      console.log(`Skipped ${skipped.length}:`);
      for (const item of skipped) console.log(`  ${item.path} — ${item.reason}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof CliError ? error.message : (error?.stack ?? String(error)));
  process.exitCode = error instanceof CliError ? error.code : 1;
});
