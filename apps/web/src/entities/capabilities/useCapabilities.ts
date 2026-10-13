import { useEffect, useState } from "react";
import { loadRawCapabilities } from "../../shared/api/capabilities.ts";
import { SOURCE_URL } from "../../shared/lib/project-links.ts";

/** Installation capabilities that change what the interface may promise. */
export type InstallationCapabilities = {
  emailLogin: "disabled" | "local" | "smtp";
  /** invite: codes go only to existing accounts and invited addresses. */
  emailSignup: "open" | "invite";
  /** Isolated interactive view of supported pages. */
  livePreview: boolean;
  /** This installation's source code (AGPL-3.0 § 13); a fork sets its own. */
  sourceUrl: string;
  /** External sign-in that is configured here, in button order. */
  signInProviders: SignInProvider[];
  /** An extension's own sign-in (e.g. the company's SSO), after the providers. */
  extensionSignIn: ExtensionSignIn[];
  /** Where a NEW shelf opens by an emailed code: "any" or these domains. */
  emailSignupDomains: "any" | string[];
  /** "signup": existing accounts outside those domains get no code either. */
  emailLoginDomains: "any" | "signup";
  /** on | owner-notes (only the owner writes) | off. */
  commentsMode: "on" | "owner-notes" | "off";
  /** The operator's address for data requests (deleting the shelf), if set. */
  privacyContact: string | null;
  /** Self-service «Удалить аккаунт»; null when this installation keeps it off. */
  accountDeletion: { purge: boolean } | null;
  /** Whose documents /privacy and /terms show. */
  legal: InstallationLegal;
};

/**
 * cloud: polochka.app, its own texts (docs/legal). Anywhere else the
 * operator's documents: their URLs, or a page naming the operator.
 */
export type InstallationLegal = {
  cloud: boolean;
  operatorName: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
};

export type SignInProvider = {
  id: "yandex" | "vk" | "google" | "oidc";
  name: string;
  /**
   * false: this provider signs in only to a shelf it is already linked to
   * (GOOGLE_SIGNUP=link-only): it opens no shelf and claims none.
   */
  signup: boolean;
};

/** A button of an extension: it leads to the extension's route under /api/ext/. */
export type ExtensionSignIn = { id: string; name: string; start: string };

const extensionSignIn = (raw: unknown): ExtensionSignIn[] =>
  Array.isArray(raw)
    ? raw
        .filter(
          (item): item is ExtensionSignIn =>
            !!item &&
            typeof item === "object" &&
            typeof (item as ExtensionSignIn).id === "string" &&
            /^[a-z0-9-]{1,40}$/.test((item as ExtensionSignIn).id) &&
            typeof (item as ExtensionSignIn).name === "string" &&
            typeof (item as ExtensionSignIn).start === "string" &&
            /^\/api\/ext\/[a-z][a-z0-9-]{1,30}\/[\w/.?=&%-]*$/.test((item as ExtensionSignIn).start) &&
            !(item as ExtensionSignIn).start.includes(".."),
        )
        .map((item) => ({ id: item.id, name: item.name.slice(0, 60), start: item.start }))
    : [];

const PROVIDER_IDS = new Set(["yandex", "vk", "google", "oidc"]);

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

export function parseLegal(raw: unknown): InstallationLegal {
  const legal = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = typeof legal.operatorName === "string" ? legal.operatorName.trim().slice(0, 200) : "";
  return {
    cloud: legal.cloud === true,
    operatorName: name || null,
    privacyUrl: httpsUrl(legal.privacyUrl),
    termsUrl: httpsUrl(legal.termsUrl),
  };
}

/** One /capabilities request per page load; a failure is retried by the next consumer. */
export function loadCapabilities() {
  cached ??= loadRawCapabilities()
    .then((raw) => {
      const emailLogin = raw.emailLogin === "local" || raw.emailLogin === "smtp" ? raw.emailLogin : "disabled";
      return {
        emailLogin,
        emailSignup: raw.emailSignup === "invite" ? "invite" : "open",
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
              .map((item) => ({
                id: item.id,
                name: item.name.slice(0, 60),
                signup: (item as { signup?: unknown }).signup !== false,
              }))
          : [],
        extensionSignIn: extensionSignIn(raw.extensionSignIn),
        emailSignupDomains: Array.isArray(raw.emailSignupDomains)
          ? raw.emailSignupDomains.filter((item): item is string => typeof item === "string")
          : "any",
        emailLoginDomains: raw.emailLoginDomains === "signup" ? "signup" : "any",
        commentsMode: raw.commentsMode === "owner-notes" || raw.commentsMode === "off" ? raw.commentsMode : "on",
        privacyContact:
          typeof raw.privacyContact === "string" && /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/.test(raw.privacyContact)
            ? raw.privacyContact
            : null,
        accountDeletion:
          raw.accountDeletion && typeof raw.accountDeletion === "object"
            ? { purge: (raw.accountDeletion as { purge?: unknown }).purge === true }
            : null,
        legal: parseLegal(raw.legal),
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

/**
 * How a shelf can be claimed here, in words, from what this installation
 * offers: «через Яндекс ID, VK ID или по почте», «по почте»… Never names a
 * provider that is not configured.
 */
export function useSignInWays() {
  const state = useCapabilities();
  const names =
    state.status === "ready"
      ? state.capabilities.signInProviders
          .filter((provider) => provider.id !== "oidc" && provider.signup)
          .map((provider) => provider.name)
      : [];
  const email = state.status === "ready" && state.capabilities.emailLogin !== "disabled";
  const list = names.join(", ");
  const via =
    list && email
      ? `через ${list} или по почте`
      : list
        ? `через ${list}`
        : email
          ? "по почте"
          : "способом, который выдал оператор";
  const withWay =
    list && email
      ? `с ${list} или по почте`
      : list
        ? `с ${list}`
        : email
          ? "по почте"
          : "способом, который выдал оператор";
  return { via, with: withWay };
}

/**
 * Where «Политика» and «Соглашение» lead: the operator's own documents when
 * this installation names them (PRIVACY_URL, TERMS_URL), otherwise the site
 * routes, which show what fits this installation (pages/legal).
 */
export function useLegalLinks() {
  const state = useCapabilities();
  const legal = state.status === "ready" ? state.capabilities.legal : null;
  return { privacy: legal?.privacyUrl ?? "/privacy", terms: legal?.termsUrl ?? "/terms" };
}

/** Where the source code of this installation is: upstream until the server says otherwise. */
export function useSourceUrl() {
  const state = useCapabilities();
  return state.status === "ready" ? state.capabilities.sourceUrl : SOURCE_URL;
}
