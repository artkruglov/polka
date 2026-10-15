/**
 * Whether the owner hid the shelf's onboarding block («Скрыть»). Since
 * migration 077 the account holds it (Account.onboardingHiddenAt, set by
 * POST /api/account/onboarding/hide): the server is the source of truth. This
 * browser keeps a copy only so the shelf can start in the right shape, and
 * the copy is what remembers a choice the server has not confirmed yet.
 *
 * The copy holds "1" for a choice made here and not yet on the server (a
 * per-browser «Скрыть» from before 077, or a hide request that failed), or
 * the server's timestamp once it has confirmed.
 */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const dismissalKey = (accountId: string) => `polka:first-run:dismissed:${accountId}`;

/** A choice made in this browser that the server has not recorded yet. */
const UNSYNCED = "1";

const browserStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const readRaw = (accountId: string, storage: StorageLike | null) => {
  try {
    return storage?.getItem(dismissalKey(accountId)) ?? null;
  } catch {
    return null;
  }
};

export function readDismissed(accountId: string, storage: StorageLike | null = browserStorage()): boolean {
  return !!readRaw(accountId, storage);
}

/**
 * The block's first shape on this page load, from the account and this
 * browser's copy. `migrate`: the copy holds a choice the server lacks
 * (UNSYNCED); the caller sends it (POST …/hide). A copy of a confirmed
 * choice that the server no longer has was undone in another browser: the
 * server wins and the copy goes.
 */
export function resolveDismissed(
  accountId: string,
  sessionHiddenAt: string | null | undefined,
  storage: StorageLike | null = browserStorage(),
): { hidden: boolean; migrate: boolean } {
  // The account object is read once per page load; an answer since then is newer.
  const serverHiddenAt = confirmed.has(accountId) ? confirmed.get(accountId) : sessionHiddenAt;
  const local = readRaw(accountId, storage);
  // A server without the field (an older installation): the copy alone.
  if (serverHiddenAt === undefined) return { hidden: !!local, migrate: false };
  if (serverHiddenAt) {
    if (local !== serverHiddenAt) writeDismissed(accountId, true, storage, serverHiddenAt);
    return { hidden: true, migrate: false };
  }
  if (local === UNSYNCED) return { hidden: true, migrate: true };
  if (local) writeDismissed(accountId, false, storage);
  return { hidden: false, migrate: false };
}

/** The server's answers to hide/unhide during this page load, by account. */
const confirmed = new Map<string, string | null>();

/** The server recorded the choice (the answer of POST …/hide or …/unhide). */
export function recordDismissal(
  accountId: string,
  hiddenAt: string | null,
  storage: StorageLike | null = browserStorage(),
) {
  confirmed.set(accountId, hiddenAt);
  writeDismissed(accountId, hiddenAt !== null, storage, hiddenAt ?? undefined);
}

export const agentSeenKey = (accountId: string) => `polka:agent-connected:${accountId}`;

/**
 * Whether this browser last saw an agent connected to the shelf: the hero
 * starts in that shape, so the shelf does not jump once the check answers.
 */
export function readAgentSeen(accountId: string, storage: StorageLike | null = browserStorage()): boolean {
  try {
    return storage?.getItem(agentSeenKey(accountId)) === "1";
  } catch {
    return false;
  }
}

export function writeAgentSeen(accountId: string, connected: boolean, storage: StorageLike | null = browserStorage()) {
  try {
    if (connected) storage?.setItem(agentSeenKey(accountId), "1");
    else storage?.removeItem(agentSeenKey(accountId));
  } catch {
    // A per-browser hint only.
  }
}

/**
 * Returns false when the choice could not be remembered here. `confirmedAt`:
 * the server's timestamp once it has recorded the choice.
 */
export function writeDismissed(
  accountId: string,
  dismissed: boolean,
  storage: StorageLike | null = browserStorage(),
  confirmedAt?: string,
): boolean {
  try {
    if (!storage) return false;
    if (dismissed) storage.setItem(dismissalKey(accountId), confirmedAt || UNSYNCED);
    else storage.removeItem(dismissalKey(accountId));
    return true;
  } catch {
    return false;
  }
}
