import { useEffect, useState } from "react";
import { ApiError, request } from "../../shared/api/client.ts";

type Capabilities = {
  enabled: boolean;
  livePreview?: boolean;
  providerArtifacts: boolean;
};
type State =
  | { status: "loading"; capabilities: null }
  | { status: "failed"; capabilities: null }
  | { status: "ready"; capabilities: Capabilities };

/** A disabled/older installation must never inherit promises from another one. */
export function useImportCapabilities(): State {
  const [state, setState] = useState<State>({
    status: "loading",
    capabilities: null,
  });
  useEffect(() => {
    let current = true;
    request<Capabilities>("/imports/capabilities")
      .then((capabilities) => {
        if (
          typeof capabilities.enabled !== "boolean" ||
          typeof capabilities.providerArtifacts !== "boolean"
        )
          throw new Error("Invalid capabilities");
        if (current) setState({ status: "ready", capabilities });
      })
      .catch((error) => {
        if (!current) return;
        setState(
          error instanceof ApiError && error.status === 404
            ? {
                status: "ready",
                capabilities: { enabled: false, providerArtifacts: false },
              }
            : { status: "failed", capabilities: null },
        );
      });
    return () => {
      current = false;
    };
  }, []);
  return state;
}
