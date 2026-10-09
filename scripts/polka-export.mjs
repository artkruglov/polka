#!/usr/bin/env node
// Download your whole Полка shelf into a folder, to move it to another
// installation (docs/specs/SHELF_TRANSFER.md). No dependencies: Node 22+
// (global fetch). The token is read from POLKA_TOKEN only.
//
//   POLKA_TOKEN=… node polka-export.mjs ./polka-export
//
// The folder gets polka-export.json (every work with all its versions) and
// blobs/<sha256> (each file once). Run it again to continue: files already
// there are checked and kept. On the other installation the operator runs
//   npm run shelf:import -- --dir ./polka-export --account <email>
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

// Empty in the repository: the address is required. An installation that
// serves this file (GET /api/v1/cli/polka-export.mjs) fills in its own origin.
const DEFAULT_ENDPOINT = "";
const FORMAT = "polka-shelf-export/1";
const ATTEMPTS = 5;
const TIMEOUT_MS = 180_000;
const VIDEO = /^video\//;
const VIDEO_TIMEOUT_MS = 30 * 60_000;
const STATE_FILE = "polka-export.json";
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARALLEL = 3;

const USAGE = `Usage: polka-export [folder] [options]

Downloads every work on your personal Полка shelf, with all its versions and
the trash, into a folder (by default ./polka-export): ${STATE_FILE} and
blobs/<sha256>. Run it again to continue an interrupted export. Share links
and comments are not exported.

Options:
  --endpoint <url>   Полка address (or $POLKA_ENDPOINT)
  --json             Print the result as JSON
  -h, --help         Show this help

Environment:
  POLKA_TOKEN        Agent token with the scopes read and source:read
                     (Полка → Агенты); never pass it as an argument
  POLKA_ENDPOINT     Полка address, e.g. https://polochka.app`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 60) * 1000));

/**
 * One request with retries on the network, 429 and 5xx; the response when
 * ok. A redirect is refused: the token never goes to another address.
 */
async function request(endpoint, token, path, timeoutMs = TIMEOUT_MS) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS;
    let response;
    try {
      response = await fetch(new URL(path.replace(/^\//, ""), endpoint.replace(/\/?$/, "/")), {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = new CliError(`Network error: ${error?.message ?? error}`);
      if (!last) await sleep(attempt * 2);
      continue;
    }
    if (response.ok) return response;
    if (response.status >= 300 && response.status < 400)
      throw new CliError(`The server redirected the request (HTTP ${response.status}); check --endpoint.`);
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
      if (!last) await sleep(Number(response.headers.get("retry-after")) || attempt * 5);
      continue;
    }
    const error = new CliError(message);
    error.status = response.status;
    throw error;
  }
  throw lastError;
}

/** The SHA-256 and size of a file on disk, read as a stream; null when there is none. */
async function hashOf(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return { sha256: hash.digest("hex"), size: info.size };
}

/** A blob from the response's stream, checked as it arrives, then renamed into place. */
async function writeBlob(target, response, expected) {
  // A random name: a run killed here (same pid in a container next time) leaves no clash.
  const temp = `${target}.part-${randomUUID()}`;
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          size += chunk.length;
          if (size > expected.size) done(new CliError(`A file of ${expected.path} is larger than listed.`));
          else done(null, chunk);
        },
      }),
      createWriteStream(temp, { flags: "wx" }),
    );
    if (size !== expected.size || hash.digest("hex") !== expected.sha256)
      throw new CliError(`${expected.path} arrived damaged; run the command again.`);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Checks one inventory page enough to write files named by it. */
