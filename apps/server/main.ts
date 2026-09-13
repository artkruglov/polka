import { registerFrontend } from "./frontend.ts";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { s3 } from "./storage.ts";
const app = await createApp();
await registerFrontend(
  app,
  fileURLToPath(new URL("../../dist", import.meta.url)),
);
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`Polka is available at ${config.APP_ORIGIN}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    await db.end();
    s3.destroy();
    process.exit(0);
  });
