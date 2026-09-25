import type { PoolClient } from "pg";
import {
  SEARCH_MATCH_END,
  SEARCH_MATCH_START,
} from "../../packages/contracts/index.ts";
import { scriptStrings } from "./phishing-signals.ts";

/**
 * The text of a work for search (docs/specs/CONTENT_SEARCH.md): what a reader
 * sees, up to SEARCH_TEXT_CHARS. One row per work, for its latest revision.
 */
export const SEARCH_TEXT_CHARS = 60_000;

// ts_headline marks found words with these; they never come from a work.
export const MATCH_START = SEARCH_MATCH_START;
export const MATCH_END = SEARCH_MATCH_END;
const MARKERS = /[\uE000\uE001]/g;

/** Collects pieces of text in order until the limit. */
export class SearchText {
  private readonly parts: string[] = [];
  private chars = 0;

  get full() {
    return this.chars >= SEARCH_TEXT_CHARS;
  }

  add(value: string) {
    if (this.full) return;
    const piece = value.replace(MARKERS, "").replace(/\s+/g, " ").trim();
    if (!piece) return;
    const kept = piece.slice(0, SEARCH_TEXT_CHARS - this.chars);
    this.parts.push(kept);
    this.chars += kept.length + 1;
  }

  value() {
    return this.parts.join(" ").slice(0, SEARCH_TEXT_CHARS);
  }
}

// A class list, a path, an identifier: no Cyrillic and nothing but lowercase
// words joined by -, :, /, ., _ or brackets. Not what a reader sees.
const MACHINE_STRING = /^[a-z0-9\-:/._[\]#%()=,!@ ]*$/;
// Words and ordinary punctuation, one of them three letters or longer.
const PLAIN_WORDS = /^(?=.*\p{L}{3})[\p{L}\p{N}\s.,!?—–-]+$/u;

/**
 * What a script says to a reader: JSX text, and string literals that read as
 * phrases — Cyrillic, or (for a bundle's own source files) several words that
 * are not a class list. A page's inline scripts often carry whole libraries,
 * whose English messages are not the work's text: there only Cyrillic
 * literals count. The same linear pass as the phishing scan (scriptStrings).
 */
export function addScriptText(
  source: string,
  into: SearchText,
  literals: "phrases" | "cyrillic" = "phrases",
) {
  scriptStrings(source, (text, kind) => {
    if (into.full) return;
    if (/\p{Script=Cyrillic}/u.test(text)) into.add(text);
    else if (kind === "jsx-text") {
      // Minified code has «>b?c:{» too: in a page's scripts JSX text must read as words.
      if (literals === "phrases" || PLAIN_WORDS.test(text)) into.add(text);
    } else if (
      literals === "phrases" &&
      /\p{L}{2,}\s+\p{L}{2,}/u.test(text) &&
      !MACHINE_STRING.test(text)
    )
      into.add(text);
  });
}

/**
 * The search row of a work after a new revision: its text, or none (an
 * image, an unread page), which removes the previous revision's text.
 */
export async function indexRevisionText(
  c: PoolClient,
  artifactId: string,
  revisionId: string,
  text: string | null | undefined,
) {
  const body = text?.replace(MARKERS, "").trim().slice(0, SEARCH_TEXT_CHARS);
  if (!body) {
    await c.query("DELETE FROM artifact_search WHERE artifact_id=$1", [
      artifactId,
    ]);
    return;
  }
  await c.query(
    `INSERT INTO artifact_search(artifact_id,revision_id,body) VALUES($1,$2,$3)
     ON CONFLICT (artifact_id) DO UPDATE
       SET revision_id=EXCLUDED.revision_id,body=EXCLUDED.body,indexed_at=now()`,
    [artifactId, revisionId, body],
  );
}

/**
 * A search box's words as a prefix tsquery: letters and digits only (no
 * tsquery syntax can get through), at most eight words, all required.
 * Null when there is nothing to search for.
 */
export function prefixQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return words.length ? words.map((word) => `${word}:*`).join(" & ") : null;
}

/** A fragment for an agent: the found words between «…». */
export function plainSnippet(snippet: string | null | undefined) {
  return snippet
    ? snippet.replaceAll(MATCH_START, "«").replaceAll(MATCH_END, "»")
    : undefined;
}

/** ts_headline's options: one fragment of up to 24 words, found words marked. */
export const HEADLINE_OPTIONS = `MaxFragments=1,MaxWords=24,MinWords=10,ShortWord=2,StartSel="${MATCH_START}",StopSel="${MATCH_END}"`;

/**
 * The search row of a work's latest revision, unless that revision is blocked
 * by moderation: its text neither matches nor shows (`s` in the query).
 */
export const searchJoin = (artifact: string) =>
  `LEFT JOIN artifact_search s ON s.artifact_id=${artifact}.id
     AND s.revision_id=${artifact}.latest_revision_id
     AND NOT EXISTS (SELECT 1 FROM moderation_blocks b
                     WHERE b.revision_id=s.revision_id AND b.released_at IS NULL)`;

/** Matches by title ($title, an ILIKE pattern) or by text ($query, a prefixQuery). */
export const searchMatch = (artifact: string, title: string, query: string) =>
  `(${title}::text IS NULL OR ${artifact}.title ILIKE ${title} ESCAPE '\\'
    OR s.document @@ to_tsquery('russian',${query}::text))`;

/** The fragment of the text around the found words, when the text matched. */
export const searchSnippet = (query: string, options: string) =>
  `CASE WHEN ${query}::text IS NOT NULL AND s.document @@ to_tsquery('russian',${query}::text)
     THEN ts_headline('russian',s.body,to_tsquery('russian',${query}::text),${options}::text)
   END AS search_snippet`;
