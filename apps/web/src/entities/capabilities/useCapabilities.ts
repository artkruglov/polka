import { useEffect, useState } from "react";
import { request } from "../../shared/api/client.ts";

/** Installation capabilities that change what the interface may promise. */
export type InstallationCapabilities = {
  emailLogin: "disabled" | "local" | "smtp";
  /** Server-side import of public HTML pages by URL. */
  urlImport: boolean;
  /** Isolated interactive view of supported pages. */
  livePreview: boolean;
};

export type CapabilitiesState =
  | { status: "loading"; capabilities: null }
  | { status: "failed"; capabilities: null }
  | { status: "ready"; capabilities: InstallationCapabilities };

let cached: Promise<InstallationCapabilities> | null = null;

/** One /capabilities request per page load; a failure is retried by the next consumer. */
export function loadCapabilities() {
  cached ??= request<Record<string, unknown>>("/capabilities")
    .then((raw) => {
      const emailLogin =
        raw.emailLogin === "local" || raw.emailLogin === "smtp"
          ? raw.emailLogin
          : "disabled";
      return {
        emailLogin,
        urlImport: raw.urlImport === true,
        livePreview: raw.liveExperimental === true,
      } satisfies InstallationCapabilities;
    })
    .catch((error) => {
      cached = null;
      throw error;
    });
  return cached;
}

/** Copy and primary actions follow the real installation, never another one's promises. */
export function useCapabilities(): CapabilitiesState {
  const [state, setState] = useState<CapabilitiesState>({
    status: "loading",
    capabilities: null,
  });
  useEffect(() => {
    let live = true;
    loadCapabilities()
      .then((capabilities) => {
        if (live) setState({ status: "ready", capabilities });
      })
      .catch(() => {
        if (live) setState({ status: "failed", capabilities: null });
      });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
