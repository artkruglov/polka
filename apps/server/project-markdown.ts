// A project's documents as pages (docs/specs/PROJECTS.md): Markdown drawn by
// Полка, never the author's HTML. Links and paths written in backticks that
// name a file of the project become links to it; the rest are marked as
// outside the project. External links go through the signed /away page in a
// new tab. The page runs no script but Полка's own (nav.js).
import { posix } from "node:path";
import { Marked, type Tokens } from "marked";
import { awayHref } from "./away-links.ts";

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/**
 * Where a reference written in `from` points inside the project: relative to
 * the document, then from the project's root, then by a file name that occurs
 * once. Agents write paths all three ways. Null when no file matches.
 */
export function resolveProjectPath(
  paths: ReadonlySet<string>,
  from: string,
  reference: string,
): string | null {
  const clean = reference.trim().replace(/^\.\//, "");
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return null;
  const candidates = [
    posix.normalize(posix.join(posix.dirname(from), clean)),
    posix.normalize(clean.replace(/^\/+/, "")),
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith("..")) continue;
    if (paths.has(candidate)) return candidate;
    // A folder: its index page or README.
    for (const index of ["README.md", "index.md", "index.html"]) {
      const inside = posix.join(candidate, index);
      if (paths.has(inside)) return inside;
    }
  }
  const name = posix.basename(clean);
  const named = [...paths].filter((path) => posix.basename(path) === name);
  return named.length === 1 ? named[0]! : null;
}

/** The href from one project page to another: relative, so the frame follows it. */
export const relativeHref = (from: string, to: string) => {
  const href = posix.relative(posix.dirname(from), to);
  return href.split("/").map(encodeURIComponent).join("/") || encodeURIComponent(posix.basename(to));
};

// A code span that reads as a path: a file name with an extension, or a
// folder path. Not every `word` in backticks is a path.
const PATH_LIKE = /^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\/?$/;
const LOOKS_LIKE_FILE = /\/|\.(?:md|markdown|html?|png|jpe?g|webp|gif|svg|css|js|json|txt)$/i;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

export type ProjectPage = { title: string; body: string };

/** One document of the project as the body of a page, and its title. */
export function renderProjectMarkdown(
  source: string,
  path: string,
  paths: ReadonlySet<string>,
): ProjectPage {
  let title = "";
  const seen = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      // The author's HTML is shown as text, never run or styled.
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
      heading(token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const plain = token.text;
        if (!title && token.depth <= 2) title = plain.replace(/[*_`]/g, "").trim();
        const base = slug(plain) || "section";
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        return `<h${token.depth} id="${escapeHtml(id)}">${inner}</h${token.depth}>\n`;
      },
      codespan(token: Tokens.Codespan) {
        const text = token.text;
        const code = `<code>${escapeHtml(text)}</code>`;
        if (!PATH_LIKE.test(text) || !LOOKS_LIKE_FILE.test(text)) return code;
        const target = resolveProjectPath(paths, path, text);
        return target
          ? `<a class="polka-path" href="${escapeHtml(relativeHref(path, target))}">${code}</a>`
          : `<span class="polka-outside" title="Этого файла нет в проекте">${code}</span>`;
      },
      link(token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const [href, fragment] = splitFragment(token.href);
        if (!href && fragment) return `<a href="#${escapeHtml(fragment)}">${inner}</a>`;
        if (/^https?:\/\//i.test(href))
          return `<a href="${escapeHtml(awayHref(token.href))}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        // The sandbox opens no mail client: the address is shown to copy.
        if (/^mailto:/i.test(href))
          return `<span class="polka-mail" title="${escapeHtml(href.slice(7))}">${inner}</span>`;
        const target = resolveProjectPath(paths, path, href);
        if (!target)
          return `<span class="polka-outside" title="Этого файла нет в проекте">${inner}</span>`;
        const suffix = fragment ? `#${encodeURIComponent(fragment)}` : "";
        return `<a href="${escapeHtml(relativeHref(path, target) + suffix)}">${inner}</a>`;
      },
      image(token: Tokens.Image) {
        const target = resolveProjectPath(paths, path, token.href);
        // Only the project's own pictures: the viewer has no network.
        if (!target) return escapeHtml(token.text ? `[${token.text}]` : "");
        return `<img src="${escapeHtml(relativeHref(path, target))}" alt="${escapeHtml(token.text)}" loading="lazy">`;
      },
    },
  });
  const body = marked.parse(source, { async: false }) as string;
  return { title: title || posix.basename(path), body };
}

