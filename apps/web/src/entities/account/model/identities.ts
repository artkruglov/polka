import { request } from "../../../shared/api/client.ts";

/** GET /api/account/identities: the mailbox and the linked sign-in providers. */
export type AccountIdentities = {
  email: string | null;
  identities: Array<{
    provider: "yandex" | "vk" | "oidc";
    name: string;
    email: string | null;
    linkedAt: string;
    lastUsedAt?: string;
  }>;
  available: Array<{ provider: "yandex" | "vk" | "oidc"; name: string }>;
};

export const loadIdentities = (signal?: AbortSignal) =>
  request<AccountIdentities>("/account/identities", undefined, "GET", signal);