function checkPage(page) {
  if (page?.format !== FORMAT)
    throw new CliError(`Unknown export format ${JSON.stringify(page?.format)}; update polka-export.mjs.`);
  if (!Array.isArray(page.items)) throw new CliError("The inventory page has no items.");
  for (const item of page.items) {
    if (!UUID.test(item.id)) throw new CliError("The inventory has a work without a valid id.");
    for (const revision of item.revisions ?? [])
      for (const file of revision.files ?? [])
        if (!SHA.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0)
          throw new CliError(`The inventory lists a file with an invalid hash or size in «${item.title}».`);
  }
  if (page.nextCursor !== null && !UUID.test(page.nextCursor))
    throw new CliError("The inventory has an invalid cursor.");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length > 1) {
    console.log(USAGE);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const token = process.env.POLKA_TOKEN;
  if (!token) throw new CliError("Set POLKA_TOKEN (Полка → Агенты, scopes read and source:read).", 2);
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

  const root = resolve(positionals[0] ?? "polka-export");
  const blobs = join(root, "blobs");
  for (const dir of [root, blobs]) {
    const info = await lstat(dir).catch(() => null);
    if (info?.isSymbolicLink()) throw new CliError(`${dir} is a link; not writing through it.`);
    if (!info) await mkdir(dir);
    else if (!info.isDirectory()) throw new CliError(`${dir} is not a folder.`);
  }
  // The run's id stays across reruns: the import builds its retry keys from it.
  const earlier = JSON.parse(await readFile(join(root, STATE_FILE), "utf8").catch(() => "null"));
  const exportId = UUID.test(earlier?.exportId ?? "") ? earlier.exportId : randomUUID();

  // 1. The inventory, page by page.
  let first = null;
  const items = [];
  let cursor = null;
  do {
    const page = await (await request(endpoint, token, `/api/v1/export${cursor ? `?cursor=${cursor}` : ""}`)).json();
    checkPage(page);
    first ??= page;
    items.push(...page.items);
    cursor = page.nextCursor;
    if (process.stderr.isTTY) process.stderr.write(`\rInventory: ${items.length} works`);
  } while (cursor);
  if (process.stderr.isTTY) process.stderr.write("\n");

  // 2. Each file once, by its SHA-256, from the first version that has it.
  const wanted = new Map();
  const unavailable = [];
  for (const item of items)
    for (const revision of item.revisions) {
      if (revision.unavailable) {
        unavailable.push({ work: item.title, number: revision.number, reason: revision.unavailable });
        continue;
      }
      for (const file of revision.files)
        if (!wanted.has(file.sha256))
          wanted.set(file.sha256, {
            ...file,
            revisionId: revision.id,
            path: `${item.title} v${revision.number}: ${file.path}`,
          });
    }
  const queue = [...wanted.values()];
  let fetched = 0;
  let kept = 0;
  let done = 0;
  const failed = [];
  async function worker() {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const target = join(blobs, file.sha256);
      const local = await hashOf(target);
      if (local && local.sha256 === file.sha256 && local.size === file.size) kept++;
      else {
        if (local) await rm(target, { force: true });
        try {
          const response = await request(
            endpoint,
            token,
            `/api/v1/export/revisions/${file.revisionId}/files/${file.index}`,
            VIDEO.test(file.mime) ? VIDEO_TIMEOUT_MS : TIMEOUT_MS,
          );
          await writeBlob(target, response, file);
          fetched++;
        } catch (error) {
          failed.push({ file: file.path, error: error?.message ?? String(error) });
        }
      }
      done++;
      if (process.stderr.isTTY) process.stderr.write(`\rFiles: ${done}/${wanted.size}`);
      else if (done % 100 === 0 || done === wanted.size) process.stderr.write(`Files: ${done}/${wanted.size}\n`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (process.stderr.isTTY && wanted.size) process.stderr.write("\n");

  // 3. The inventory last, in one rename: an interrupted run leaves the earlier one.
  const state = {
    format: FORMAT,
    exportId,
    exportedAt: first.exportedAt,
    source: first.source,
    shelf: first.shelf,
    items,
  };
  const temp = join(root, `${STATE_FILE}.part-${randomUUID()}`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  await rename(temp, join(root, STATE_FILE));

  const versions = items.reduce((total, item) => total + item.revisions.length, 0);
  const bytes = [...wanted.values()].reduce((total, file) => total + file.size, 0);
  const result = {
    folder: root,
    exportId,
    works: items.length,
    versions,
    files: wanted.size,
    bytes,
    fetched,
    kept,
    unavailable,
    failed,
  };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Exported ${items.length} works, ${versions} versions, ${wanted.size} files (${(bytes / 1048576).toFixed(1)} MB) into ${root}`,
    );
    if (kept) console.log(`${kept} file(s) were already there and were kept.`);
    if (unavailable.length)
      console.log(
        `${unavailable.length} version(s) are blocked by moderation and were not downloaded; the import skips their works.`,
      );
    if (failed.length)
      console.log(
        `${failed.length} file(s) failed: ${failed
          .slice(0, 5)
          .map((f) => `${f.file} (${f.error})`)
          .join("; ")}. Run the command again.`,
      );
    else console.log("Next, on your installation: npm run shelf:import -- --dir <this folder> --account <email>");
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof CliError ? error.message : (error?.stack ?? String(error)));
  process.exitCode = error instanceof CliError ? error.code : 1;
});
