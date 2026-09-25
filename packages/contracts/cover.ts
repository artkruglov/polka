/*
 * Shelf covers (docs/specs/SHELF_COVERS.md). The server reads a saved
 * version once and decides how its card looks:
 *
 *   text    a report, a note, a document: a typographic cover with the
 *           document's own heading and the first lines of its lead;
 *   visual  a dashboard, an app, a colourful page, an image: a picture of the
 *           first screen (rendered once per version by the isolated renderer)
 *           or, until there is one, the image itself.
 *
 * The decision and the extracted text are stored with the version
 * (revision_covers); a card never loads the page itself.
 */

export type CoverKind = "text" | "visual";
/** What the work looks like to its owner; the card names it (coverLabel in the web app). */
export type CoverGenre =
  | "report"
  | "document"
  | "note"
  | "markdown"
  | "dashboard"
  | "app"
  | "page"
  | "image";
/**
 * ready: /api/revisions/:id/cover.jpg answers with a picture;
 * pending: the renderer will draw one soon (ask again);
 * none: the card draws its own cover.
 */
export type CoverImageState = "ready" | "pending" | "none";

export interface RevisionCover {
  kind: CoverKind;
  genre: CoverGenre;
  /** The document's own heading (h1, a Markdown «#», the first line), ≤ 140 characters. */
  heading: string | null;
  /** The first lines after the heading, ≤ 240 characters. */
  lead: string | null;
  /** The page's own dominant colour (#rrggbb), when it has one. */
  accent: string | null;
  image: CoverImageState;
  /** Changes whenever the picture does: the image URL carries it for caching. */
  imageKey: string | null;
}

export const coverImageUrl = (revisionId: string, cover: Pick<RevisionCover, "imageKey">) =>
  `/api/revisions/${revisionId}/cover.jpg?k=${encodeURIComponent(cover.imageKey ?? "")}`;
