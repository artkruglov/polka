// Signing in from a shared link must bring the reader back to that link, but
// the link's token lives in the URL fragment so that it never reaches a
// server: it must not ride in ?next= (authReturnTo). Before leaving for the
// sign-in page the token is kept in this tab's sessionStorage; after sign-in
// /s restores it into the fragment once. It expires after 30 minutes and is
// used once.

const KEY = "polka.share-return";
const TTL_MS = 30 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Where the sign-in page sends the reader afterwards: /s, without a token. */
export const SHARE_RETURN_PATH = "/s";

export function rememberShareForSignIn(token: string) {
  if (!TOKEN.test(token)) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** The token kept before sign-in, once; null when there is none or it is stale. */
export function takeShareAfterSignIn(now = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (
      typeof value.token === "string" &&
      TOKEN.test(value.token) &&
      typeof value.at === "number" &&
      now - value.at >= 0 &&
      now - value.at < TTL_MS
    )
      return value.token;
  } catch {
    /* ignore a damaged entry */
  }
  return null;
}

/** The sign-in page for a reader of a shared link. */
export const signInFromShare = (token: string) => {
  rememberShareForSignIn(token);
  return `/signup?next=${encodeURIComponent(SHARE_RETURN_PATH)}`;
};
