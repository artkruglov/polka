#!/usr/bin/env node
// Publish one HTML file or React component to Полка through POST /api/v1/publish
// and print the link.
// No dependencies: Node 22+ (global fetch). The token is read from POLKA_TOKEN only.
//
//   POLKA_ENDPOINT=https://polka.example.com POLKA_TOKEN=… \
//     node polka-publish.mjs report.html --title "Отчёт" --share 7
//   cat report.html | node polka-publish.mjs - --title "Отчёт" --endpoint https://polka.example.com
//   node polka-publish.mjs App.jsx --title "Прототип"            (runs interactively)
//   node polka-publish.mjs App.jsx --artifact <id> --base-revision <revision.id>
//
// See docs/PUBLISH_API.md.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Empty in the repository: the address is required. An installation that
// serves this file (GET /api/v1/cli/polka-publish.mjs) fills in its own origin.
const DEFAULT_ENDPOINT = "";
const ATTEMPTS = 3;
const TIMEOUT_MS = 180_000;

const USAGE = `Usage: polka-publish <file.html|App.jsx|App.tsx|-> [options]

Publishes one self-contained HTML page or one React component to your Полка
shelf and prints the share link. A .jsx/.tsx file is sent as component source:
Полка compiles it and the link opens it interactively. Markdown and text files
are published as preformatted text.

Options:
  --title <text>     Title on the shelf (default: the page <title> or file name)
  --share <days>     Link lifetime: 1, 7 or 30 days (default 30)
  --folder <uuid>    Save into this folder
  --component        Send the file as React component source (default for .jsx/.tsx)
  --artifact <uuid>  Save a new version of this work (with --base-revision);
                     its open link shows the new version
  --base-revision <uuid>  The work's latest revision id
  --key <uuid>       Idempotency key; reuse it only to retry the same publish
  --endpoint <url>   Полка address (required unless $POLKA_ENDPOINT is set${DEFAULT_ENDPOINT ? `; default ${DEFAULT_ENDPOINT}` : ""})
  --json             Print the full JSON response
  -h, --help         Show this help

Environment:
  POLKA_TOKEN        Agent token from Полка → Агенты, or the upload token from
                     polka_project_upload (required; never pass it as an argument)
  POLKA_ENDPOINT     Полка address, e.g. https://polka.example.com (or pass --endpoint)`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

function titleFromHtml(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 262_144));
  const title = match?.[1]
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 160) : "";
}

/** Plain text and Markdown are wrapped into a minimal page, shown as written. */
function asHtml(source, name) {
  const extension = extname(name).toLowerCase();
  if ([".html", ".htm"].includes(extension) || /^\s*</.test(source))
    return source;
  const title = escapeHtml(basename(name, extension) || "Текст");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:40px auto;max-width:760px;padding:0 20px;font:16px/1.6 system-ui,sans-serif}pre{white-space:pre-wrap;word-wrap:break-word;font:inherit}</style></head><body><pre>${escapeHtml(source)}</pre></body></html>`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        title: { type: "string" },
        share: { type: "string" },
        folder: { type: "string" },
        component: { type: "boolean", default: false },
        artifact: { type: "string" },
        "base-revision": { type: "string" },
        key: { type: "string" },
        endpoint: { type: "string" },
        token: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new CliError(`${error.message}\n\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.token !== undefined)
    throw new CliError(
      "Do not pass the token as an argument: it stays in shell history and process lists. Set POLKA_TOKEN instead.",
      2,
    );
  if (positionals.length !== 1)
    throw new CliError(
      `Give exactly one file (or - for stdin).\n\n${USAGE}`,
      2,
    );
  const share = values.share === undefined ? undefined : Number(values.share);
  if (share !== undefined && ![1, 7, 30].includes(share))
    throw new CliError("--share must be 1, 7 or 30 (days).", 2);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const name of ["folder", "key", "artifact", "base-revision"])
    if (values[name] !== undefined && !uuid.test(values[name]))
      throw new CliError(`--${name} must be a UUID.`, 2);
  if ((values.artifact === undefined) !== (values["base-revision"] === undefined))
    throw new CliError("A new version needs both --artifact and --base-revision.", 2);
  if (values.artifact !== undefined && values.folder !== undefined)
    throw new CliError("A new version stays in its folder: drop --folder.", 2);
  const language = /\.tsx$/i.test(positionals[0]) ? "tsx" : "jsx";
  return {
    help: false,
    file: positionals[0],
    component: values.component || /\.[jt]sx$/i.test(positionals[0]),
    language,
    artifactId: values.artifact,
    baseRevisionId: values["base-revision"],
    title: values.title,
    share,
    folderId: values.folder,
    key: values.key,
    endpoint: values.endpoint,
    json: values.json,
  };
}

