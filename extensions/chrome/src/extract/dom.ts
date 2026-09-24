/*
 * Reading an artifact out of the provider's page. Everything here depends on
 * markup that Claude and ChatGPT do not document and change without notice;
 * each selector is a guess modelled on public descriptions of the pages
 * (extensions/chrome/README.md, «Что хрупко»). Every function degrades to
 * null so the caller can try the next source.
 *
 * Tested against synthetic fixtures in a real Chrome:
 * tests/extension-extract.test.ts, tests/fixtures/extension/.
 */

/** The sandboxed frame that renders an artifact on claude.ai. */
export const CLAUDE_FRAME_SELECTORS = [
  "iframe#frame-content",
  'iframe[title="User-generated artifact content" i]',
  // Seen 24.09.2026 on claude.ai/artifact/<id>: https://<uuid>.frame.claudeusercontent.com/_t?…
  'iframe[src*=".frame.claudeusercontent.com"]',
  'iframe[src*=".claudeusercontent.com"]',
  'iframe[src^="https://claudeusercontent.com"]',
];

export function findArtifactFrames(doc: Document): HTMLIFrameElement[] {
  const seen = new Set<HTMLIFrameElement>();
  for (const selector of CLAUDE_FRAME_SELECTORS)
    for (const frame of doc.querySelectorAll<HTMLIFrameElement>(selector))
      seen.add(frame);
  // The largest one is the open artifact; thumbnails and the hidden 1×1
  // helper frame are small and left out.
  // (Unlaid-out frames, area 0, stay: a tab in the background may report so.)
  return [...seen]
    .filter((frame) => area(frame) === 0 || area(frame) >= 100 * 100)
    .sort((a, b) => area(b) - area(a));
}

/**
 * The artifact header's Share button (aria-label "Share, shared with …" on
 * claude.ai/artifact/<id>); the page button goes next to it.
 */
export function findShareButton(root: ParentNode): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>("button[aria-label]")].find((button) =>
      /^(share|поделиться)\b/i.test(button.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

/**
 * The title button of a standalone artifact page: in the header with Share,
 * no aria-label, its text is the title, and it opens the menu with Export.
 */
export function findTitleMenuButton(doc: Document): HTMLElement | null {
  // Base UI's trigger carries data-title-menu (seen 24.09.2026).
  const marked = doc.querySelector<HTMLElement>("button[data-title-menu]");
  if (marked) return marked;
  const share = findShareButton(doc);
  if (!share) return null;
  const titled = (button: HTMLElement) =>
    !button.hasAttribute("aria-label") &&
    (button.textContent ?? "").trim().length > 0;
  // Up from Share to the header that also holds the title button.
  let header: Element | null = share.parentElement;
  for (let depth = 0; header && depth < 6; depth++, header = header.parentElement) {
    const candidates = [...header.querySelectorAll<HTMLElement>("button")].filter(titled);
    if (candidates.length)
      return (
        candidates.find((button) => button.getAttribute("aria-haspopup") === "menu") ??
        candidates[0]
      );
  }
  return null;
}

const area = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.width * rect.height;
};

const labelOf = (element: Element) =>
  [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.textContent,
  ]
    .map((value) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);

const COPY_LABEL = /^(copy|copy code|copy to clipboard|копировать|скопировать|копировать код|скопировать код)$/;

/**
 * The artifact panel around a frame: the nearest ancestor that also holds
 * buttons (the header with Copy, Download, Share …). Null when none within
 * a few levels.
 */
export function artifactPanel(frame: Element): Element | null {
  let node: Element | null = frame.parentElement;
  for (let depth = 0; node && depth < 10; depth++, node = node.parentElement)
    if (node.querySelector("button")) return node;
  return null;
}

/** The artifact's own «Copy» button in its panel header. */
export function findCopyButton(root: ParentNode): HTMLElement | null {
  const buttons = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')];
  return (
    buttons.find((button) =>
      labelOf(button).some(
        (label) =>
          COPY_LABEL.test(label) || /^(artifact-)?copy(-button)?$/.test(label),
      ),
    ) ?? null
  );
}

/** The artifact's title: the panel header, then the tab title. */
export function artifactTitle(doc: Document, panel: Element | null): string {
  const scopes = panel ? [panel] : [];
  for (const scope of scopes) {
    const heading = scope.querySelector(
      '[data-testid*="title" i], h1, h2, h3, header [class*="title" i]',
    );
    const text = heading?.textContent?.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return doc.title;
}

/** CodeMirror 6 keeps one element per line; other viewers use pre/code. */
function codeText(element: Element): string {
  const lines = element.querySelectorAll(".cm-line");
  if (lines.length)
    return [...lines].map((line) => line.textContent ?? "").join("\n");
  return (element as HTMLElement).innerText || element.textContent || "";
}

function languageOf(element: Element): string | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const data = node.getAttribute("data-language");
    if (data) return data;
    const match = /(?:^|\s)language-([\w+-]+)/.exec(node.className || "");
    if (match) return match[1];
    if (node.tagName === "BODY") break;
  }
  return null;
}

