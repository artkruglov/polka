import { monitorEventLoopDelay } from "node:perf_hooks";
import { db } from "./db.ts";
import { workerSlots } from "./html.ts";

/**
 * What the process itself is doing, for the operator's status page
 * (ops-status.ts) and the Prometheus endpoint (ops-prometheus.ts): the
 * numbers that show a service running out of room before users notice:
 * memory, how long the event loop stalls, how many requests wait for a
 * database connection or a worker, and a few counters the code bumps where a
 * cache or a limit decides something. No user data.
 */

// The histogram's timer fires every RESOLUTION_MS and records the time
// between two firings, so an idle loop reads as RESOLUTION_MS, not 0. The
// delay is what is left after subtracting it.
const RESOLUTION_MS = 10;

/**
 * A window of event-loop delay: `read()` returns the delay since the previous
 * read (or since the window opened) and starts over. Each reader keeps its
 * own window, so a scrape does not reset what the status page shows.
 */
export function eventLoopDelayWindow() {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const delay = (nanoseconds: number) =>
    Number.isFinite(nanoseconds) ? Math.max(0, nanoseconds / 1e6 - RESOLUTION_MS) : 0;
  return {
    /** Milliseconds of delay beyond the timer's own period. */
    read() {
      // No sample yet (read within the first period): no delay seen.
      const empty = histogram.count === 0;
      const value = {
        min: empty ? 0 : delay(histogram.min),
        mean: empty ? 0 : delay(histogram.mean),
        p99: empty ? 0 : delay(histogram.percentile(99)),
        max: empty ? 0 : delay(histogram.max),
      };
      histogram.reset();
      return value;
    },
  };
}

const loop = eventLoopDelayWindow();
const counters = new Map<string, number>();
const totals = new Map<string, number>();

/** Count one event (cache hit, refusal…); read and cleared by runtimeStats. */
export const bump = (name: string) => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
  totals.set(name, (totals.get(name) ?? 0) + 1);
};

/** Every bumped counter since the process started (Prometheus counters). */
export const counterTotals = () => new Map(totals);

const round = (milliseconds: number) => Math.round(milliseconds * 10) / 10;

/**
 * The numbers since the last read (the event-loop histogram and the counters
 * start over; memory, pool and workers are as of now).
 */
export function runtimeStats() {
  const memory = process.memoryUsage();
  const delay = loop.read();
  const stats = {
    uptimeSeconds: Math.round(process.uptime()),
    rssMiB: Math.round(memory.rss / 1048576),
    heapUsedMiB: Math.round(memory.heapUsed / 1048576),
    eventLoopMs: { mean: round(delay.mean), p99: round(delay.p99), max: round(delay.max) },
    pool: { max: db.options.max ?? null, total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
    workers: workerSlots(),
    counters: Object.fromEntries(counters),
  };
  counters.clear();
  return stats;
}
