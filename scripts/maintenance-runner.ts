import { startMaintenanceChild } from "./maintenance-child.ts";
import { runMaintenanceScheduler } from "./maintenance-scheduler.ts";

const stopping = new AbortController();
const stop = () => stopping.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await runMaintenanceScheduler({
    signal: stopping.signal,
    start: () =>
      startMaintenanceChild({
        onLog: (event) => console.log(JSON.stringify(event)),
      }),
    onEvent: ({ event, reason }) =>
      console.log(
        JSON.stringify({
          event: `maintenance.scheduler.${event}`,
          ...(reason ? { reason } : {}),
        }),
      ),
  });
} catch {
  console.error(
    JSON.stringify({
      event: "maintenance.scheduler.failed",
      reason: "internal",
    }),
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
