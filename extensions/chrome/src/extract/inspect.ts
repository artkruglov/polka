/*
 * Reading a claude.ai or chatgpt.com page for the artifact on it: which
 * provider, the title, the Copy button or title menu to press (marked with a
 * random data-polka-copy / data-polka-menu attribute), a visible code view.
 * No side effects on import: the extension registers it in page.ts, the
 * bookmarklet (extensions/bookmarklet) calls it directly.
 */
import {
  artifactPanel,
  artifactTitle,
  chatgptSource,
  codeView,
  findArtifactFrames,
  findCopyButton,
  findTitleMenuButton,
} from "./dom.ts";

export type PageReport = {
  provider: "claude" | "chatgpt" | null;
  title: string;
  /** Set when the artifact's Copy button was found and marked. */
  copyMarker: string | null;
  /** Set when the title menu (→ Export → Download) was found and marked. */
  menuMarker: string | null;
  code: { source: string; language: string | null } | null;
  frames: number;
  /** The provider shows its sign-in page instead of the artifact. */
  signIn: boolean;
};

function randomMarker() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inspectPage(doc: Document, host: string, path: string): PageReport {
  const signIn =
    /^\/(login|signin|sign-in|auth)(\/|$)/i.test(path) ||
    (!!doc.querySelector('input[type="email"]') &&
      !doc.querySelector('[data-message-author-role], iframe'));
  if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) {
    const found = chatgptSource(doc);
    return {
      provider: "chatgpt",
      title: found?.title ?? doc.title,
      copyMarker: null,
      menuMarker: null,
      code: found ? { source: found.source, language: found.language } : null,
      frames: 0,
      signIn,
    };
  }
  if (host !== "claude.ai") {
    return { provider: null, title: doc.title, copyMarker: null, menuMarker: null, code: null, frames: 0, signIn: false };
  }
  const frames = findArtifactFrames(doc);
  const panel = frames[0] ? artifactPanel(frames[0]) : null;
  // The Code view, if it is the one showing (no frame, or a code block beside it).
  const code = panel ? codeView(panel) : frames.length ? null : codeView(doc);
  const copy = panel ? findCopyButton(panel) : null;
  let copyMarker: string | null = null;
  if (copy) {
    copyMarker = randomMarker();
    copy.setAttribute("data-polka-copy", copyMarker);
  }
  // A standalone artifact page (claude.ai/artifact/<id>) has no Copy button
  // and no Code tab: its title menu leads to Export → Download.
  // Only there: in a chat the header menu belongs to the conversation.
  const standalone = /^\/(artifact|code\/artifact|public\/artifacts)\//.test(path);
  const menu = copy || !standalone ? null : findTitleMenuButton(doc);
  let menuMarker: string | null = null;
  if (menu) {
    menuMarker = randomMarker();
    menu.setAttribute("data-polka-menu", menuMarker);
  }
  const menuTitle = menu?.textContent?.replace(/\s+/g, " ").trim();
  return {
    provider: "claude",
    title: menuTitle || artifactTitle(doc, panel),
    copyMarker,
    menuMarker,
    code,
    frames: frames.length,
    signIn,
  };
}
