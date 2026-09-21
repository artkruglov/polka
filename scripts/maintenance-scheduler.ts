/** Scheduling only. The child must own the database singleton guard. */
export type MaintenanceChild = {
  exited: Promise<{ code: number | null; signal?: string | null }>;
  terminate: (signal: "SIGTERM" | "SIGKILL") => void;
};
export type MaintenanceEvent = {
  event: "started" | "completed" | "failed";
  reason?: "exit" | "deadline" | "stopping" | "spawn";
};

export async function runMaintenanceScheduler(options: {
  start: () => MaintenanceChild;
  signal: AbortSignal;
  intervalMs?: number;
  deadlineMs?: number;
  graceMs?: number;
  onEvent?: (event: MaintenanceEvent) => void;
}) {
  const intervalMs = options.intervalMs ?? 60_000;
  const deadlineMs = options.deadlineMs ?? 60_000;
  const graceMs = options.graceMs ?? 5_000;
  for (const value of [intervalMs, deadlineMs, graceMs])
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("Invalid maintenance timing");
  const emit = (event: MaintenanceEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* Logging cannot release supervision. */
    }
  };
  while (!options.signal.aborted) {
    let child: MaintenanceChild;
    try {
      child = options.start();
    } catch {
      emit({ event: "failed", reason: "spawn" });
      await pause(intervalMs, options.signal);
      continue;
    }
    emit({ event: "started" });
    let reason: "deadline" | "stopping" | undefined;
    let exited = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const terminate = (nextReason: "deadline" | "stopping") => {
      if (reason || exited) return;
      reason = nextReason;
      try {
        child.terminate("SIGTERM");
      } catch {
        /* Still escalate and await exit. */
      }
      grace = setTimeout(() => {
        try {
          child.terminate("SIGKILL");
        } catch {
          /* A failed kill is not an exit. */
        }
      }, graceMs);
    };
    const abort = () => terminate("stopping");
    const deadline = setTimeout(() => terminate("deadline"), deadlineMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    try {
      // Never begin another run until the child has actually exited, even if
      // a deadline elapsed. A kill request is not proof of termination.
      const result = await child.exited;
      exited = true;
      emit(
        reason
          ? { event: "failed", reason }
          : result.code === 0
            ? { event: "completed" }
            : { event: "failed", reason: "exit" },
      );
    } catch {
      // Spawn errors are terminal child outcomes supplied by the adapter.
      exited = true;
      emit({ event: "failed", reason: reason ?? "spawn" });
    } finally {
      clearTimeout(deadline);
      clearTimeout(grace);
      options.signal.removeEventListener("abort", abort);
    }
    await pause(intervalMs, options.signal);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
