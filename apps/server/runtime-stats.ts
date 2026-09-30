import { monitorEventLoopDelay } from "node:perf_hooks";
import { db } from "./db.ts";
import { workerSlots } from "./html.ts";

/**
 * What the process itself is doing, for the operator's status page
 * (ops-status.ts): the numbers that show a service running out of room before
 * users notice: memory, how long the event loop stalls, how many requests
 * wait for a database connection or a worker, and a few counters the code
 * bumps where a cache or a limit decides something. No user data.
 */
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const counters = new Map<string, number>();

/** Count one event (cache hit, refusal…); read and cleared by runtimeStats. */
export const bump = (name: string) => counters.set(name, (counters.get(name) ?? 0) + 1);

const ms = (nanoseconds: number) => Math.round((nanoseconds / 1e6) * 10) / 10;

/**
 * The numbers since the last read (the event-loop histogram and the counters
 * start over; memory, pool and workers are as of now).
 */
export function runtimeStats() {
  const memory = process.memoryUsage();
  const stats = {
    uptimeSeconds: Math.round(process.uptime()),
    rssMiB: Math.round(memory.rss / 1048576),
    heapUsedMiB: Math.round(memory.heapUsed / 1048576),
    eventLoopMs: { mean: ms(loop.mean), p99: ms(loop.percentile(99)), max: ms(loop.max) },
    pool: { max: db.options.max ?? null, total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
    workers: workerSlots(),
    counters: Object.fromEntries(counters),
  };
  loop.reset();
  counters.clear();
  return stats;
}
