// The GitHub star count of this installation's source (SOURCE_URL), for the
// «GitHub» button in the site header. The browser never talks to GitHub (the
// app CSP is connect-src 'self'): the server asks api.github.com, unauthenticated
// (60 requests an hour per address), and keeps the answer in memory for an hour.
// Anything but a plain github.com/<owner>/<repo> source answers null at once.

/** How long a fetched count is served before GitHub is asked again. */
export const STARS_TTL_MS = 60 * 60 * 1000;
/** After a failed request GitHub is left alone for this long (no stampede on the rate limit). */
export const STARS_RETRY_MS = 5 * 60 * 1000;
/** GitHub gets this long to answer; the header is not worth a slow page. */
export const STARS_TIMEOUT_MS = 3000;

const OWNER_OR_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/** `https://github.com/<owner>/<repo>` (a trailing `/` or `.git` allowed): the repository; anything else: null. */
export function githubRepository(sourceUrl: string) {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  if (url.search || url.hash) return null;
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.length !== 2) return null;
  const [owner, repo] = [segments[0], segments[1].replace(/\.git$/, "")];
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo)) return null;
  if (owner.includes(".")) return null; // GitHub logins have no dots
  return { owner, repo };
}

type Fetch = typeof globalThis.fetch;

/** One counter per process: the cached count, the in-flight request, the retry timer. */
export function createStarCounter({
  sourceUrl,
  fetch = (...args: Parameters<Fetch>) => globalThis.fetch(...args),
  now = Date.now,
  ttlMs = STARS_TTL_MS,
  retryMs = STARS_RETRY_MS,
  timeoutMs = STARS_TIMEOUT_MS,
}: {
  sourceUrl: string;
  fetch?: Fetch;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}) {
  const repository = githubRepository(sourceUrl);
  let cached: { stars: number | null; until: number } | null = null;
  let inFlight: Promise<number | null> | null = null;

  async function ask(): Promise<number | null> {
    if (!repository) return null;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repository.owner}/${repository.repo}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "polka (source stars)",
          },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        },
      );
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const stars =
        body && typeof body === "object"
          ? (body as { stargazers_count?: unknown }).stargazers_count
          : undefined;
      return typeof stars === "number" && Number.isInteger(stars) && stars >= 0
        ? stars
        : null;
    } catch {
      return null;
    }
  }

  return {
    /** The count, or null: not a GitHub repository, GitHub unreachable, or an answer we do not understand. */
    async stars(): Promise<number | null> {
      if (!repository) return null;
      if (cached && cached.until > now()) return cached.stars;
      inFlight ??= ask().then((stars) => {
        cached = { stars, until: now() + (stars === null ? retryMs : ttlMs) };
        inFlight = null;
        return stars;
      });
      return inFlight;
    },
    /** Tests only. */
    reset() {
      cached = null;
      inFlight = null;
    },
    repository,
  };
}
