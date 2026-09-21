/** Process-local coordination only. Real DB/S3 adapters and routes are separate. */
export type ReadinessProbe = (signal: AbortSignal) => Promise<boolean>;
export type ReadinessOptions = {
  database: ReadinessProbe;
  storage: ReadinessProbe;
  deadlineMs?: number;
  cacheMs?: number;
};

export function createHealthCoordinator(options: ReadinessOptions) {
  const deadlineMs = options.deadlineMs ?? 2000;
  const cacheMs = options.cacheMs ?? 5000;
  if (
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > 2000 ||
    !Number.isFinite(cacheMs) ||
    cacheMs < 0 ||
    cacheMs > 5000
  )
    throw new Error("Invalid health timing limits");
  let stopping = false;
  let cached: { ready: boolean; at: number } | null = null;
  let running: {
    result: Promise<boolean>;
    controller: AbortController;
    finish: (ready: boolean) => void;
  } | null = null;

  function ready(): Promise<boolean> {
    if (stopping) return Promise.resolve(false);
    // A timed-out probe can still be unwinding. Never launch overlapping I/O.
    if (running) return running.result;
    if (cached && performance.now() - cached.at < cacheMs)
      return Promise.resolve(cached.ready);

    const controller = new AbortController();
    const startedAt = performance.now();
    let resolve!: (ready: boolean) => void;
    const result = new Promise<boolean>((done) => {
      resolve = done;
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const expired = performance.now() - startedAt >= deadlineMs;
      if (expired) controller.abort();
      const accepted =
        value && !expired && !stopping && !controller.signal.aborted;
      cached = { ready: accepted, at: performance.now() };
      resolve(accepted);
    };
    const attempt = { result, controller, finish };
    running = attempt;
    timer = setTimeout(() => {
      controller.abort();
      finish(false);
    }, deadlineMs);
    const probe = (fn: ReadinessProbe) =>
      Promise.resolve().then(() =>
        stopping ||
        controller.signal.aborted ||
        performance.now() - startedAt >= deadlineMs
          ? false
          : fn(controller.signal),
      );
    void Promise.allSettled([
      probe(options.database),
      probe(options.storage),
    ]).then((results) => {
      finish(
        results.every(
          (item) => item.status === "fulfilled" && item.value === true,
        ),
      );
      if (running === attempt) running = null;
    });
    return result;
  }

  return {
    alive: () => !stopping,
    ready,
    stop() {
      stopping = true;
      if (running) {
        running.controller.abort();
        running.finish(false);
      }
    },
  };
}
