import { request } from "../../../shared/api/client.ts";

type ProviderId = "yandex" | "vk" | "google" | "oidc";

/** GET /api/account/identities: the mailbox and the linked sign-in providers. */
export type AccountIdentities = {
  email: string | null;
  identities: Array<{
    provider: ProviderId;
    name: string;
    email: string | null;
    linkedAt: string;
    lastUsedAt?: string;
  }>;
  /** signup false: the provider only signs in once linked (GOOGLE_SIGNUP). */
  available: Array<{ provider: ProviderId; name: string; signup?: boolean }>;
};

export const loadIdentities = (signal?: AbortSignal) =>
  request<AccountIdentities>("/account/identities", undefined, "GET", signal);
