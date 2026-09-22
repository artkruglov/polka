import type {
  InlineBuildStatus,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import { isStaticSingleFileBundle } from "../../entities/artifact/format.ts";

export type LiveMode = "local" | "staging" | "production";
export type CapabilityState = LiveMode | "loading" | "disabled" | "error";

export const isLive = (state: CapabilityState): state is LiveMode =>
  state === "local" || state === "staging" || state === "production";

/**
 * How the interactive viewer relates to a saved page: "none" when there is
 * nothing to run (a script-free page), "direct" when the saved page runs as
 * is, "build" when it needs a prepared interactive version first.
 */
export function liveKind(revision: Revision): "none" | "direct" | "build" {
  if (revision.storageKind === "bundle")
    return isStaticSingleFileBundle(revision) &&
      revision.htmlProfile === "static"
      ? "none"
      : "build";
  if (revision.mime !== "text/html" || revision.htmlProfile === "static")
    return "none";
  return "direct";
}

/**
 * The step the viewer takes on its own. The interactive version opens as soon
 * as it can; the owner's page with scripts is prepared once without a click.
 * A stop, a failed build or a failed launch waits for the reader instead.
 */
export function nextLiveStep({
  capability,
  requiresBuild,
  build,
  owner,
  stopped,
  launched,
  prepared,
}: {
  capability: CapabilityState;
  requiresBuild: boolean;
  build: InlineBuildStatus["state"] | null;
  owner: boolean;
  stopped: boolean;
  launched: boolean;
  prepared: boolean;
}): "launch" | "prepare" | null {
  if (!isLive(capability) || stopped) return null;
  if (!requiresBuild || build === "ready") return launched ? null : "launch";
  if (owner && build === null && !prepared) return "prepare";
  return null;
}
