/** A title to suggest for an upload: the page's own <title> for HTML, otherwise the file name. */
export function fallbackTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "") || file.name;
}

export async function suggestTitle(file: File): Promise<string> {
  const fallback = fallbackTitle(file);
  const html = file.type === "text/html" || /\.html?$/i.test(file.name);
  if (!html) return fallback;
  try {
    // Only the head is needed; never more than the first 256 KiB.
    const text = await file.slice(0, 256 * 1024).text();
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (!match) return fallback;
    // DOMParser decodes entities without executing anything.
    const doc = new DOMParser().parseFromString(
      `<title>${match[1]}</title>`,
      "text/html",
    );
    const title = doc.title.replace(/\s+/g, " ").trim();
    return title && title.length <= 200 ? title : fallback;
  } catch {
    return fallback;
  }
}