const retryable = (status) => status === 429 || status >= 500;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The same key on every attempt: a retry returns the first save and link. */
async function post(url, token, body, fetchImpl) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await pause((attempt - 1) * 2_000);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      last = new CliError(`Request failed: ${error.message}`);
      continue;
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 300) };
    }
    if (response.ok) return payload;
    last = new CliError(
      `Полка answered ${response.status}${payload.code ? ` (${payload.code})` : ""}: ${payload.message ?? "no details"}`,
    );
    if (!retryable(response.status)) throw last;
  }
  throw last;
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = readStdin,
  } = {},
) {
  try {
    const options = parse(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const token = env.POLKA_TOKEN?.trim();
    if (!token)
      throw new CliError(
        "Set POLKA_TOKEN to an agent token from Полка → Агенты (for example: read -r -s POLKA_TOKEN && export POLKA_TOKEN).",
        2,
      );
    const address =
      options.endpoint?.trim() || env.POLKA_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
    if (!address)
      throw new CliError(
        "Set POLKA_ENDPOINT or pass --endpoint with your Полка address (for example https://polka.example.com).",
        2,
      );
    let endpoint;
    try {
      endpoint = new URL(address);
    } catch {
      throw new CliError("The endpoint must be a URL such as https://polka.example.com.", 2);
    }
    if (
      endpoint.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      throw new CliError("The endpoint must use https.", 2);
    const source =
      options.file === "-"
        ? await stdin()
        : await readFile(options.file, "utf8").catch((error) => {
            throw new CliError(`Cannot read ${options.file}: ${error.message}`);
          });
    if (!source.trim()) throw new CliError("The file is empty.");
    const name = options.file === "-" ? "stdin.html" : options.file;
    const html = options.component ? null : asHtml(source, name);
    const title =
      options.title?.trim() ||
      (html ? titleFromHtml(html) : "") ||
      basename(name, extname(name)) ||
      "Без названия";
    const key = options.key ?? randomUUID();
    const result = await post(
      new URL("/api/v1/publish", endpoint),
      token,
      {
        key,
        title: title.slice(0, 160),
        ...(html === null
          ? { component: source, componentLanguage: options.language }
          : { html }),
        ...(options.share ? { expiresInDays: options.share } : {}),
        ...(options.folderId ? { folderId: options.folderId } : {}),
        ...(options.artifactId
          ? { artifactId: options.artifactId, baseRevisionId: options.baseRevisionId }
          : {}),
      },
      fetchImpl,
    );
    if (options.json) {
      stdout.write(`${JSON.stringify({ key, ...result }, null, 2)}\n`);
      return 0;
    }
    if (result.url) {
      stdout.write(`${result.url}\n`);
      stderr.write(
        `${result.linkMoved ? "New version saved; the link now shows it" : "Saved and shared"}${result.expiresAt ? ` until ${result.expiresAt}` : ""}. Revision ${result.revisionId}. On your shelf: ${result.shelfUrl}\n`,
      );
    } else {
      stdout.write(`${result.shelfUrl}\n`);
      stderr.write(
        `Saved privately, no link: ${result.linkUnavailableReason ?? "the token cannot manage links"}\n`,
      );
    }
    if (result.moderation)
      stderr.write(
        `Under review (${result.moderation}): ${result.moderationMessage ?? "recipients see a review screen until a Полка moderator approves the link."}\n`,
      );
    if (result.expiresNote) stderr.write(`${result.expiresNote}\n`);
    if (result.interactiveUnavailableReason)
      stderr.write(
        `Scripts will not run: ${result.interactiveUnavailableReason}\n`,
      );
    return 0;
  } catch (error) {
    stderr.write(`polka-publish: ${error.message}\n`);
    return error instanceof CliError ? error.code : 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main();
