import { visitSource } from "../../shared/lib/visit-source.ts";

/** The refs the recipient page's prompt sets before a sign-up (features/recipient-convert). */
export const SHARE_REFS = ["share", "share-remix"] as const;

/**
 * This tab's visit began on someone's shared work: the first-run steps put
 * the agent phrase first, because that is what the person saw being made.
 */
export function arrivedFromShare(source = visitSource()): boolean {
  return !!source?.ref && (SHARE_REFS as readonly string[]).includes(source.ref);
}
