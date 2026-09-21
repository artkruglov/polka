export type LibraryInvitation = { token: string; libraryId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{32,512}$/;

export function parseLibraryInvitation(token: unknown, libraryId: unknown): LibraryInvitation | null {
  if (typeof token !== "string" || typeof libraryId !== "string") return null;
  if (!tokenPattern.test(token) || !uuidPattern.test(libraryId)) return null;
  return { token, libraryId };
}

export function parseLibraryInvitationFragment(fragment: string): LibraryInvitation | null {
  try {
    const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
    return parseLibraryInvitation(params.get("token"), params.get("libraryId"));
  } catch {
    return null;
  }
}
