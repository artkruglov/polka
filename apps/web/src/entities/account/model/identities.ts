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

let cached: Promise<AccountIdentities> | null = null;

/**
 * One request per page for every consumer (the settings strip and «Способы
 * входа» ask together); `fresh` asks again after a link or unlink. A
 * failure is not kept: the next caller retries.
 */
export function loadIdentities({ fresh = false }: { fresh?: boolean } = {}) {
  if (fresh || !cached) {
    const pending: Promise<AccountIdentities> = request<AccountIdentities>(
      "/account/identities",
      undefined,
      "GET",
    ).catch((error: unknown) => {
      if (cached === pending) cached = null;
      throw error;
    });
    cached = pending;
  }
  return cached;
}
