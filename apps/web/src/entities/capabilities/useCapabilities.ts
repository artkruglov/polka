import { useEffect, useState } from "react";
import { request } from "../../shared/api/client.ts";
import { SOURCE_URL } from "../../shared/lib/project-links.ts";

/** Installation capabilities that change what the interface may promise. */
export type InstallationCapabilities = {
  emailLogin: "disabled" | "local" | "smtp";
  /** invite: codes go only to existing accounts and invited addresses. */
  emailSignup: "open" | "invite";
  /** Server-side import of public HTML pages by URL. */
  urlImport: boolean;
  /** Isolated interactive view of supported pages. */
  livePreview: boolean;
  /** This installation's source code (AGPL-3.0 § 13); a fork sets its own. */
  sourceUrl: string;
};

export type CapabilitiesState =
  | { status: "loading"; capabilities: null }
  | { status: "failed"; capabilities: null }
  | { status: "ready"; capabilities: InstallationCapabilities };

let cached: Promise<InstallationCapabilities> | null = null;

const httpsUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

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
        emailSignup: raw.emailSignup === "invite" ? "invite" : "open",
        urlImport: raw.urlImport === true,
        livePreview: raw.liveExperimental === true,
        sourceUrl: httpsUrl(raw.sourceUrl) ?? SOURCE_URL,
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

/** Where the source code of this installation is: upstream until the server says otherwise. */
export function useSourceUrl() {
  const state = useCapabilities();
  return state.status === "ready" ? state.capabilities.sourceUrl : SOURCE_URL;
}