/**
 * The source as shown in a «Code» view: the biggest code block under root
 * (a panel), or null.
 */
export function codeView(
  root: ParentNode,
): { source: string; language: string | null } | null {
  const blocks = [
    ...root.querySelectorAll(".cm-content, pre code, pre"),
  ].filter((element) => !(element.tagName === "PRE" && element.querySelector("code")));
  let best: { source: string; language: string | null } | null = null;
  for (const block of blocks) {
    const source = codeText(block).replace(/\u00a0/g, " ");
    if (source.trim() && (!best || source.length > best.source.length))
      best = { source, language: languageOf(block) };
  }
  return best;
}

/** Hosts whose scripts are the provider's viewer, not the artifact. */
const VIEWER_HOSTS = /(^|\.)(claudeusercontent\.com|claude\.ai|claude\.com|anthropic\.com)$/i;

/**
 * An artifact document without the viewer runtime the provider injects:
 * its scripts and styles from the provider's hosts, the CSP meta it adds and
 * elements it marks as its own. What remains is the page the model wrote.
 */
export function cleanArtifactDocument(doc: Document): string {
  const copy = doc.documentElement.cloneNode(true) as HTMLElement;
  const remove = (element: Element) => element.remove();
  for (const element of copy.querySelectorAll("script[src], link[href]")) {
    const address = element.getAttribute("src") ?? element.getAttribute("href") ?? "";
    try {
      if (VIEWER_HOSTS.test(new URL(address, doc.baseURI).hostname)) remove(element);
    } catch {
      /* not a URL: leave it */
    }
  }
  for (const element of copy.querySelectorAll(
    'meta[http-equiv="Content-Security-Policy" i], base, [data-claude-runtime], [data-artifact-runtime], script[id^="__claude" i], style[id^="__claude" i], script[id^="claude-" i], style[id^="claude-" i]',
  ))
    remove(element);
  return `<!doctype html>\n${copy.outerHTML}`;
}

/**
 * A fetched or rendered document that is only the provider's generic
 * renderer (an empty root and scripts), not the artifact itself.
 */
export function looksLikeRuntimeShell(doc: Document): boolean {
  const body = doc.body;
  if (!body) return true;
  const text = (body.textContent ?? "").replace(/\s+/g, "");
  const elements = body.querySelectorAll("*:not(script):not(noscript)").length;
  return text.length === 0 && elements <= 2;
}

/**
 * ChatGPT (experimental): an open canvas/code panel, else the last code block
 * of the last assistant message.
 */
export function chatgptSource(
  doc: Document,
): { source: string; language: string | null; title: string } | null {
  const panel = doc.querySelector(
    '[data-testid*="canvas" i], [data-testid*="textdoc" i], section[aria-label*="canvas" i]',
  );
  if (panel) {
    const code = codeView(panel);
    if (code) {
      const heading = panel.querySelector("h1, h2, h3, [data-testid*=\"title\" i]");
      return { ...code, title: heading?.textContent?.trim() || doc.title };
    }
  }
  const messages = doc.querySelectorAll('[data-message-author-role="assistant"]');
  for (let index = messages.length - 1; index >= 0; index--) {
    const blocks = messages[index].querySelectorAll("pre");
    const last = blocks[blocks.length - 1];
    if (!last) continue;
    const code = last.querySelector("code") ?? last;
    const source = codeText(code);
    if (source.trim()) return { source, language: languageOf(code), title: doc.title };
  }
  return null;
}
