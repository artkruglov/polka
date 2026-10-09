/**
 * A person's publish moves the work's open link as always; an unattended
 * agent (a service account) moves only a link set to follow new versions
 * (docs/specs/DATA_MODELS.md §2). Every path that moves a link asks this.
 */
export function agentMayMoveLink(principal: "human" | "service" | undefined, followMode: "pinned" | "follows") {
  return principal !== "service" || followMode === "follows";
}
