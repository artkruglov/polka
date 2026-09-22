import { useEffect, useState } from "react";
import { request } from "../../shared/api/client.ts";

/** Installation capabilities that change what the interface may promise. */
export type InstallationCapabilities = {
  emailLogin: "disabled" | "local" | "smtp";
  urlImport: boolean;
  htmlRuntime: boolean;
  identity?: string;
};

export type CapabilitiesState =
  | { status: "loading"; capabilities: null }
  | { status: "failed"; capabilities: null }
  | { status: "ready"; capabilities: InstallationCapabilities };

let cached: Promise<InstallationCapabilities> | null = null;

function load() {
  cached ??= request<Record<string, unknown>>("/capabilities")
    .then((raw) => {
      const emailLogin =
        raw.emailLogin === "local" || raw.emailLogin === "smtp"
          ? raw.emailLogin
          : "disabled";
      return {
        emailLogin,
        urlImport: raw.urlImport === true,
        htmlRuntime: raw.htmlRuntime === true,
        identity: typeof raw.identity === "string" ? raw.identity : undefined,
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
    load()
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
