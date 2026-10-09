// Zod-free copies of the comment contract (comments.ts) for the browser's
// initial chunk: the reader's comment bridge and selection button load with
// the workspace. tests/unit.test.ts keeps them equal to comments.ts and the
// guard in step with anchorSchema.

/** A comment body, in characters (code points). */
export const COMMENT_MAX_CHARS = 2000;
/** Context kept on each side of a quote. */
export const ANCHOR_CONTEXT_CHARS = 32;
export const ANCHOR_EXACT_MAX = 2000;
export const REACTIONS = ["👍", "👎", "🎉", "🤔", "❤️", "👀", "✅"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** A quote of the document: what anchorSchema accepts, with defaults filled in. */
export type CommentAnchor = { exact: string; prefix: string; suffix: string };

// Tabs and newlines are text; other control and bidi-override characters
// are not, and could disguise a comment.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
// zod measures strings in UTF-16 code units, as .length does.
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !CONTROL.test(value);

/**
 * anchorSchema.safeParse without zod: the anchor with defaults, or null.
 * Only exact, prefix and suffix are allowed, as the schema is strict.
 */
export function parseCommentAnchor(value: unknown): CommentAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "exact" && key !== "prefix" && key !== "suffix")) return null;
  const { exact, prefix = "", suffix = "" } = record;
  if (!text(exact, ANCHOR_EXACT_MAX) || !exact.length || !exact.trim()) return null;
  if (!text(prefix, ANCHOR_CONTEXT_CHARS * 2) || !text(suffix, ANCHOR_CONTEXT_CHARS * 2)) return null;
  return { exact, prefix, suffix };
}
