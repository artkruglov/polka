import { registerFrontend } from "./frontend.ts";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { createHealthAdapters } from "./health-adapters.ts";
import { registerHealthRoutes } from "./health-routes.ts";
import { createHealthCoordinator } from "./health.ts";
import { createLiveViewerApp } from "./live-viewer.ts";
import { s3 } from "./storage.ts";
import { EXPECTED_MIGRATION_VERSIONS } from "../../packages/migrations.ts";
import { assertRestoreStartupGate } from "./restore-gate.ts";
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
async function shutdown() {
  health.stop();
  await Promise.allSettled([app.close(), viewer?.close()]);
  await Promise.allSettled([healthAdapters.close(), db.end()]);
  s3.destroy();
}
try {
  await registerHealthRoutes(app, health);
  viewer = config.HTML_LIVE_ENABLED ? await createLiveViewerApp() : null;
  await registerFrontend(
    app,
    fileURLToPath(new URL("../../dist", import.meta.url)),
  );
  await app.listen({ host: config.HOST, port: config.PORT });
  if (viewer)
    await viewer.listen({ host: config.VIEWER_HOST, port: config.VIEWER_PORT });
} catch (error) {
  await shutdown();
  throw error;
}
console.log(`Polka is available at ${config.APP_ORIGIN}`);
// The moderation sweep (docs/specs/CONTENT_FILTER.md, «Изоляция и удаление»):
// reminders a day before a scheduled deletion, deletions that are due, and
// revisions the models could not check yet. Hourly, and once after start.
const sweep = async () => {
  try {
    const { sweepBlocks, retryUnchecked } = await import("./content-moderation.ts");
    await sweepBlocks();
    await retryUnchecked();
  } catch {
    console.error(JSON.stringify({ event: "moderation.sweep_failed" }));
  }
};
setTimeout(sweep, 30_000).unref();
setInterval(sweep, 60 * 60 * 1000).unref();
if (viewer)
  console.log(`Experimental ${config.HTML_LIVE_MODE} HTML viewer is enabled.`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await shutdown();
    process.exit(0);
  });
