#!/usr/bin/env node
// CI smoke for a built image: migrate a fresh database, check storage, start the
// app and require /healthz and /readyz. Uses the disposable local fixtures only.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const image = process.argv[2];
if (!image) throw new Error("Usage: image-smoke.mjs <image>");
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const suffix = randomBytes(6).toString("hex");
const database = new URL(env.DATABASE_URL);
database.pathname = `/polka_smoke_${suffix}`;
const bucket = `polka-smoke-${suffix}`;
const runtime = {
  DATABASE_URL: database.href,
  S3_ENDPOINT: env.S3_ENDPOINT,
  S3_ACCESS_KEY: env.S3_ACCESS_KEY,
  S3_SECRET_KEY: env.S3_SECRET_KEY,
  S3_BUCKET: bucket,
  LINK_KEY: randomBytes(32).toString("hex"),
  APP_ORIGIN: "http://127.0.0.1:4390",
  HOST: "127.0.0.1",
  PORT: "4390",
  COOKIE_SECURE: "false",
  HTML_LIVE_ENABLED: "false",
  ACCOUNT_DELETION_ENABLED: "false",
  MAIL_MODE: "disabled",
};
const envArgs = Object.entries(runtime).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
const run = (args, options = {}) =>
  execFileSync("docker", args, { stdio: "inherit", ...options });

execFileSync(
  "docker",
  ["compose", "--env-file=.env", "-f", "deploy/compose.local.yml", "exec", "-T",
   "postgres", "createdb", "-U", "polka", `polka_smoke_${suffix}`],
  { stdio: "inherit" },
);
const base = ["run", "--rm", "--network=host", "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", ...envArgs, image];
run([...base, "node", "--import", "tsx", "scripts/migrate.ts"]);
run([...base, "node", "--import", "tsx", "scripts/local-storage-bootstrap.ts",
  "--confirm-local-bootstrap"]);
run([...base, "node", "--import", "tsx", "scripts/storage-check.ts", "--confirm-bootstrap"]);

const name = `polka-smoke-${suffix}`;
run(["run", "-d", "--name", name, "--network=host", "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", ...envArgs, image]);
try {
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const health = await fetch("http://127.0.0.1:4390/healthz");
      const readiness = await fetch("http://127.0.0.1:4390/readyz");
      ready = health.ok && readiness.ok;
    } catch {}
  }
  if (!ready) throw new Error("Image did not become ready");
  const page = await fetch("http://127.0.0.1:4390/");
  if (!page.ok) throw new Error(`Front page returned ${page.status}`);
  console.log("Image smoke passed");
} finally {
  spawnSync("docker", ["logs", "--tail", "50", name], { stdio: "inherit" });
  spawnSync("docker", ["rm", "-f", name], { stdio: "inherit" });
}
