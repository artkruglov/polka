import { startMaintenanceChild } from "./maintenance-child.ts";
import { runMaintenanceScheduler } from "./maintenance-scheduler.ts";

// Every run starts a Node process and loads the TypeScript loader, so on a
// small VM a run a minute was the one steady cost of an idle service. What it
// does is housekeeping (expired rows and abandoned uploads), which readers
// never depend on: reads check expiry themselves.
const intervalSeconds = Number(process.env.MAINTENANCE_INTERVAL_SECONDS ?? 300);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 900)
  throw new Error("MAINTENANCE_INTERVAL_SECONDS must be between 30 and 900");
const stopping = new AbortController();
const stop = () => stopping.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await runMaintenanceScheduler({
    signal: stopping.signal,
    intervalMs: intervalSeconds * 1000,
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
