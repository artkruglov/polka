import { log } from "./log.ts";

/*
 * How the server stops (SIGTERM from `docker compose stop`/`up -d`, SIGINT
 * in a terminal, or the pool watchdog): one deadline for all of it, below
 * the container's stop_grace_period (30 s), after which Docker kills it.
 *
 * 1. intake: readiness turns red, the background timers stop, the listeners
 *    close; requests already running finish (new ones on an open connection
 *    get 503).
 * 2. drain: work started after a commit or a response (letters, deletions of
 *    objects, webhook deliveries; db.ts inBackground) settles.
 * 3. close: the database pool and the object storage client.
 *
 * A step that outlives the deadline is left behind and logged; close still
 * runs, so the pool's connections are not cut by a kill.
 */

export type ShutdownSteps = {
  intake: () => Promise<unknown>;
  drain: () => Promise<unknown>;
  close: () => Promise<unknown>;
};

/** Resolves true when `promise` settles within `ms`, false otherwise. */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run the steps in order under one deadline; never throws. */
export async function gracefulShutdown(steps: ShutdownSteps, deadlineMs: number) {
  const started = Date.now();
  const left = () => Math.max(0, deadlineMs - (Date.now() - started));
  log.info({ event: "server.stopping", deadlineMs });
  const intake = await within(Promise.resolve().then(steps.intake), left());
  const drained = await within(Promise.resolve().then(steps.drain), left());
  if (!intake || !drained) log.warn({ event: "server.stop_deadline", intake, drained, deadlineMs });
  // Closing gets a moment of its own even when the deadline is spent.
  const closed = await within(Promise.resolve().then(steps.close), Math.max(left(), 2_000));
  log.info({ event: "server.stopped", drained: intake && drained, closed, ms: Date.now() - started });
  return { intake, drained, closed };
}

/**
 * Stop once on the first of `signals` and exit with 0; `stop(code)` does the
 * same from code (the watchdog exits with 1). A second signal while stopping
 * is ignored: the deadline already bounds the wait. The process exits with
 * the highest code asked for: a watchdog stop that overlaps a SIGTERM still
 * exits 1.
 */
export function installShutdown({
  steps,
  deadlineMs,
  signals = ["SIGINT", "SIGTERM"],
  exit = (code: number) => process.exit(code),
}: {
  steps: ShutdownSteps;
  deadlineMs: number;
  signals?: NodeJS.Signals[];
  exit?: (code: number) => void;
}) {
  let stopping: Promise<void> | null = null;
  let exitCode = 0;
  const stop = (code: number) => {
    exitCode = Math.max(exitCode, code);
    return (stopping ??= gracefulShutdown(steps, deadlineMs).then(() => exit(exitCode)));
  };
  for (const signal of signals) process.on(signal, () => void stop(0));
  return stop;
}
