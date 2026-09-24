/**
 * Whether this browser already saw the recipient card on its own (it slides
 * in once per browser) and whether it was dismissed. A per-browser
 * convenience in localStorage: a private window simply sees the card again.
 * The bar's buttons open the card regardless.
 */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const CARD_SHOWN_KEY = "polka:recipient-card:shown";
export const CARD_DISMISSED_KEY = "polka:recipient-card:dismissed";

const browserStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export type CardState = { shown: boolean; dismissed: boolean };

export function readCardState(storage: StorageLike | null = browserStorage()): CardState {
  try {
    return {
      shown: storage?.getItem(CARD_SHOWN_KEY) === "1",
      dismissed: storage?.getItem(CARD_DISMISSED_KEY) === "1",
    };
  } catch {
    return { shown: false, dismissed: false };
  }
}

/** The card opened by itself: it will not again in this browser. */
export function markCardShown(storage: StorageLike | null = browserStorage()): boolean {
  try {
    storage?.setItem(CARD_SHOWN_KEY, "1");
    return !!storage;
  } catch {
    return false;
  }
}

/** Returns false when the choice could not be remembered. */
export function markCardDismissed(
  storage: StorageLike | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(CARD_DISMISSED_KEY, "1");
    storage.setItem(CARD_SHOWN_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Whether the card may open on its own (time or interaction): not if it already did or was dismissed. */
export const mayAutoOpen = (state: CardState) => !state.shown && !state.dismissed;
