// How the model stage talks to a model endpoint (docs/specs/CONTENT_FILTER.md,
// «Модели»): the provider's headers, an in-process limiter per endpoint
// (NeuralDeep plans cap requests per minute and in parallel), and one POST
// to /chat/completions that tells a rate limit apart from a failure, so the
// primary's question goes to the fallback at once.
import type { ModelEndpoint, ModelProvider } from "../config.ts";

/** Yandex: Api-Key and no request logging; NeuralDeep and the rest: Bearer. */
export function providerHeaders(provider: ModelProvider, key: string | null) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (provider === "yandex") {
    if (key) headers.authorization = `Api-Key ${key}`;
    // Yandex does not log the request.
    headers["x-data-logging-enabled"] = "false";
  } else if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Requests per minute (a sliding minute) and in parallel; 0: no limit. A
 * request waits for room up to its deadline; one that could not start by
 * then gets null at once instead of waiting in vain. A 429 pauses the
 * endpoint for its Retry-After.
 */
export class RateLimiter {
  private active = 0;
  private starts: number[] = [];
  private pausedUntil = 0;
  private waiters = new Set<() => void>();
  constructor(
    public rpm: number,
    public concurrency: number,
    private now: () => number = Date.now,
  ) {}

  async acquire(maxWaitMs: number): Promise<(() => void) | null> {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const now = this.now();
      this.starts = this.starts.filter((at) => now - at < 60_000);
      const byRate =
        this.rpm && this.starts.length >= this.rpm
          ? this.starts[0]! + 60_000
          : 0;
      const until = Math.max(byRate, this.pausedUntil);
      const busy = !!this.concurrency && this.active >= this.concurrency;
      if (until <= now && !busy) {
        this.active++;
        this.starts.push(now);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
          for (const wake of [...this.waiters]) wake();
        };
      }
      if (until > deadline || now >= deadline) return null;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.max(1, (until > now ? until : deadline) - now),
        );
        this.waiters.add(done);
      });
    }
  }

  /** The endpoint answered 429: no new requests for a while. */
  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}

// One limiter per endpoint (its URL and key: a plan's limits are per key),
// shared by the roles that use it; the stricter limits win.
const limiters = new Map<string, RateLimiter>();
export function limiterFor(
  endpoint: Pick<ModelEndpoint, "url" | "key" | "rpm" | "concurrency">,
) {
  const id = `${endpoint.url}\n${endpoint.key ?? ""}`;
  const existing = limiters.get(id);
  const stricter = (a: number, b: number) => (!a ? b : !b ? a : Math.min(a, b));
  if (existing) {
    existing.rpm = stricter(existing.rpm, endpoint.rpm);
    existing.concurrency = stricter(existing.concurrency, endpoint.concurrency);
    return existing;
  }
  const limiter = new RateLimiter(endpoint.rpm, endpoint.concurrency);
  limiters.set(id, limiter);
  return limiter;
}

/** Tests: forget the limiters. */
export function resetLimiters() {
  limiters.clear();
}

export type ChatResult =
  | { ok: true; body: any }
  | { ok: false; failed: "rate_limited" | "timeout" | "error" };

/** A 429's Retry-After in ms (seconds or a date), 10 s by default, at most a minute. */
export function retryAfterMs(value: string | null) {
  const seconds = Number(value);
  const ms =
    value && Number.isFinite(seconds)
      ? seconds * 1000
      : value
        ? Date.parse(value) - Date.now()
        : NaN;
  return Math.min(60_000, Math.max(1000, Number.isFinite(ms) ? ms : 10_000));
}

/** POST one request to an endpoint within its limits. */
export async function postChat(
  endpoint: Pick<
    ModelEndpoint,
    "provider" | "url" | "key" | "rpm" | "concurrency"
  >,
  body: Record<string, unknown>,
  timeoutMs: number,
  doFetch: typeof fetch = fetch,
): Promise<ChatResult> {
  const limiter = limiterFor(endpoint);
  // Waiting for room is bounded by the request's own timeout.
  const release = await limiter.acquire(timeoutMs);
  if (!release) return { ok: false, failed: "rate_limited" };
  try {
    const response = await doFetch(endpoint.url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: providerHeaders(endpoint.provider, endpoint.key),
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      limiter.pause(retryAfterMs(response.headers.get("retry-after")));
      return { ok: false, failed: "rate_limited" };
    }
    if (!response.ok) return { ok: false, failed: "error" };
    return { ok: true, body: await response.json() };
  } catch (error) {
    const name = (error as Error)?.name;
    return {
      ok: false,
      failed:
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "error",
    };
  } finally {
    release();
  }
}
