import { href as built, placeholder } from "virtual:polka-bookmarklet";

/** Where the bookmark's source lives in the repository (for «код на GitHub»). */
export const BOOKMARKLET_SOURCE_PATH = "extensions/bookmarklet/src/main.ts";
export const BOOKMARKLET_PAGE = "/bookmarklet";

/**
 * The «На Полку» bookmark for this Полка: the built javascript: address with
 * this installation's origin in place of the placeholder. Null for anything
 * that is not a bare http(s) origin.
 */
export function bookmarkletHref(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.origin !== origin || !/^https?:$/.test(url.protocol)) return null;
  } catch {
    return null;
  }
  return built.split(placeholder).join(origin);
}
