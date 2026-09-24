/** Pure helpers about the Полка address; unit-tested in tests/extension-extract.test.ts. */

export const DEFAULT_POLKA_ORIGIN = "https://polochka.app";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The address of the user's Полка: https, or http only on this computer (a
 * local installation). Returns the bare origin or null.
 */
export function normaliseOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin;
  return null;
}

/** The match pattern for host permissions and content scripts of an origin. */
export function matchPattern(origin: string): string {
  const url = new URL(origin);
  // Match patterns carry no port: http://127.0.0.1/* covers every port.
  return `${url.protocol}//${url.hostname}/*`;
}

/** Endpoints from discovery must stay on the Полка origin itself. */
export function sameOrigin(endpoint: unknown, origin: string): string | null {
  if (typeof endpoint !== "string") return null;
  try {
    const url = new URL(endpoint);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}
