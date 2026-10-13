/**
 * Полка's upstream source code (AGPL-3.0). The installation may name its own
 * source in GET /api/capabilities (SOURCE_URL); this is the fallback.
 */
export const SOURCE_URL = "https://github.com/artkruglov/polka";
export const SOURCE_LICENSE = "AGPL-3.0";

/** The public cloud; its documents (docs/legal) are shown only there. */
export const CLOUD_ORIGIN = "https://polochka.app";

/** This page is served by the cloud itself (false while rendered without a browser). */
export const onCloud = () => typeof location !== "undefined" && location.origin === CLOUD_ORIGIN;

/**
 * The cloud's own policy or agreement, where a page describes the cloud: a
 * site path on polochka.app, its full address on any other installation.
 */
export function cloudDocument(doc: "privacy" | "terms") {
  return typeof location === "undefined" || onCloud() ? `/${doc}` : `${CLOUD_ORIGIN}/${doc}`;
}

/** Is this source a repository on github.com (a star count exists, GitHub paths apply)? */
export function onGitHub(sourceUrl: string) {
  try {
    return new URL(sourceUrl).hostname === "github.com";
  } catch {
    return false;
  }
}

/** The short self-host path: the hosted guide inside the repository, or a fork's own source page. */
export function selfHostGuideUrl(sourceUrl: string) {
  return onGitHub(sourceUrl) ? `${sourceUrl.replace(/\/$/, "")}/blob/main/deploy/hosted/README.md` : sourceUrl;
}

/** Fewer stars than this are not shown: a count is social proof, not a confession. */
export const MIN_STARS_SHOWN = 10;

const compact = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** "1,2 тыс." for the header; null when there is nothing worth showing. */
export function formatStars(stars: number | null | undefined) {
  if (typeof stars !== "number" || stars < MIN_STARS_SHOWN) return null;
  return stars < 1000 ? String(stars) : compact.format(stars);
}
