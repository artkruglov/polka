import { useEffect, useState } from "react";
import { request } from "../../shared/api/client.ts";
import { onGitHub } from "../../shared/lib/project-links.ts";
import { useSourceUrl } from "./useCapabilities.ts";

let cached: Promise<number | null> | null = null;

/** One /source/stars request per page load; the server caches GitHub's answer for an hour. */
function loadSourceStars() {
  cached ??= request<{ stars?: unknown }>("/source/stars")
    .then((body) =>
      typeof body?.stars === "number" && body.stars >= 0 ? body.stars : null,
    )
    .catch(() => null);
  return cached;
}

/**
 * The GitHub star count of this installation's source: null until known, when
 * the source is not on GitHub, or when GitHub did not answer. The browser asks
 * only this server (CSP: connect-src 'self').
 */
export function useSourceStars(): number | null {
  const sourceUrl = useSourceUrl();
  const [stars, setStars] = useState<number | null>(null);
  const github = onGitHub(sourceUrl);
  useEffect(() => {
    if (!github) return;
    let live = true;
    loadSourceStars().then((value) => {
      if (live) setStars(value);
    });
    return () => {
      live = false;
    };
  }, [github]);
  return github ? stars : null;
}
