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
 * The steps the viewer takes on its own. The interactive version opens as
 * soon as it can; the owner's page with scripts is prepared once without a
 * click, either to run at all (requiresBuild) or, for a single page the
 * static view cannot show, so that it can be sent by link (buildForLink).
 * A stop, a failed build or a failed launch waits for the reader instead.
 */
export function nextLiveSteps({
  capability,
  requiresBuild,
  buildForLink = false,
  build,
  owner,
  stopped,
  launched,
  prepared,
}: {
  capability: CapabilityState;
  requiresBuild: boolean;
  buildForLink?: boolean;
  build: InlineBuildStatus["state"] | null;
  owner: boolean;
  stopped: boolean;
  launched: boolean;
  prepared: boolean;
}): Array<"launch" | "prepare"> {
  if (!isLive(capability) || stopped) return [];
  const steps: Array<"launch" | "prepare"> = [];
  if ((!requiresBuild || build === "ready") && !launched) steps.push("launch");
  if (
    (requiresBuild || buildForLink) &&
    owner &&
    build === null &&
    !prepared
  )
    steps.push("prepare");
  return steps;
}
