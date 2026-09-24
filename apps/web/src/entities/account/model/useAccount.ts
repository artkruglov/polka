import { useEffect, useState } from "react";
import type { Account } from "../../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../../shared/api/client.ts";
import {
  markFreshShelfNote,
  rememberKnownShelf,
} from "../../../shared/lib/known-shelf.ts";

// One /session request per page load, shared by every consumer. A guest is
// a 200 with no account (no 401 in the console on every page); a network or
// server failure is an error, never a silent logout.
let cached: Promise<Account | null> | null = null;
const listeners = new Set<() => void>();

/**
 * A signed-in browser remembers which shelf it is in (shared/lib/known-shelf:
 * the display name and the method, nothing else), so a later sign-in that
 * would open another shelf asks first. A provisional shelf is not a shelf
 * one signs in to, so it leaves no hint.
 */
function remember(account: Account | null) {
  if (!account || account.provisional) return;
  const first = rememberKnownShelf(account.name);
  const created = account.createdAt ? Date.parse(account.createdAt) : NaN;
  if (first && Number.isFinite(created) && Date.now() - created < 30 * 60_000)
    markFreshShelfNote();
}

function loadAccount(): Promise<Account | null> {
  cached ??= client
    .session()
    .then((account) => {
      remember(account);
      return account;
    })
    .catch((error) => {
      if (error instanceof ApiError && error.status === 401) return null;
      cached = null;
      throw error;
    });
  return cached;
}

const notify = () => {
  for (const listener of listeners) listener();
};

/** After login or logout: every mounted consumer sees the new account. */
export function rememberAccount(account: Account | null) {
  cached = Promise.resolve(account);
  notify();
}

export type AccountState = {
  /** undefined while checking or after a failed check; null for a guest. */
  account: Account | null | undefined;
  error: string;
  retry: () => void;
};

export function useAccountState(): AccountState {
  const [state, setState] = useState<{
    account: Account | null | undefined;
    error: string;
  }>({ account: undefined, error: "" });
  useEffect(() => {
    let live = true;
    const read = () =>
      loadAccount().then(
        (account) => live && setState({ account, error: "" }),
        (error: unknown) =>
          live &&
          setState({
            account: undefined,
            error:
              error instanceof Error
                ? error.message
                : "Не удалось проверить вход.",
          }),
      );
    listeners.add(read);
    void read();
    return () => {
      live = false;
      listeners.delete(read);
    };
  }, []);
  // A failed check is not cached, so a retry asks the server again for everyone.
  return { ...state, retry: notify };
}

/** The account alone, for pages that only pass it to navigation. */
export function useAccount() {
  return useAccountState().account;
}
