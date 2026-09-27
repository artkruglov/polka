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

export const agentSeenKey = (accountId: string) =>
  `polka:agent-connected:${accountId}`;

/**
 * Whether this browser last saw an agent connected to the shelf: the hero
 * starts in that shape, so the shelf does not jump once the check answers.
 */
export function readAgentSeen(
  accountId: string,
  storage: StorageLike | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(agentSeenKey(accountId)) === "1";
  } catch {
    return false;
  }
}

export function writeAgentSeen(
  accountId: string,
  connected: boolean,
  storage: StorageLike | null = browserStorage(),
) {
  try {
    if (connected) storage?.setItem(agentSeenKey(accountId), "1");
    else storage?.removeItem(agentSeenKey(accountId));
  } catch {
    // A per-browser hint only.
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
