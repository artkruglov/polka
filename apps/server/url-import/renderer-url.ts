import { isIP } from "node:net";

/**
 * Where the app may send render requests (they carry the user's URL): HTTPS
 * anywhere, plain HTTP only to loopback or a container-network address — an
 * IPv4 literal in Docker's 172.16.0.0/12 or a single-label compose service
 * name like «renderer».
 * No dependencies on config: config.ts validates RENDERER_URL with it.
 */
export function rendererUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4)
    // Docker's default address pools (172.16.0.0/12); a VPC address (10.x) is not a container network.
    return /^(?:127\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  return isIP(host) === 0 && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(host);
}
