import { Worker } from "node:worker_threads";
import type pg from "pg";
import { log } from "./log.ts";

/*
 * Self-healing for the server process (docs: deploy/hosted/README.md,
 * «Самовосстановление»). Docker restarts a container that exits
 * (`restart: unless-stopped`) but not one that is merely unhealthy, so a
 * process that hangs keeps its port and answers nothing. Two conservative
 * checks end such a process:
 *
 * - the event loop: a worker thread watches a heartbeat the main thread
 *   writes every second. A loop blocked longer than the limit cannot run any
 *   JavaScript, not even a signal handler, so the worker writes the log line
 *   itself and kills the process (SIGKILL; under `init: true` the container
 *   exits with 137 and is restarted).
 * - the database pool: every connection checked out, requests waiting for
 *   one, and no checkout or release for the limit. Statement and
 *   idle-in-transaction timeouts (db.ts) end a stuck query or transaction
 *   within a minute, so a pool frozen past that is a client that was never
 *   released; only a restart returns it. The process exits through its
 *   graceful shutdown (main.ts) with code 1.
 *
 * A database that is down does not trip the second check: its connections
 * fail and leave the pool, so the pool is not full.
 */

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const beat = new Float64Array(workerData.heartbeat);
const limitMs = workerData.limitMs;
setInterval(() => {
  const blockedMs = Date.now() - beat[0];
  if (blockedMs <= limitMs) return;
  // The main thread cannot log while its loop is blocked: write the line here,
  // in the server log's format (log.ts), straight to stderr.
  writeSync(2, JSON.stringify({ level: "fatal", time: new Date().toISOString(), event: "watchdog.event_loop_blocked", blockedMs, limitMs }) + "\\n");
  process.kill(workerData.pid, "SIGKILL");
}, workerData.checkMs);
`;

/**
 * Kill the process when its event loop has not turned for `limitMs`.
 * Returns a stop function. `limitMs` 0 turns the check off.
 */
export function startEventLoopWatchdog({ limitMs, checkMs = 1_000 }: { limitMs: number; checkMs?: number }) {
  if (limitMs <= 0) return () => undefined;
  // PID 1 ignores signals it has no handler for, SIGKILL from inside too:
  // the container needs `init: true` (deploy/hosted/compose.yml).
  if (process.pid === 1) log.warn({ event: "watchdog.pid1", detail: "set init: true for the service" });
  const heartbeat = new SharedArrayBuffer(8);
  const beat = new Float64Array(heartbeat);
  beat[0] = Date.now();
  const tick = setInterval(() => (beat[0] = Date.now()), Math.min(1_000, checkMs)).unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { heartbeat, limitMs, checkMs, pid: process.pid },
    // The watchdog needs no heap of note; keep it small.
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
  });
  worker.unref();
  worker.on("error", () => log.error({ event: "watchdog.failed" }));
  return () => {
    clearInterval(tick);
    void worker.terminate();
  };
}

type PoolLike = Pick<pg.Pool, "totalCount" | "idleCount" | "waitingCount" | "on" | "off"> & {
  options: { max?: number };
};

/**
 * Call `onStall` once when the pool has been full, with requests waiting and
 * no checkout or release, for `limitMs`. Returns a stop function. `limitMs` 0
 * turns the check off.
 */
export function startPoolWatchdog({
  pool,
  limitMs,
  onStall,
  checkMs = 5_000,
  now = Date.now,
}: {
  pool: PoolLike;
  limitMs: number;
  onStall: () => void;
  checkMs?: number;
  now?: () => number;
}) {
  if (limitMs <= 0) return () => undefined;
  let lastProgress = now();
  let stalledSince: number | null = null;
  let fired = false;
  const progress = () => {
    lastProgress = now();
  };
  pool.on("acquire", progress);
  pool.on("release", progress);
  const check = () => {
    const max = pool.options.max ?? 10;
    const stalled = pool.waitingCount > 0 && pool.idleCount === 0 && pool.totalCount >= max;
    if (!stalled) {
      stalledSince = null;
      return;
    }
    const time = now();
    stalledSince ??= time;
    const stalledMs = time - Math.max(stalledSince, lastProgress);
    if (stalledMs < limitMs || fired) return;
    fired = true;
    log.fatal({
      event: "watchdog.pool_stalled",
      stalledMs,
      limitMs,
      total: pool.totalCount,
      waiting: pool.waitingCount,
    });
    onStall();
  };
  const timer = setInterval(check, checkMs).unref();
  return () => {
    clearInterval(timer);
    pool.off("acquire", progress);
    pool.off("release", progress);
  };
}
