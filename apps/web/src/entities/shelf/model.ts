import { useEffect, useState, useSyncExternalStore } from "react";
import {
  client,
  currentShelf,
  rememberShelf,
  type Shelf,
  type ShelfRole,
} from "../../shared/api/client.ts";

// Shelves the account may open (docs/specs/TEAM_SHELVES.md): its own and
// the department shelves it belongs to. One request per page load.
let pending: Promise<{ items: Shelf[]; canCreate: boolean }> | null = null;
export function loadShelves(fresh = false) {
  if (!pending || fresh)
    pending = client.shelves().catch((error) => {
      pending = null;
      throw error;
    });
  return pending;
}

export const ROLE_LABEL: Record<ShelfRole, string> = {
  owner: "Владелец",
  admin: "Администратор",
  curator: "Куратор",
  author: "Автор",
  reader: "Читатель",
};

export const ROLE_HINT: Record<Exclude<ShelfRole, "owner">, string> = {
  reader: "открывает и ищет работы",
  author: "сохраняет работы и меняет свои",
  curator: "меняет любые работы, папки и корзину",
  admin: "всё это и участники полки",
};

const rank: Record<ShelfRole, number> = { reader: 1, author: 2, curator: 3, admin: 4, owner: 5 };
/** The same order the server checks (shelves.ts). */
export const atLeast = (role: ShelfRole, min: ShelfRole) => rank[role] >= rank[min];

export const shelfName = (shelf: Shelf | null) =>
  !shelf || shelf.kind === "personal" ? "Моя полка" : shelf.name ?? "Полка отдела";

// The department shelf this tab shows, once known: what the account may do
// there. Null on one's own shelf (and until the shelves load).
let openTeam: Shelf | null = null;
const listeners = new Set<() => void>();
function publishTeam(next: Shelf | null) {
  openTeam = next;
  for (const listener of listeners) listener();
}
export const useTeamShelf = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openTeam,
    () => null,
  );

/**
 * What the account may do on the open shelf, the server's rules
 * (shelves.ts): on one's own everything; on a department shelf an author
 * saves and changes its own works, a curator any, and folders are a curator's.
 * While a department shelf's role is not known yet, nothing is offered.
 */
export function shelfAccess(team: Shelf | null, accountId: string | undefined) {
  if (!currentShelf()) return { save: true, curate: true, changes: () => true, own: true };
  const role = team?.role ?? "reader";
  return {
    save: !!team && atLeast(role, "author"),
    curate: !!team && atLeast(role, "curator"),
    changes: (author?: { id: string }) =>
      !!team && (atLeast(role, "curator") || (role === "author" && !!accountId && author?.id === accountId)),
    own: false,
  };
}

/** Open a shelf in this tab: the page starts over on it. */
export function switchShelf(id: string | null) {
  rememberShelf(id);
  location.assign(`/?shelf=${id ?? ""}`);
}

/**
 * The open shelf and the others. `current` is null until known; a shelf this
 * tab remembers but may no longer open falls back to the account's own.
 */
export function useShelves(enabled = true) {
  const [state, setState] = useState<{
    items: Shelf[];
    canCreate: boolean;
    current: Shelf | null;
  }>({ items: [], canCreate: false, current: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadShelves()
      .then(({ items, canCreate }) => {
        if (!live) return;
        const wanted = currentShelf();
        const current =
          items.find((shelf) => shelf.id === wanted && shelf.kind === "team") ??
          items.find((shelf) => shelf.kind === "personal") ??
          null;
        if (wanted && current?.id !== wanted) switchShelf(null);
        else {
          setState({ items, canCreate, current });
          if (wanted) publishTeam(current);
        }
      })
      .catch(() => {
        // The switcher stays hidden; the shelf itself reports its own errors.
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}
