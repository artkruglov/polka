/**
 * One title extractor for uploads and pasted code: the page's own <title>,
 * else its first <h1>. Plain text processing — nothing is parsed or executed,
 * so it also runs in Node tests.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function plain(fragment: string) {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
      const code =
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Titles are limited to 160 characters on the server. */
export const clipTitle = (title: string) =>
  title.length > 160 ? `${title.slice(0, 159).trimEnd()}…` : title;

export function htmlTitle(source: string) {
  // Only the head is needed; never more than the first 256 KiB.
  const head = source.slice(0, 256 * 1024);
  for (const pattern of [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]) {
    const found = pattern.exec(head);
    const title = found ? plain(found[1]) : "";
    if (title) return clipTitle(title);
  }
  return "";
}

/** A title to suggest for an upload: the page's own title for HTML, otherwise the file name. */
export function fallbackTitle(file: File) {
  return clipTitle(file.name.replace(/\.[^.]+$/, "") || file.name);
}

export async function suggestTitle(file: File): Promise<string> {
  const fallback = fallbackTitle(file);
  const html = file.type === "text/html" || /\.html?$/i.test(file.name);
  if (!html) return fallback;
  try {
    return htmlTitle(await file.slice(0, 256 * 1024).text()) || fallback;
  } catch {
    return fallback;
  }
}
