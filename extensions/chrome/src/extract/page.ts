/*
 * Injected on demand (chrome.scripting, isolated world) into the top frame of
 * a claude.ai or chatgpt.com tab when the user asks to save. It only reads the
 * page; the one thing it changes is a data-polka-copy marker on the Copy
 * button, which copy-capture.ts removes when it presses that button.
 */
import {
  artifactPanel,
  artifactTitle,
  chatgptSource,
  codeView,
  findArtifactFrames,
  findCopyButton,
} from "./dom.ts";

export type PageReport = {
  provider: "claude" | "chatgpt" | null;
  title: string;
  /** Set when the artifact's Copy button was found and marked. */
  copyMarker: string | null;
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
      code: found ? { source: found.source, language: found.language } : null,
      frames: 0,
      signIn,
    };
  }
  if (host !== "claude.ai") {
    return { provider: null, title: doc.title, copyMarker: null, code: null, frames: 0, signIn: false };
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
  return {
    provider: "claude",
    title: artifactTitle(doc, panel),
    copyMarker,
    code,
    frames: frames.length,
    signIn,
  };
}

(globalThis as any).__polkaPage = {
  inspect: () => inspectPage(document, location.hostname, location.pathname),
};
