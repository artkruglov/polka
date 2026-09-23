import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { withAwayLinks } from "./html.ts";

// External links in the static view go through APP_ORIGIN/away#<token>, a
// page that names the destination and waits for a click. The token is signed
// so /away shows only addresses Полка itself put there: without the signature
// it would be a warning page anyone could point at any site with Полка's name
// on it. The page never redirects on its own.

/** How long a link in a served page stays usable. */
export const AWAY_LINK_TTL_SECONDS = 12 * 60 * 60;
/** Longer addresses are not signed; their link opens the refusal. */
export const AWAY_URL_MAX_LENGTH = 4096;
const TOKEN = /^([A-Za-z0-9_-]{1,16384})\.([A-Za-z0-9_-]{43})$/;

// A key of its own, derived from LINK_KEY: a MAC made for any other purpose
// never verifies here, and this one verifies nowhere else.
const key = createHmac("sha256", config.LINK_KEY)
  .update("polka:away-link:v1")
  .digest();
const mac = (payload: string) =>
  createHmac("sha256", key).update(payload).digest();

const httpUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > AWAY_URL_MAX_LENGTH)
    return null;
  try {
    const url = new URL(value);
    // Only the canonical form that was signed; no credentials to confuse the
    // host shown on the page.
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.href !== value ||
      url.username ||
      url.password
    )
      return null;
    return url;
  } catch {
    return null;
  }
};

export function signAwayUrl(url: string, now = Date.now()) {
  if (!httpUrl(url)) return null;
  const payload = Buffer.from(
    JSON.stringify({
      u: url,
      e: Math.floor(now / 1000) + AWAY_LINK_TTL_SECONDS,
    }),
  ).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
}

/** The href that replaces an external link: signed, or the refusal. */
export const awayHref = (url: string, now = Date.now()) => {
  const token = signAwayUrl(url, now);
  return `${config.APP_ORIGIN}/away${token ? `#${token}` : ""}`;
};

export function verifyAwayToken(token: unknown, now = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = TOKEN.exec(token);
  if (!parts) return null;
  const expected = mac(parts[1]!);
  const given = Buffer.from(parts[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let claims: { u?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims?.e !== "number" || claims.e * 1000 <= now) return null;
  const url = httpUrl(claims.u);
  // The ASCII (punycode) host, so a look-alike name cannot pass as another.
  return url && { url: url.href, host: url.host };
}

/** The static view's transform: external links go through /away. */
export function withSignedAwayLinks(html: Buffer, documentUrl: string) {
  const now = Date.now();
  return withAwayLinks(html, documentUrl, (url) => awayHref(url, now));
}
