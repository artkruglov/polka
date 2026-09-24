/*
 * From what was extracted to the body of POST /api/v1/publish
 * (docs/PUBLISH_API.md). Pure: no DOM, no chrome.*; unit-tested in
 * tests/extension-extract.test.ts.
 */
import { htmlTitle, sourceBody } from "../../../../packages/artifact-source.ts";

export type Provider = "claude" | "chatgpt";

/** How a source was obtained, best first. Shown in the result as a hint. */
export type Via =
  | "download"
  | "copy-button"
  | "frame-source"
  | "code-view"
  | "frame-rendered";

export type Extracted = {
  provider: Provider;
  title: string;
  source: string;
  /** A language hint from the page (class="language-tsx", data-language …). */
  language: string | null;
  via: Via;
};

// How a source is read (kind, page around it) is shared with the server's
// ChatGPT import: packages/artifact-source.ts.
export {
  detectKind,
  escapeHtml,
  htmlTitle,
  type SourceKind,
} from "../../../../packages/artifact-source.ts";

export type PublishBody =
  | { key: string; title: string; html: string }
  | {
      key: string;
      title: string;
      component: string;
      componentLanguage: "jsx" | "tsx";
    };

const MAX_TITLE = 160;

/** A tab or header title without the provider's suffix, within API limits. */
export function cleanTitle(value: string | null | undefined): string {
  const title = (value ?? "")
    .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—|\\·]\s*(Claude|ChatGPT)\s*$/i, "")
    .trim();
  if (/^(claude|chatgpt|new chat|новый чат)$/i.test(title)) return "";
  return title.slice(0, MAX_TITLE).trim();
}

export function titleFor(extracted: Extracted): string {
  return (
    cleanTitle(extracted.title) ||
    cleanTitle(htmlTitle(extracted.source)) ||
    (extracted.provider === "chatgpt" ? "Артефакт ChatGPT" : "Артефакт Claude")
  );
}

export function publishBody(extracted: Extracted, key: string): PublishBody {
  const title = titleFor(extracted);
  return { key, title, ...sourceBody(title, extracted.source, extracted.language) };
}

/** Candidates in order of trust; the first non-empty one wins. */
export function pickBest(candidates: (Extracted | null | undefined)[]) {
  const order: Via[] = ["download", "copy-button", "frame-source", "code-view", "frame-rendered"];
  const usable = candidates.filter(
    (item): item is Extracted => !!item && item.source.trim().length > 0,
  );
  usable.sort((a, b) => order.indexOf(a.via) - order.indexOf(b.via));
  return usable[0] ?? null;
}
