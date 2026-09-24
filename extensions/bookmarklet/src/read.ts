/*
 * What the bookmark sends: the artifact on a Claude or ChatGPT page, read by
 * the extension's own readers (extensions/chrome/src/extract), or a snapshot
 * of any other AI chat's page. It runs in the page's own JavaScript world,
 * like the extension's MAIN-world functions, and reads only this document:
 * the artifact frame on claude.ai is another origin and stays out of reach.
 */
import type {
  BookmarkletFailure,
  BookmarkletLanguage,
  BookmarkletSource,
} from "../../../packages/contracts/bookmarklet.ts";
import { captureCopy } from "../../chrome/src/extract/copy-capture.ts";
import { captureDownload } from "../../chrome/src/extract/download-capture.ts";
import { inspectPage } from "../../chrome/src/extract/inspect.ts";
import {
  cleanTitle,
  pickBest,
  publishBody,
  type Extracted,
} from "../../chrome/src/shared/payload.ts";

export type Read = { source: BookmarkletSource } | { failure: BookmarkletFailure };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A file name's extension as a language hint: page.jsx → jsx (as save.ts). */
const extensionOf = (name: string | null) =>
  /\.([a-z0-9]+)$/i.exec(name ?? "")?.[1]?.toLowerCase() ?? null;

/** The extension's publish shape, as the bookmark's message. */
function asSource(extracted: Extracted): BookmarkletSource {
  const body = publishBody(extracted, "");
  const language: BookmarkletLanguage =
    "html" in body ? "html" : body.componentLanguage;
  return {
    url: location.href,
    title: body.title,
    kind: "artifact",
    language,
    text: "html" in body ? body.html : body.component,
  };
}

/** Claude or ChatGPT: the extension's order, without the cross-origin frame. */
async function readProvider(): Promise<Read | null> {
  let menuTried = false;
  const deadline = Date.now() + 3000;
  for (;;) {
    const page = inspectPage(document, location.hostname, location.pathname);
    if (page.signIn) return { failure: "sign_in" };
    if (!page.provider) return null;
    const base = { provider: page.provider, title: page.title };
    // The title menu → Export → Download: standalone artifact pages only, once.
    if (page.menuMarker && !menuTried) {
      menuTried = true;
      const capture = await captureDownload(page.menuMarker, 5000);
      if (capture.ok && capture.text.trim())
        return {
          source: asSource({
            ...base,
            source: capture.text,
            language: extensionOf(capture.filename) ?? (capture.type || null),
            via: "download",
          }),
        };
    }
    const candidates: (Extracted | null)[] = [];
    if (page.copyMarker) {
      const copied = await captureCopy(page.copyMarker, 2500);
      if (typeof copied === "string")
        candidates.push({ ...base, source: copied, language: page.code?.language ?? null, via: "copy-button" });
    }
    if (page.code)
      candidates.push({ ...base, source: page.code.source, language: page.code.language, via: "code-view" });
    const best = pickBest(candidates);
    if (best) return { source: asSource(best) };
    if (Date.now() > deadline) return null;
    // The provider's app may still be rendering the artifact.
    await wait(600);
  }
}

/**
 * The page as it is now, without anything that runs: scripts, frames,
 * plugins, inline handlers and javascript: links go; readable stylesheets
 * (including rules CSS-in-JS inserted at run time) are inlined.
 */
export function snapshotDocument(doc: Document): string {
  const copy = doc.documentElement.cloneNode(true) as HTMLElement;
  const sheets = 'style, link[rel~="stylesheet" i]';
  const originals = [...doc.querySelectorAll(sheets)];
  const copies = [...copy.querySelectorAll(sheets)];
  originals.forEach((original, index) => {
    const sheet = (original as HTMLStyleElement | HTMLLinkElement).sheet;
    const clone = copies[index];
    if (!sheet || !clone) return;
    let css: string;
    try {
      css = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
    } catch {
      return; // a cross-origin stylesheet: its rules are not readable
    }
    const style = doc.createElement("style");
    style.textContent = css;
    clone.replaceWith(style);
  });
  for (const node of copy.querySelectorAll(
    'script, noscript, iframe, frame, frameset, object, embed, applet, template, portal, base, meta[http-equiv], link:not([rel~="stylesheet" i]):not([rel~="icon" i])',
  ))
    node.remove();
  for (const node of copy.querySelectorAll("*"))
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        (/^(href|src|action|formaction|xlink:href|srcdoc)$/.test(name) &&
          /^\s*(javascript|vbscript|data:text\/html)/i.test(attribute.value)) ||
        name === "srcdoc"
      )
        node.removeAttribute(attribute.name);
    }
  const head = copy.querySelector("head");
  if (head) {
    const marker = doc.createElement("meta");
    marker.setAttribute("name", "polka-capture");
    marker.setAttribute("content", "snapshot");
    head.prepend(marker);
    if (!head.querySelector("meta[charset]")) {
      const charset = doc.createElement("meta");
      charset.setAttribute("charset", "utf-8");
      head.prepend(charset);
    }
  }
  return `<!doctype html>\n${copy.outerHTML}`;
}

function snapshot(): Read {
  return {
    source: {
      url: location.href,
      title: cleanTitle(document.title) || location.hostname,
      kind: "snapshot",
      language: "html",
      text: snapshotDocument(document),
    },
  };
}

export async function readPage(): Promise<Read> {
  const host = location.hostname;
  const provider = await readProvider();
  if (provider) return provider;
  // Claude: the chat around an artifact is not the artifact. Say so.
  if (host === "claude.ai") return { failure: "not_found" };
  // ChatGPT without a code block, and every other chat: the page itself.
  return snapshot();
}
