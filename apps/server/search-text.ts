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
const PLAIN_WORDS = /^(?=[\s\S]*\p{L}{3})[\p{L}\p{N}\s.,!?—–-]+$/u;
/** Longest string literal read as a phrase (docs/specs/CONTENT_SEARCH.md). */
const MAX_PHRASE = 4096;

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
    // A reader's phrase is short; a long literal is data or a library.
    if (into.full || text.length > MAX_PHRASE) return;
    if (/\p{Script=Cyrillic}/u.test(text)) into.add(text);
    else if (kind === "jsx-text") {
      // Minified code has «>b?c:{» too: in a page's scripts JSX text must read as words.
      if (literals === "phrases" || PLAIN_WORDS.test(text)) into.add(text);
    } else if (
      literals === "phrases" &&
      // Fixed-width letters on each side: the same strings as {2,}, and
      // linear on a long run of letters (no backtracking over it).
      /\p{L}{2}\s+\p{L}{2}/u.test(text) &&
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

// Words as Postgres's parser keeps them: an address (github.com), an e-mail
// or a version (3.14) is one lexeme, so it stays one quoted term. Letters,
// digits and . _ @ - only: no tsquery syntax can get through.
const wordsOf = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._@-]*/gu) ?? [])
    .map((word) => word.replace(/[._@-]+$/, ""))
    .filter(Boolean);
// "…" or «…»; an unclosed quote runs to the end, as in websearch_to_tsquery.
const QUOTES = /["«»„“”]/;

/**
 * A search box as a tsquery: a word is a prefix (`скид` finds «скидки»), a
 * quoted phrase is its words in this order, each a whole word. At most eight
 * words in all; every word and phrase is required. Built here, not by
 * websearch_to_tsquery: that one has no prefixes. Null when there is nothing
 * to search for.
 */
export function searchQuery(q: string): string | null {
  const terms: string[] = [];
  let left = 8;
  q.split(QUOTES).forEach((part, index) => {
    const words = wordsOf(part).slice(0, left);
    left -= words.length;
    if (!words.length) return;
    // Odd parts are inside quotes.
    if (index % 2 === 0) terms.push(...words.map((word) => `'${word}':*`));
    else if (words.length === 1) terms.push(`'${words[0]}'`);
    else terms.push(`(${words.map((word) => `'${word}'`).join(" <-> ")})`);
  });
  return terms.length ? terms.join(" & ") : null;
}

/** The ILIKE pattern of a title search: the query as typed, quotes aside. */
export function titlePattern(q: string): string | null {
  const text = q.split(QUOTES).join(" ").replace(/\s+/g, " ").trim();
  return text ? `%${text.replace(/[\\%_]/g, "\\$&")}%` : null;
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

/**
 * Matches by title ($title, a titlePattern; or the words of $query in any
 * order) or by text ($query, a searchQuery). The text is matched in a
 * subquery the GIN index can serve; a row of artifact_search is always its
 * work's latest version. A title is short and the shelf is one tenant's, so
 * its words are parsed in place, with no index of their own.
 */
export const searchMatch = (artifact: string, title: string, query: string) =>
  `((${title}::text IS NULL AND ${query}::text IS NULL)
    OR ${artifact}.title ILIKE ${title} ESCAPE '\\'
    OR to_tsvector('russian',${artifact}.title) @@ to_tsquery('russian',${query}::text)
    OR ${artifact}.id IN (
      SELECT found.artifact_id FROM artifact_search found
      WHERE ${query}::text IS NOT NULL
        AND found.document @@ to_tsquery('russian',${query}::text)
        AND NOT EXISTS (SELECT 1 FROM moderation_blocks b
                        WHERE b.revision_id=found.revision_id AND b.released_at IS NULL)))`;

/** Text relevance fills the places below one title tier. */
export const SEARCH_RANK_TIER = 1_000_000;

/**
 * How well a work answers a search, as a whole number so a page cursor stays
 * exact (keyset): the title tier (2 the query as typed, 1 its words in any
 * order) times SEARCH_RANK_TIER, plus the text's cover density (ts_rank_cd:
 * found words close together; normalized by the text's length and scaled
 * below one tier). Needs `s` from searchJoin.
 */
export const searchRank = (artifact: string, title: string, query: string) =>
  `((CASE WHEN ${artifact}.title ILIKE ${title} ESCAPE '\\' THEN 2
          WHEN to_tsvector('russian',${artifact}.title) @@ to_tsquery('russian',${query}::text) THEN 1
          ELSE 0 END) * ${SEARCH_RANK_TIER}
    + CASE WHEN s.document @@ to_tsquery('russian',${query}::text)
        THEN 1 + floor(ts_rank_cd(s.document,to_tsquery('russian',${query}::text),1|32)
                       * ${SEARCH_RANK_TIER - 2})::int
        ELSE 0 END)`;

/** The fragment of the text around the found words, when the text matched. */
export const searchSnippet = (query: string, options: string) =>
  `CASE WHEN ${query}::text IS NOT NULL AND s.document @@ to_tsquery('russian',${query}::text)
     THEN ts_headline('russian',s.body,to_tsquery('russian',${query}::text),${options}::text)
   END AS search_snippet`;
