/*
 * Injected on demand into every frame of the tab; answers only inside the
 * artifact sandbox on *.claudeusercontent.com. The artifact's page is this
 * frame's document: first it asks its own origin for the document's bytes
 * again (the page as the model wrote it, before its scripts ran), else it
 * serialises the live document. Either way the provider's viewer runtime is
 * removed (dom.ts, cleanArtifactDocument).
 */
import { cleanArtifactDocument, looksLikeRuntimeShell } from "./dom.ts";

export type FrameReport = {
  html: string;
  title: string;
  via: "frame-source" | "frame-rendered";
};

const ARTIFACT_HOST = /(^|\.)claudeusercontent\.com$/i;

export async function extractFrame(options: {
  anyHost?: boolean;
} = {}): Promise<FrameReport | null> {
  if (!options.anyHost && !ARTIFACT_HOST.test(location.hostname)) return null;
  if (window === window.top && !options.anyHost) return null;
  // The hidden 1×1 helper frame next to the artifact is not it.
  if (!options.anyHost && window.innerWidth * window.innerHeight < 100 * 100) return null;
  try {
    const response = await fetch(location.href, {
      credentials: "include",
      cache: "force-cache",
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && /text\/html/i.test(type)) {
      const parsed = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      if (!looksLikeRuntimeShell(parsed))
        return {
          html: cleanArtifactDocument(parsed),
          title: parsed.title,
          via: "frame-source",
        };
    }
  } catch {
    /* sandboxed (opaque origin) frames cannot fetch their own URL */
  }
  if (looksLikeRuntimeShell(document)) return null;
  return {
    html: cleanArtifactDocument(document),
    title: document.title,
    via: "frame-rendered",
  };
}

(globalThis as any).__polkaFrame = { extract: extractFrame };
