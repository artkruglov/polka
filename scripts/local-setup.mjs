// Writes .env for local development with unique secrets; an existing .env is
// kept. Ports and the compose project name default to the values below and
// can be chosen once, at setup, from the environment:
//
//   POLKA_LOCAL_PROJECT=polka-two POLKA_LOCAL_PG_PORT=55432 \
//   POLKA_LOCAL_S3_PORT=9138 PORT=4490 VIEWER_PORT=4491 npm run local:setup
//
// The interactive viewer is on in its loopback-only local mode: the app on
// http://127.0.0.1:PORT, the viewer on http://localhost:VIEWER_PORT.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const project = process.env.POLKA_LOCAL_PROJECT || "polka-local";
if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
  throw new Error("POLKA_LOCAL_PROJECT: lowercase letters, digits, - and _ only");
const port = (name, fallback) => {
  const value = process.env[name] || fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error(`${name} must be a port number from 1024 to 65535`);
  return value;
};
const ports = {
  POLKA_LOCAL_PG_PORT: port("POLKA_LOCAL_PG_PORT", "54388"),
  POLKA_LOCAL_S3_PORT: port("POLKA_LOCAL_S3_PORT", "9038"),
  PORT: port("PORT", "4390"),
  VIEWER_PORT: port("VIEWER_PORT", "4391"),
};
if (new Set(Object.values(ports)).size !== 4)
  throw new Error("The four local ports must differ");

const password = randomBytes(24).toString("hex");
const storage = randomBytes(24).toString("hex");
const env = [
  "# Local development only. Never commit this file.",
  "# Compose project and loopback ports of deploy/compose.local.yml.",
  `POLKA_LOCAL_PROJECT=${project}`,
  `POLKA_LOCAL_PG_PORT=${ports.POLKA_LOCAL_PG_PORT}`,
  `POLKA_LOCAL_S3_PORT=${ports.POLKA_LOCAL_S3_PORT}`,
  `POSTGRES_PASSWORD=${password}`,
  `DATABASE_URL=postgres://polka:${password}@127.0.0.1:${ports.POLKA_LOCAL_PG_PORT}/polka`,
  `S3_ENDPOINT=http://127.0.0.1:${ports.POLKA_LOCAL_S3_PORT}`,
  "S3_ACCESS_KEY=polka-local",
  `S3_SECRET_KEY=${storage}`,
  "S3_BUCKET=polka-local",
  `LINK_KEY=${randomBytes(32).toString("hex")}`,
  `APP_ORIGIN=http://127.0.0.1:${ports.PORT}`,
  "HOST=127.0.0.1",
  `PORT=${ports.PORT}`,
  "COOKIE_SECURE=false",
  "# Interactive pages on this machine only (loopback, another hostname).",
  "HTML_LIVE_MODE=local",
  `VIEWER_ORIGIN=http://localhost:${ports.VIEWER_PORT}`,
  "VIEWER_HOST=localhost",
  `VIEWER_PORT=${ports.VIEWER_PORT}`,
  "",
].join("\n");

let created = true;
try {
  await writeFile(".env", env, { flag: "wx", mode: 0o600 });
  console.log("Local configuration created (.env).");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  created = false;
  console.log("Existing .env kept; the settings below come from it, not from this run.");
}
console.log(`
Next, in this order:
  npm run infra:up                           PostgreSQL and MinIO in Docker
  npm run db:migrate
  npm run storage:bootstrap-local            versioned bucket and its check
  npm run account:create -- demo --generate  login and password in .local/demo-account.txt
  npm run build
  npm run dev
${created ? `\nThen open http://127.0.0.1:${ports.PORT}/ (interactive pages on http://localhost:${ports.VIEWER_PORT}).\n` : ""}
If db:migrate fails to authenticate, the Docker volumes are from an older .env:
  docker compose --env-file=.env -f deploy/compose.local.yml down -v   (deletes local data)
then run infra:up again.`);
