/**
 * A sign-up started from a feed material returns to that material by its
 * plain path (`?next=/discover/<slug>`, nothing secret in it). This marker
 * in the tab's sessionStorage tells the page, once, that the load is that
 * return, so it can say the shelf is ready. Shared works use share-return.ts
 * instead, because their token must not ride in a URL.
 */
const KEY = "polka:convert-return";
const TTL_MS = 30 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const tab = (): StorageLike | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

export function rememberConvertReturn(path: string, storage = tab()): boolean {
  try {
    if (!storage || !path.startsWith("/")) return false;
    storage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** True once, when a return to `path` was remembered less than 30 minutes ago. */
export function takeConvertReturn(path: string, storage = tab(), now = Date.now()): boolean {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return false;
    storage!.removeItem(KEY);
    const value = JSON.parse(raw) as { path?: unknown; at?: unknown };
    return (
      value.path === path &&
      typeof value.at === "number" &&
      now - value.at >= 0 &&
      now - value.at < TTL_MS
    );
  } catch {
    return false;
  }
}
