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
  /** What that import copies: standalone-html, github-gist, rendered-spa (the renderer is on). */
  urlImportSources: string[];
  /** Isolated interactive view of supported pages. */
  livePreview: boolean;
  /** This installation's source code (AGPL-3.0 § 13); a fork sets its own. */
  sourceUrl: string;
  /** External sign-in that is configured here, in button order. */
  signInProviders: SignInProvider[];
  /** Where a NEW shelf opens by an emailed code: "any" or these domains. */
  emailSignupDomains: "any" | string[];
  /** "signup": existing accounts outside those domains get no code either. */
  emailLoginDomains: "any" | "signup";
  /** on | owner-notes (only the owner writes) | off. */
  commentsMode: "on" | "owner-notes" | "off";
};

export type SignInProvider = { id: "yandex" | "vk" | "oidc"; name: string };

const PROVIDER_IDS = new Set(["yandex", "vk", "oidc"]);

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
        urlImportSources: Array.isArray(raw.urlImportSources)
          ? raw.urlImportSources.filter((x): x is string => typeof x === "string")
          : [],
        livePreview: raw.liveExperimental === true,
        sourceUrl: httpsUrl(raw.sourceUrl) ?? SOURCE_URL,
        signInProviders: Array.isArray(raw.signInProviders)
          ? raw.signInProviders
              .filter(
                (item): item is SignInProvider =>
                  !!item &&
                  typeof item === "object" &&
                  PROVIDER_IDS.has((item as SignInProvider).id) &&
                  typeof (item as SignInProvider).name === "string",
              )
              .map((item) => ({ id: item.id, name: item.name.slice(0, 60) }))
          : [],
        emailSignupDomains: Array.isArray(raw.emailSignupDomains)
          ? raw.emailSignupDomains.filter(
              (item): item is string => typeof item === "string",
            )
          : "any",
        emailLoginDomains: raw.emailLoginDomains === "signup" ? "signup" : "any",
        commentsMode:
          raw.commentsMode === "owner-notes" || raw.commentsMode === "off"
            ? raw.commentsMode
            : "on",
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
