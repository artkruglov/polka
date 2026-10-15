import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Problem } from "./errors.ts";
import { log } from "./log.ts";

/**
 * A warm pool of reader workers (html-pool-worker.ts): the classifier and
 * phishing scan of a page, a text or a work's scripts, a page's cover facts,
 * a Markdown document, a CSV table, a PDF's text and links. Each of these
 * may be quadratic on crafted input, so it runs off the request thread with
 * a deadline.
 *
 * A worker used to be started per call: loading tsx and the readers took
 * 180–230 ms for 10 ms of work, and every large publish paid it (and its
 * memory). Now HTML_WORKERS workers stay loaded and take tasks one after
 * another. A task that misses its deadline, or a worker that crashes, costs
 * that worker: it is terminated (the only way to stop a busy parse) and the
 * next task starts a new one. Tasks beyond the workers wait in order, at
 * most HTML_WORKER_QUEUE of them; past that a new one is refused with 503
 * busy and Retry-After instead of piling up sources in memory.
 *
 * The deadline counts the work, not the wait: the clock starts when the task
 * is handed to a loaded worker. Loading has its own, looser bound.
 */
const SCRIPT = new URL("./html-pool-worker.mjs", import.meta.url);
const START_MS = 10_000;
/** A worker is replaced after this many tasks, so no slow leak outlives it. */
const TASKS_PER_WORKER = 1_000;
const HEAP_MB = 256;

export type PoolTask = { kind: "inspect" | "cover" | "markdown" | "csv" | "pdf" } & Record<string, unknown>;

type Job = {
  task: PoolTask;
  deadlineMs: number;
  unread: unknown;
  resolve: (value: unknown) => void;
};

type Slot = {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  timer: NodeJS.Timeout | null;
  tasks: number;
  sequence: number;
  /** Set once the worker is being replaced: nothing more is sent to it. */
  retired: boolean;
};

/**
 * Read here, not in config.ts: html.ts (and so this pool) is also loaded by
 * scripts that have no server configuration.
 */
function setting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}
/** Workers kept loaded (HTML_WORKERS): by default two, or one on a one-CPU host. */
let size = setting("HTML_WORKERS", Math.min(2, Math.max(1, availableParallelism())), 1, 64);
/** Tasks that may wait for a worker (HTML_WORKER_QUEUE). */
let queueLimit = setting("HTML_WORKER_QUEUE", 64, 0, 10_000);
const slots = new Set<Slot>();
const queue: Job[] = [];
const counts = { started: 0, retired: 0, refused: 0 };

function spawn(job: Job) {
  const worker = new Worker(SCRIPT, { resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } });
  counts.started++;
  const slot: Slot = { worker, ready: false, job, timer: null, tasks: 0, sequence: 0, retired: false };
  slots.add(slot);
  // Loading has its own bound; a worker that cannot load in time is replaced.
  slot.timer = setTimeout(() => retire(slot), START_MS);
  worker.on("message", (reply: { ready?: true; id?: number; result?: unknown }) => {
    if (slot.retired) return;
    if (reply?.ready) {
      slot.ready = true;
      stopTimer(slot);
      if (slot.job) send(slot);
      else idle(slot);
      return;
    }
    if (!slot.job || reply?.id !== slot.sequence) return;
    resolveJob(slot, reply.result);
    if (slot.tasks >= TASKS_PER_WORKER || slots.size > size) retire(slot);
    else idle(slot);
  });
  worker.on("error", () => retire(slot));
  worker.on("exit", () => retire(slot));
}

function stopTimer(slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
}

function send(slot: Slot) {
  const job = slot.job!;
  slot.sequence++;
  slot.tasks++;
  slot.worker.ref();
  // Missed the deadline: the answer is «unread», and the worker that may
  // still be parsing is replaced.
  slot.timer = setTimeout(() => retire(slot), job.deadlineMs);
  slot.worker.postMessage({ id: slot.sequence, task: job.task });
}

function resolveJob(slot: Slot, value: unknown) {
  const job = slot.job;
  stopTimer(slot);
  if (!job) return;
  slot.job = null;
  job.resolve(value);
}

/** A loaded worker without a task takes the next one, or waits without holding the process. */
function idle(slot: Slot) {
  const next = queue.shift();
  if (next) {
    slot.job = next;
    send(slot);
  } else slot.worker.unref();
}

/** Terminate a worker (deadline, crash, recycling); its task, if any, gets «unread». */
function retire(slot: Slot) {
  if (slot.retired) return;
  slot.retired = true;
  slots.delete(slot);
  counts.retired++;
  const job = slot.job;
  resolveJob(slot, job?.unread);
  slot.worker.removeAllListeners();
  // An error after terminate must not become an uncaught exception.
  slot.worker.on("error", () => {});
  slot.worker.terminate().catch(() => {});
  dispatch();
}

function dispatch() {
  while (queue.length && slots.size < size) {
    const job = queue.shift()!;
    try {
      spawn(job);
    } catch (error) {
      log.error({ event: "worker_pool.start_failed", error: error instanceof Error ? error.name : typeof error });
      job.resolve(job.unread);
    }
  }
}

/**
 * Runs one task in the pool. Resolves with the worker's answer, or `unread`
 * when it missed `deadlineMs` or the worker broke. Throws 503 busy when the
 * queue is full.
 */
export function runInPool<T>(task: PoolTask, deadlineMs: number, unread: T): Promise<T> {
  const job: Job = { task, deadlineMs, unread, resolve: () => {} };
  const promise = new Promise<T>((resolve) => (job.resolve = resolve as (value: unknown) => void));
  const free = [...slots].find((slot) => slot.ready && !slot.job);
  if (free) {
    free.job = job;
    send(free);
    return promise;
  }
  if (slots.size < size) {
    queue.push(job);
    dispatch();
    return promise;
  }
  if (queue.length >= queueLimit) {
    counts.refused++;
    return Promise.reject(
      new Problem(
        503,
        "busy",
        "Полка сейчас проверяет много страниц одновременно. Повторите запрос через несколько секунд.",
      ).retryIn(5),
    );
  }
  queue.push(job);
  return promise;
}

/**
 * The pool now: `limit` workers, `running` tasks, `waiting` in the queue.
 * `limit` changes the number of workers (tests); extra idle workers leave
 * at once, busy ones after their task.
 */
export function workerSlots(limit?: number) {
  if (limit !== undefined) {
    size = Math.max(1, limit);
    for (const slot of slots) if (slots.size > size && !slot.job) retire(slot);
    dispatch();
  }
  return { limit: size, running: [...slots].filter((slot) => slot.job).length, waiting: queue.length };
}

/** Workers alive, the queue bound, and starts, replacements and refusals since the process began. */
export function workerPoolStats(queue_?: number) {
  if (queue_ !== undefined) queueLimit = Math.max(0, queue_);
  return { ...workerSlots(), workers: slots.size, queueLimit, ...counts };
}
