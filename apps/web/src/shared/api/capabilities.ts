import { request } from "./client.ts";

let cached: Promise<Record<string, unknown>> | null = null;

/**
 * GET /api/capabilities as the server sends it, once per page for every
 * consumer: the sign-in pages (entities/capabilities parses it), the
 * extensions' loader and the live preview. A failure is not kept: the next
 * caller asks again.
 */
export function loadRawCapabilities(): Promise<Record<string, unknown>> {
  if (!cached) {
    const pending = request<Record<string, unknown>>("/capabilities").catch((error: unknown) => {
      if (cached === pending) cached = null;
      throw error;
    });
    cached = pending;
  }
  return cached;
}