// Bounds for drawing a document (marked is quadratic on some inputs, e.g.
// «*a *a *a …»: 48 KB take ~20 s). A small one is drawn at once; a larger
// one in a worker with a deadline; a huge one, or one that runs out of
// time, is shown as plain text. A version is immutable, so each drawn page
// is kept for the next reader.
export const MARKDOWN_INLINE_CHARS = 4 * 1024;
export const MARKDOWN_MAX_CHARS = 512 * 1024;
export const MARKDOWN_DEADLINE_MS = 3_000;
const CACHE_ENTRIES = 300;
const drawn = new Map<string, ProjectPage>();

const plainPage = (source: string, path: string): ProjectPage => ({
  title: posix.basename(path),
  body: `<p class="polka-outside">Документ показан как текст: он слишком большой или сложный для оформления.</p><pre><code>${escapeHtml(source)}</code></pre>`,
});

export async function renderProjectMarkdownBounded(
  source: string,
  path: string,
  paths: ReadonlySet<string>,
  cacheKey: string,
): Promise<ProjectPage> {
  const cached = drawn.get(cacheKey);
  if (cached) {
    drawn.delete(cacheKey);
    drawn.set(cacheKey, cached);
    return cached;
  }
  let page: ProjectPage;
  if (source.length > MARKDOWN_MAX_CHARS) page = plainPage(source, path);
  else if (source.length <= MARKDOWN_INLINE_CHARS)
    page = renderProjectMarkdown(source, path, paths);
  else {
    const { inWorker } = await import("./html.ts");
    page =
      (await inWorker<ProjectPage | null>(
        { source, path, paths: [...paths] },
        MARKDOWN_DEADLINE_MS,
        null,
        new URL("./project-markdown-worker.mjs", import.meta.url),
      )) ?? plainPage(source, path);
  }
  drawn.set(cacheKey, page);
  if (drawn.size > CACHE_ENTRIES) drawn.delete(drawn.keys().next().value!);
  return page;
}

function splitFragment(href: string): [string, string] {
  const at = href.indexOf("#");
  return at === -1 ? [href, ""] : [href.slice(0, at), href.slice(at + 1)];
}

/** A page of Полка around a document: its styles, no author scripts. */
export function projectDocumentPage(page: ProjectPage, navScript: string) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style>${DOCUMENT_CSS}</style>
<script src="${escapeHtml(navScript)}"></script>
</head><body><main class="doc">${page.body}</main></body></html>`;
}

const DOCUMENT_CSS = `
:root{color-scheme:light dark;--ink:#16181d;--muted:#5d6472;--line:#e4e6eb;--soft:#f5f6f8;--accent:#1f4fff}
@media (prefers-color-scheme:dark){:root{--ink:#e9ebf0;--muted:#a3a9b6;--line:#2c3038;--soft:#1b1e24;--accent:#7c9bff}}
*{box-sizing:border-box}
body{margin:0;background:Canvas;color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.doc{max-width:860px;margin:0 auto;padding:40px 32px 80px}
h1,h2,h3,h4{line-height:1.25;letter-spacing:-.01em;margin:1.8em 0 .6em}
h1{font-size:2em;margin-top:0}h2{font-size:1.45em;padding-bottom:.3em;border-bottom:1px solid var(--line)}h3{font-size:1.2em}
p,ul,ol,blockquote,pre,table{margin:0 0 1em}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font:.9em/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:.1em .35em;border-radius:5px}
pre{background:var(--soft);padding:14px 16px;border-radius:10px;overflow:auto}pre code{background:none;padding:0}
a.polka-path code{color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.polka-outside code,.polka-outside{color:var(--muted)}
.polka-mail{border-bottom:1px dotted var(--muted);user-select:all}
.polka-outside code{text-decoration:line-through dotted}
blockquote{margin-left:0;padding:0 16px;border-left:3px solid var(--line);color:var(--muted)}
table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--soft)}
img{max-width:100%;height:auto;border-radius:8px}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
@media (max-width:600px){.doc{padding:24px 16px 56px}}
`;
