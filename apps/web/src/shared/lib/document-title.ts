import { useEffect } from "react";

/** «<name> — Полка», or «Полка» alone. */
export const pageTitle = (name?: string | null) =>
  name ? `${name} — Полка` : "Полка";

/**
 * The browser tab's title for this page. The server's index.html keeps the
 * generic «Полка» (link previews and /s never name a work); this runs in
 * the browser only. null: «Полка»; undefined: left to a page inside.
 */
export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    if (name !== undefined) document.title = pageTitle(name);
  }, [name]);
}
