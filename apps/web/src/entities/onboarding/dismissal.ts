/**
 * Whether this viewer hid the first-run checklist. A per-browser convenience,
 * not account state: a private window or blocked storage simply shows the
 * checklist again after a reload.
 */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const dismissalKey = (accountId: string) =>
  `polka:first-run:dismissed:${accountId}`;

const browserStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function readDismissed(
  accountId: string,
  storage: StorageLike | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(dismissalKey(accountId)) === "1";
  } catch {
    return false;
  }
}

/** Returns false when the choice could not be remembered. */
export function writeDismissed(
  accountId: string,
  dismissed: boolean,
  storage: StorageLike | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    if (dismissed) storage.setItem(dismissalKey(accountId), "1");
    else storage.removeItem(dismissalKey(accountId));
    return true;
  } catch {
    return false;
  }
}
