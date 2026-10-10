import { canonicalizeManifest, PROJECT_RUNTIME, type BundleManifest } from "../../packages/contracts/bundle.ts";
import { checkBuildInWorker } from "./bundle-derivatives.ts";
import { BUNDLE_BUILDER_VERSION } from "./bundle-runtime-contract.ts";
import { db } from "./db.ts";
import { needsRuntimeBuild } from "./react-runtime.ts";
import { readBlob } from "./storage.ts";

/**
 * Pages of a project that need the runtime (docs/specs/PROJECTS.md): a page
 * with module or JSX scripts, or React, Babel or Tailwind from a CDN, is
 * served compiled — its scripts by the same builder as a single page, with
 * Полка's own copies of the libraries and no network; its styles, images and
 * links stay files of the project. A version never changes, so a build is
 * kept in memory by version, path and builder; a page that does not build is
 * served as stored, and the reason is kept for the agent that saved it.
 */

/** Files a runtime page may read while it is built: its code, styles and data. */
const BUILD_INPUT_MIME = new Set(["text/html", "text/javascript", "text/css", "application/json"]);
const CACHE_BYTES = 64 * 1024 * 1024;

export type ProjectRuntimePage = { ok: true; html: Buffer } | { ok: false; reason: string; path?: string };

const built = new Map<string, ProjectRuntimePage>();
const pending = new Map<string, Promise<ProjectRuntimePage | null>>();
let cachedBytes = 0;

const remember = (key: string, page: ProjectRuntimePage) => {
  const size = page.ok ? page.html.length : 0;
  if (size > CACHE_BYTES) return;
  while (cachedBytes + size > CACHE_BYTES || built.size >= 500) {
    const [oldest, value] = built.entries().next().value!;
    built.delete(oldest);
    cachedBytes -= value.ok ? value.html.length : 0;
  }
  built.set(key, page);
  cachedBytes += size;
};

/**
 * The compiled page at `path` of a project version, or null when the page
 * needs no runtime. `read` returns a file's stored bytes. A builder that was
 * busy or broke is not remembered, so the next view tries again.
 */
export async function projectRuntimePage(
  revisionId: string,
  manifest: BundleManifest,
  path: string,
  read: (path: string) => Promise<Buffer>,
): Promise<ProjectRuntimePage | null> {
  const key = `${BUNDLE_BUILDER_VERSION}:${revisionId}:${path}`;
  const kept = built.get(key);
  if (kept) return kept;
  const running = pending.get(key);
  if (running) return running;
  const page = manifest.files.find((file) => file.path === path);
  if (page?.mime !== "text/html") return null;
  const attempt = (async () => {
    const pageBytes = await read(path);
    const pageManifest = { ...manifest, entrypoint: path, files: [page] };
    // Classified on the page alone first: most pages need no build, and
    // their code files are then never read.
    if (!needsRuntimeBuild(pageManifest, new Map([[path, pageBytes]]))) return null;
    const inputs = manifest.files.filter((file) => file.path === path || BUILD_INPUT_MIME.has(file.mime));
    let canonical: BundleManifest;
    try {
      canonical = canonicalizeManifest({ ...manifest, entrypoint: path, files: inputs });
    } catch {
      return { ok: false as const, reason: "the page's files do not form a valid manifest", path };
    }
    const files = await Promise.all(
      canonical.files.map(async (file) => ({
        path: file.path,
        bytes: file.path === path ? pageBytes : await read(file.path),
      })),
    );
    const result = await checkBuildInWorker(canonical, files, { project: true });
    if (!result.ok && (result.failed || result.busy)) return { ok: false as const, reason: result.reason };
    const outcome: ProjectRuntimePage = result.ok
      ? { ok: true, html: Buffer.from(result.html) }
      : { ok: false, reason: result.reason, path: result.path ?? path };
    remember(key, outcome);
    return outcome;
  })();
  pending.set(key, attempt);
  try {
    return await attempt;
  } finally {
    pending.delete(key);
  }
}

/**
 * Builds every runtime page of a version that was just saved, so the first
 * view is served from memory and the agent learns at once which pages do not
 * build. Returns the pages that failed, by path.
 */
export async function checkProjectRuntimePages(
  revisionId: string,
  manifest: BundleManifest,
  read: (path: string) => Promise<Buffer>,
) {
  const problems: Array<{ path: string; reason: string }> = [];
  for (const file of manifest.files) {
    if (file.mime !== "text/html") continue;
    const page = await projectRuntimePage(revisionId, manifest, file.path, read);
    if (page && !page.ok) problems.push({ path: page.path ?? file.path, reason: page.reason });
  }
  return problems;
}

/**
 * For the agent that just saved a version: the runtime pages of a project
 * that do not build (they are shown as saved, without React), or [] for any
 * other work. Never throws; a check that could not run reports nothing.
 */
export async function runtimePageProblems(revisionId: string) {
  try {
    const {
      rows: [revision],
    } = await db.query("SELECT manifest FROM revisions WHERE id=$1", [revisionId]);
    if (revision?.manifest?.runtime !== PROJECT_RUNTIME) return [];
    const { rows } = await db.query("SELECT path,object_key,object_version FROM revision_files WHERE revision_id=$1", [
      revisionId,
    ]);
    const stored = new Map(rows.map((row) => [row.path as string, row]));
    return await checkProjectRuntimePages(revisionId, revision.manifest, (path) => {
      const file = stored.get(path);
      if (!file) throw new Error(`no stored file ${path}`);
      return readBlob(file.object_key, file.object_version);
    });
  } catch {
    return [];
  }
}

/** A save receipt with `pagesNotBuilt` added when a page of the project does not build. */
export async function withRuntimePages<T extends { revisionId?: unknown }>(receipt: T) {
  if (typeof receipt?.revisionId !== "string") return receipt;
  const problems = await runtimePageProblems(receipt.revisionId);
  return problems.length ? { ...receipt, pagesNotBuilt: problems } : receipt;
}
