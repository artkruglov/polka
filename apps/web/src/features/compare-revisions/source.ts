import type { Revision } from "../../../../../packages/contracts/index.ts";
import type { BundleExport } from "../../../../../packages/contracts/bundle.ts";

/** The source of one revision as text, or why it cannot be compared. */
export type RevisionSource =
  | { text: string; files: Map<string, string> | null }
  | { unavailable: string };

/** Why a revision cannot be compared line by line before fetching it, if it cannot. */
export function unavailableReason(revision: Revision): string | null {
  if (revision.mime.startsWith("image/") && revision.mime !== "image/svg+xml")
    return `Версия ${revision.number} — изображение. Построчное сравнение доступно для страниц и текста.`;
  if (
    revision.storageKind === "single" &&
    !/^text\/|^application\/(json|xml|javascript)|\+xml$|\+json$/.test(revision.mime)
  )
    return `Версия ${revision.number} — файл (${revision.mime}), а не текст. Построчное сравнение недоступно.`;
  return null;
}

/** UTF-8 text, or null for binary content (a NUL byte or invalid UTF-8). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 65_536).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const fromBase64 = (data: string) =>
  Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

/**
 * Read what the owner downloads (the original, or the bundle export) and
 * pick the text to compare: the file itself, or the bundle's entry point.
 */
export async function readSource(
  revision: Revision,
  download: Blob,
): Promise<RevisionSource> {
  const early = unavailableReason(revision);
  if (early) return { unavailable: early };
  if (revision.storageKind === "bundle") {
    const bundle = JSON.parse(await download.text()) as BundleExport;
    const entry = bundle.files.find(
      (file) => file.path === bundle.manifest.entrypoint,
    );
    const text = entry ? decodeText(fromBase64(entry.data)) : null;
    if (text === null)
      return {
        unavailable: `У версии ${revision.number} нет текстовой главной страницы, сравнить нечего.`,
      };
    return {
      text,
      files: new Map(bundle.files.map((file) => [file.path, file.sha256])),
    };
  }
  const text = decodeText(new Uint8Array(await download.arrayBuffer()));
  return text === null
    ? {
        unavailable: `Версия ${revision.number} не является текстом, построчное сравнение недоступно.`,
      }
    : { text, files: null };
}

/** Which files of a bundle were added, removed or changed between two versions. */
export function fileChanges(
  before: Map<string, string>,
  after: Map<string, string>,
) {
  const added = [...after.keys()].filter((path) => !before.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const changed = [...after.keys()].filter(
    (path) => before.has(path) && before.get(path) !== after.get(path),
  );
  return { added, removed, changed };
}
