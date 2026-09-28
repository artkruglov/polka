#!/usr/bin/env node
// Download a saved version of a work from Полка into a folder (polka pull,
// docs/PUBLISH_API.md). No dependencies: Node 22+ (global fetch). The token is
// read from POLKA_TOKEN only.
//
//   POLKA_TOKEN=… node polka-pull.mjs <artifactId> ./Y360-v2
//
// The folder gets .polka.json with the work and the version it holds, so
// `polka-publish-project.mjs ./Y360-v2` later saves the next version of that
// work and sends only the files that changed.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// Empty in the repository: the address is required. An installation that
// serves this file (GET /api/v1/cli/polka-pull.mjs) fills in its own origin.
const DEFAULT_ENDPOINT = "";
const ATTEMPTS = 3;
const TIMEOUT_MS = 180_000;
const STATE_FILE = ".polka.json";
// A path segment Полка accepts (packages/contracts/bundle.ts): no leading dot,
// so nothing like .git/hooks or .polka.json can arrive from a manifest.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const USAGE = `Usage: polka-pull <artifactId | work address> [folder] [options]

Downloads a version of a work on your Полка shelf into a folder (by default
the latest version, into ./polka-<id>) and records it in <folder>/${STATE_FILE}.
Publishing that folder with polka-publish-project.mjs afterwards saves the
next version of the same project and sends only the files that changed.

Options:
  --revision <uuid>  Download this version instead of the latest
  --force            Write into a folder that already has files (never deletes any;
                     files that differ from the version are replaced and listed)
  --endpoint <url>   Полка address (or $POLKA_ENDPOINT)
  --json             Print the result as JSON
  -h, --help         Show this help

Environment:
  POLKA_TOKEN        Agent token with source:read (Полка → Агенты, or the one
                     polka_project_upload returns); never pass it as an argument
  POLKA_ENDPOINT     Полка address, e.g. https://polka.example.com`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Writes a file inside root without following a link: every folder on the way, and the file, must be what this run made or a plain one. */
async function safeWrite(root, target, bytes) {
  const parts = target.slice(root.length + 1).split(sep);
  let at = root;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (info?.isSymbolicLink()) throw new CliError(`${at} is a link; not writing through it.`);
    if (index < parts.length - 1) {
      if (!info) await mkdir(at);
      else if (!info.isDirectory()) throw new CliError(`${at} is a file, not a folder.`);
    } else if (info && !info.isFile()) throw new CliError(`${at} is not a plain file.`);
  }
  // Renamed over the target: a link that appears meanwhile is replaced, not followed.
  const temp = `${target}.polka-${process.pid}`;
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 60) * 1000));

/** One request with retries on the network, 429 and 5xx; the response when ok. */
async function request(endpoint, token, path) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS;
    let response;
    try {
      response = await fetch(new URL(path.replace(/^\//, ""), endpoint.replace(/\/?$/, "/")), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new CliError(`Network error: ${error?.message ?? error}`);
      if (!last) await sleep(attempt * 2);
      continue;
    }
    if (response.ok) return response;
    const text = await response.text();
    let message;
    try {
      message = JSON.parse(text).message;
    } catch {
      message = undefined;
    }
    message ??= `HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) {
      lastError = new CliError(message);
      if (!last) await sleep(Number(response.headers.get("retry-after")) || attempt * 2);
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
      revision: { type: "string" },
      force: { type: "boolean" },
      endpoint: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length < 1 || positionals.length > 2) {
    console.log(USAGE);
    if (!values.help) process.exitCode = 2;
    return;
  }
  // An id, or the work's address on the shelf (…/works/<id>).
  const artifactId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:[?#].*)?$/i.exec(positionals[0])?.[1];
  if (!artifactId) throw new CliError(`${positionals[0]} is not a work id or a work address.`, 2);
  const token = process.env.POLKA_TOKEN;
  if (!token) throw new CliError("Set POLKA_TOKEN (Полка → Агенты).", 2);
  const endpoint = values.endpoint ?? process.env.POLKA_ENDPOINT ?? (DEFAULT_ENDPOINT || undefined);
  if (!endpoint) throw new CliError("Pass --endpoint or set POLKA_ENDPOINT.", 2);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CliError("The endpoint must be a URL such as https://polka.example.com.", 2);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new CliError("The endpoint must use https.", 2);
  const root = resolve(positionals[1] ?? `polka-${artifactId.slice(0, 8)}`);
  const existing = await readdir(root).catch(() => []);
  if (existing.length && !values.force)
    throw new CliError(`${root} is not empty. Pass --force to write into it (nothing there is deleted).`, 2);

  const query = values.revision ? `?revisionId=${encodeURIComponent(values.revision)}` : "";
  const version = await (await request(endpoint, token, `/api/v1/works/${artifactId}/files${query}`)).json();
  // Paths come from Полка's manifest; still, nothing is written outside the folder.
  const targets = version.files.map((file) => {
    const segments = String(file.path).split("/");
    if (!segments.every((segment) => SEGMENT.test(segment)))
      throw new CliError(`Unsafe path in the version: ${file.path}`);
    const target = resolve(root, ...segments);
    if (!target.startsWith(root + sep)) throw new CliError(`Unsafe path in the version: ${file.path}`);
    return { ...file, target };
  });
  await mkdir(root, { recursive: true });
  const overwritten = [];
  let done = 0;
  for (const file of targets) {
    const response = await request(
      endpoint,
      token,
      `/api/v1/works/${artifactId}/revisions/${version.revisionId}/files/${file.index}`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new CliError(`${file.path} arrived damaged; run the command again.`);
    const local = await readFile(file.target).catch(() => null);
    if (local && !local.equals(bytes)) overwritten.push(file.path);
    await safeWrite(root, file.target, bytes);
    done++;
    if (process.stderr.isTTY) process.stderr.write(`\r${done}/${targets.length} files`);
    else if (done % 25 === 0 || done === targets.length) process.stderr.write(`${done}/${targets.length} files\n`);
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  const state = {
    endpoint: endpoint.replace(/\/$/, ""),
    artifactId,
    revisionId: version.revisionId,
    number: version.number,
    title: version.title,
    runtime: version.runtime,
    pulledAt: new Date().toISOString(),
  };
  await safeWrite(root, join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  const result = {
    ...state,
    folder: root,
    files: targets.length,
    overwritten,
    latest: version.revisionId === version.latestRevisionId,
  };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Pulled «${version.title}» v${version.number}: ${targets.length} files into ${root}`);
    if (overwritten.length)
      console.log(`Replaced ${overwritten.length} local file(s) that differed: ${overwritten.slice(0, 10).join(", ")}${overwritten.length > 10 ? ", …" : ""}`);
    if (!result.latest) console.log("This is not the latest version: a new version made from it would be refused.");
    if (version.runtime === "project-v1")
      console.log("Change the files, then publish the folder with polka-publish-project.mjs: it saves the next version.");
  }
}

main().catch((error) => {
  console.error(error instanceof CliError ? error.message : error?.stack ?? String(error));
  process.exitCode = error instanceof CliError ? error.code : 1;
});
