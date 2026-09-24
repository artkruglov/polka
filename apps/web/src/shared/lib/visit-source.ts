// Where this tab's visit came from, for the sign-up's source in Полка's own
// usage statistics (docs/legal/privacy.md). Only a link's `?ref=` value and
// the referring site's host (never its address) are kept, in this tab's
// sessionStorage, and sent only with the request that creates an account.
// No cookie, nothing else.
const KEY = "polka_visit_source";
const REF = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const HOST = /^[a-z0-9.-]{1,100}$/;

export type VisitSource = { ref?: string; referrer?: string };

function clean(value: unknown): VisitSource | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const ref = typeof raw.ref === "string" && REF.test(raw.ref) ? raw.ref : null;
  const referrer =
    typeof raw.referrer === "string" && HOST.test(raw.referrer)
      ? raw.referrer
      : null;
  return ref || referrer
    ? { ...(ref ? { ref } : {}), ...(referrer ? { referrer } : {}) }
    : null;
}

/** On the first page of a visit: remember its ref and referrer host. */
export function rememberVisitSource() {
  try {
    if (typeof window === "undefined" || sessionStorage.getItem(KEY)) return;
    const ref = new URLSearchParams(location.search)
      .get("ref")
      ?.trim()
      .toLowerCase();
    let referrer: string | undefined;
    if (document.referrer) {
      const host = new URL(document.referrer).hostname
        .toLowerCase()
        .replace(/^www\./, "");
      if (host && host !== location.hostname.replace(/^www\./, ""))
        referrer = host;
    }
    const source = clean({ ref, referrer });
    if (source) sessionStorage.setItem(KEY, JSON.stringify(source));
  } catch {
    // No storage (private mode, tests): the sign-up simply has no source.
  }
}

/**
 * A sign-up that starts on a page of Полка itself (the prompt on a shared
 * work) names that page as the source: the tab's earlier ref, if any, is
 * replaced; the referrer host stays. Returns false when nothing was kept.
 */
export function setVisitSourceRef(ref: string): boolean {
  try {
    if (typeof window === "undefined" || !REF.test(ref)) return false;
    const current = visitSource();
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...(current?.referrer ? { referrer: current.referrer } : {}), ref }),
    );
    return true;
  } catch {
    return false;
  }
}

export function visitSource(): VisitSource | null {
  try {
    if (typeof window === "undefined") return null;
    return clean(JSON.parse(sessionStorage.getItem(KEY) ?? "null"));
  } catch {
    return null;
  }
}

/** `&ref=…&referrer=…` for a sign-in link that may create an account. */
export function visitSourceQuery() {
  const source = visitSource();
  if (!source) return "";
  const params = new URLSearchParams(source as Record<string, string>);
  return `&${params}`;
}
