import { registerFrontend } from "./frontend.ts";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { db, inBackground, settled } from "./db.ts";
import { flushAgentReads } from "./agent-read-counter.ts";
import { createHealthAdapters } from "./health-adapters.ts";
import { registerHealthRoutes } from "./health-routes.ts";
import { createHealthCoordinator } from "./health.ts";
import { createLiveViewerApp } from "./live-viewer.ts";
import { s3 } from "./storage.ts";
import { EXPECTED_MIGRATION_VERSIONS } from "../../packages/migrations.ts";
import { assertRestoreStartupGate } from "./restore-gate.ts";
import { installProcessErrorHandlers } from "./process-errors.ts";
import { log } from "./log.ts";
import { installShutdown } from "./shutdown.ts";
import { startEventLoopWatchdog, startPoolWatchdog } from "./watchdog.ts";
installProcessErrorHandlers();
async function closeRefusedStartup() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    db.end().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1_000);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  s3.destroy();
}
try {
  await assertRestoreStartupGate(config, { database: db });
} catch {
  await closeRefusedStartup();
  throw new Error("Restore startup gate refused application startup");
}
const app = await createApp();
const healthAdapters = createHealthAdapters({
  database: {
    databaseUrl: config.DATABASE_URL,
    expectedMigrations: EXPECTED_MIGRATION_VERSIONS,
  },
  storage: {
    endpoint: config.S3_ENDPOINT,
    region: "us-east-1",
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  },
});
const health = createHealthCoordinator({
  database: healthAdapters.database.probe,
  storage: healthAdapters.storage.probe,
});
let viewer: Awaited<ReturnType<typeof createLiveViewerApp>> | null = null;
// Background timers, cleared first on shutdown so no new job starts.
const timers: Array<ReturnType<typeof setInterval>> = [];
const every = (ms: number, job: () => unknown) => timers.push(setInterval(job, ms).unref());
// A job is tracked (db.ts inBackground), so shutdown waits for a running one.
const background = (job: () => Promise<unknown>) => () => void inBackground(job());
let stopWatchdogs = () => undefined as void;
const intake = async () => {
  health.stop();
  stopWatchdogs();
  for (const timer of timers) clearInterval(timer);
  await Promise.allSettled([app.close(), viewer?.close()]);
};
const close = async () => {
  // Agent read counts held in memory (agent-read-counter.ts), before the pool closes.
  await flushAgentReads().catch(() => undefined);
  await Promise.allSettled([healthAdapters.close(), db.end()]);
  s3.destroy();
};
async function shutdown() {
  await intake();
  await close();
}
try {
  await registerHealthRoutes(app, health);
  viewer = config.HTML_LIVE_ENABLED ? await createLiveViewerApp() : null;
  await registerFrontend(app, fileURLToPath(new URL("../../dist", import.meta.url)));
  await app.listen({ host: config.HOST, port: config.PORT });
  if (viewer) await viewer.listen({ host: config.VIEWER_HOST, port: config.VIEWER_PORT });
} catch (error) {
  await shutdown();
  throw error;
}
log.info({ event: "server.started", origin: config.APP_ORIGIN });
// The moderation sweep (docs/specs/CONTENT_FILTER.md, «Изоляция и удаление»):
// reminders a day before a scheduled deletion, deletions that are due, and
// revisions the models could not check yet. Hourly, and once after start.
const sweep = async () => {
  try {
    const { sweepBlocks, retryUnchecked } = await import("./content-moderation.ts");
    await sweepBlocks();
    await retryUnchecked();
    // A work deleted for good whose objects a crash left behind (artifact-purge.ts).
    await (await import("./artifact-purge.ts")).finishPendingArtifactPurges();
  } catch {
    log.error({ event: "moderation.sweep_failed" });
  }
};
// Letters to the author about a link under review (review-mail.ts): every few minutes.
const reviewLetters = async () => {
  try {
    await (await import("./review-mail.ts")).sendReviewLetters();
  } catch {
    log.error({ event: "review_mail.failed" });
  }
};
every(5 * 60 * 1000, background(reviewLetters));
// Webhooks (webhooks.ts, WEBHOOKS=on): new events to deliveries, and due
// deliveries out, each on its own timer so a slow receiver never holds up
// the journal. Expiring old deliveries runs hourly whatever the flag.
if (config.WEBHOOKS === "on") {
  // A module that fails to load is logged once; the timers then do nothing.
  const webhooks = import("./webhooks.ts").catch(() => {
    log.error({ event: "webhooks.load_failed" });
    return null;
  });
  every(
    5_000,
    background(() => webhooks.then((module) => module?.runWebhookDispatch())),
  );
  every(
    5_000,
    background(() => webhooks.then((module) => module?.runWebhookSend())),
  );
}
const webhookHousekeeping = async () => {
  try {
    await (await import("./webhooks.ts")).expireWebhookDeliveries();
  } catch {
    log.error({ event: "webhooks.housekeeping_failed" });
  }
};
every(60 * 60 * 1000, background(webhookHousekeeping));
timers.push(setTimeout(background(sweep), 30_000).unref());
every(60 * 60 * 1000, background(sweep));
if (viewer) log.info({ event: "viewer.started", mode: config.HTML_LIVE_MODE });
// SIGTERM/SIGINT: stop taking work, let the running work finish, close
// (shutdown.ts). The deadline stays below stop_grace_period in compose.
const stop = installShutdown({
  steps: { intake, drain: settled, close },
  deadlineMs: config.SHUTDOWN_GRACE_SECONDS * 1000,
});
// Self-healing (watchdog.ts): a process that hangs exits for Docker to restart it.
const stopLoopWatchdog = startEventLoopWatchdog({ limitMs: config.WATCHDOG_EVENT_LOOP_SECONDS * 1000 });
const stopPoolWatchdog = startPoolWatchdog({
  pool: db,
  limitMs: config.WATCHDOG_POOL_STALL_SECONDS * 1000,
  onStall: () => void stop(1),
});
stopWatchdogs = () => {
  stopLoopWatchdog();
  stopPoolWatchdog();
};
