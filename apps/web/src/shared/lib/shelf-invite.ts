/** An invitation link to a department shelf: its secret and the shelf. */
export type ShelfInvitationLink = { token: string; shelfId: string };

// Stricter than UUID_RE (contracts/uuid.ts): the server issues these as randomUUID (v1–5,
// RFC variant), so a link with any other id is a broken copy, not a shelf to look up.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{32,512}$/;

export function parseShelfInvitation(token: unknown, shelfId: unknown): ShelfInvitationLink | null {
  if (typeof token !== "string" || typeof shelfId !== "string") return null;
  if (!tokenPattern.test(token) || !uuidPattern.test(shelfId)) return null;
  return { token, shelfId };
}

/** The link keeps its secret in the fragment, which never reaches a server. */
export function parseShelfInvitationFragment(fragment: string): ShelfInvitationLink | null {
  try {
    const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
    return parseShelfInvitation(params.get("token"), params.get("shelfId"));
  } catch {
    return null;
  }
}
