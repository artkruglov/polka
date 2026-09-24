/*
 * Recognises a page that is a bot check or a consent wall rather than the
 * content. The renderer never solves, clicks through or retries one: it
 * reports source_blocked and the user saves the link another way.
 */

export type PageEvidence = {
  /** The main document's final URL. */
  url: string;
  title: string;
  /** Response headers of the main document (lower-case names). */
  headers: Record<string, string>;
  status: number;
  /** URLs of every frame on the page. */
  frameUrls: string[];
  /** The visible text of the main document (innerText), trimmed. */
  text: string;
};

/** Less visible text than this under a consent banner means the content did not come. */
const MIN_CONTENT_TEXT = 200;

export function detectChallenge(page: PageEvidence): string | null {
  const title = page.title.trim().toLowerCase();
  if (page.headers["cf-mitigated"]?.toLowerCase() === "challenge") return "cloudflare_challenge";
  if (/^just a moment\b|^attention required|^один момент/.test(title)) return "cloudflare_challenge";
  if (page.frameUrls.some((url) => hostIs(url, "challenges.cloudflare.com"))) return "cloudflare_turnstile";
  if (page.frameUrls.some((url) => /\/recaptcha\/|hcaptcha\.com/.test(url)) && page.text.length < MIN_CONTENT_TEXT)
    return "captcha";
  if (hostIs(page.url, "consent.google.com") || hostIs(page.url, "consent.youtube.com")) return "consent_wall";
  // Google's banner sits over the content in the same document: the DOM under it
  // is kept as it is (nothing is clicked), unless there is no content at all.
  const consent = /^before you continue|^прежде чем перейти|^bevor sie fortfahren/.test(title);
  if (consent && page.text.length < MIN_CONTENT_TEXT) return "consent_wall";
  if ((page.status === 403 || page.status === 429 || page.status === 503) && page.text.length < MIN_CONTENT_TEXT)
    return `http_${page.status}`;
  return null;
}

function hostIs(url: string, host: string) {
  try {
    const name = new URL(url).hostname.toLowerCase();
    return name === host || name.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
