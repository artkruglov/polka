import React from "react";
import { MessageSquarePlus } from "lucide-react";
import {
  ANCHOR_EXACT_MAX,
  REACTIONS,
  type CommentAnchor,
  type Reaction,
} from "../../../../../packages/contracts/comments.ts";
import type { OverlaySelection } from "./bridge.ts";

/**
 * The floating button under a selection in the document: comment on the
 * fragment, or react to it. Placed in the page's viewport from the rectangle
 * the overlay reported (the frame's offset already added).
 */
export function SelectionButton({
  selection,
  onComment,
  onReact,
  notes = false,
}: {
  /** owner-notes: a note instead of a comment, and no reactions. */
  notes?: boolean;
  selection: OverlaySelection;
  onComment: (anchor: CommentAnchor) => void;
  onReact: (emoji: Reaction, anchor: CommentAnchor) => void;
}) {
  const width = 470;
  const below = selection.rect.bottom + 8;
  const top =
    below + 48 > window.innerHeight
      ? Math.max(8, selection.rect.top - 52)
      : below;
  const left = Math.min(
    Math.max(8, selection.rect.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  const anchor = selection.anchor;
  return (
    <div
      className="selection-button"
      role="toolbar"
      aria-label="Выделенный фрагмент"
      style={{ top, left }}
      // Keep the selection in the frame while pressing.
      onMouseDown={(event) => event.preventDefault()}
    >
      {anchor ? (
        <>
          <button type="button" className="selection-comment" onClick={() => onComment(anchor)}>
            <MessageSquarePlus aria-hidden="true" /> {notes ? "Заметка" : "Комментировать"}
          </button>
          {!notes && <span className="selection-reactions">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Реакция ${emoji}`}
                onClick={() => onReact(emoji, anchor)}
              >
                {emoji}
              </button>
            ))}
          </span>}
        </>
      ) : (
        <span className="selection-too-long">
          Выделите фрагмент короче {ANCHOR_EXACT_MAX} символов
        </span>
      )}
    </div>
  );
}
