#!/usr/bin/env node
// CI smoke for a built image, in the hosted role layout: a schema owner runs
// migrations, deploy/runtime-grants.sql grants an unprivileged runtime login,
// and storage-check and the app run as that runtime role (never as the
// superuser). Requires /healthz, /readyz and the front page. Uses the
// disposable local fixtures only and drops its database and roles afterwards.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const image = process.argv[2];
if (!image) throw new Error("Usage: image-smoke.mjs <image>");
// Provisions the fixed polka-local bucket, so only run on disposable CI infra.
if (process.env.CI !== "true") throw new Error("Image smoke runs only in CI");
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const suffix = randomBytes(6).toString("hex");
const databaseName = `polka_smoke_${suffix}`;
const schemaRole = `polka_smoke_schema_${suffix}`;
const runtimeRole = `polka_smoke_runtime_${suffix}`;
const schemaPassword = randomBytes(24).toString("hex");
const runtimePassword = randomBytes(24).toString("hex");
const roleUrl = (role, password) => {
  const url = new URL(env.DATABASE_URL);
  url.username = role;
  url.password = password;
  url.pathname = `/${databaseName}`;
  return url.href;
};
const bucket = "polka-local";
const port = process.env.SMOKE_PORT ?? "4390";
const origin = `http://127.0.0.1:${port}`;
const runtime = {
  DATABASE_URL: roleUrl(runtimeRole, runtimePassword),
  S3_ENDPOINT: env.S3_ENDPOINT,
  S3_ACCESS_KEY: env.S3_ACCESS_KEY,
  S3_SECRET_KEY: env.S3_SECRET_KEY,
  S3_BUCKET: bucket,
  LINK_KEY: randomBytes(32).toString("hex"),
  APP_ORIGIN: origin,
  HOST: "127.0.0.1",
  PORT: port,
  COOKIE_SECURE: "false",
  HTML_LIVE_MODE: "disabled",
  ACCOUNT_DELETION_ENABLED: "false",
  MAIL_MODE: "disabled",
};
const envArgs = (values) => Object.entries(values).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
const run = (args, options = {}) =>
  execFileSync("docker", args, { stdio: "inherit", ...options });
const compose = ["compose", "--env-file=.env", "-f", "deploy/compose.local.yml"];
// Local socket inside the fixture container; SQL goes over stdin, never argv.
const psql = (user, database, sql, variables = {}) =>
  execFileSync(
    "docker",
    [...compose, "exec", "-T", "postgres", "psql", "-X", "-q", "--set=ON_ERROR_STOP=1",
     "-U", user, "-d", database,
     ...Object.entries(variables).map(([k, v]) => `--set=${k}=${v}`), "-f", "-"],
    { input: sql, stdio: ["pipe", "inherit", "inherit"] },
  );

// Same shape as deploy/hosted/init-roles.sh, with random names and passwords.
psql("polka", "polka", `
CREATE ROLE ${schemaRole} LOGIN PASSWORD :'schema_password';
CREATE ROLE ${runtimeRole} LOGIN PASSWORD :'runtime_password';
CREATE DATABASE ${databaseName};
REVOKE ALL ON DATABASE ${databaseName} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${databaseName} TO ${schemaRole}, ${runtimeRole};
ALTER ROLE ${runtimeRole} SET search_path = pg_catalog, public;
\\connect ${databaseName}
ALTER SCHEMA public OWNER TO ${schemaRole};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${schemaRole} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
`, { schema_password: schemaPassword, runtime_password: runtimePassword });

const name = `polka-smoke-${suffix}`;
try {
  const base = ["run", "--rm", "--network=host", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"];
  // The migration job gets only the schema owner's URL, as in compose.
  run([...base, ...envArgs({ DATABASE_URL: roleUrl(schemaRole, schemaPassword) }), image,
    "node", "--import", "tsx", "scripts/migrate.ts"]);
  psql(schemaRole, databaseName, readFileSync("deploy/runtime-grants.sql", "utf8"),
    { schema_owner: schemaRole, runtime_role: runtimeRole });
  run([...base, ...envArgs(runtime), image, "node", "--import", "tsx",
    "scripts/local-storage-bootstrap.ts", "--confirm-local-bootstrap"]);
  run([...base, ...envArgs(runtime), image, "node", "--import", "tsx",
    "scripts/storage-check.ts", "--confirm-bootstrap"]);

  // The runtime builder's memory-limited esbuild wrapper must start in the image.
  const esbuild = execFileSync("docker", [...base, "--user", "node", "--entrypoint", "sh", image, "-c",
    "POLKA_ESBUILD_BINARY=$(node -p \"require.resolve('@esbuild/linux-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '/bin/esbuild')\") apps/server/esbuild-limited.sh --version"],
    { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(esbuild)) throw new Error("Limited esbuild did not start");

  run(["run", "-d", "--name", name, "--network=host", "--read-only", "--user", "node",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", ...envArgs(runtime), image]);
  // Probe from inside the container: its loopback listener is the one the
  // hosted reverse proxy reaches (and Docker Desktop does not expose it).
  const status = (path) =>
    spawnSync("docker", ["exec", name, "node", "-e",
      `fetch(${JSON.stringify(origin + path)},{signal:AbortSignal.timeout(2000)})` +
      ".then(r=>process.stdout.write(String(r.status)),()=>process.stdout.write('0'))"],
    { encoding: "utf8" }).stdout;
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    ready = status("/healthz") === "200" && status("/readyz") === "200";
  }
  if (!ready) throw new Error("Image did not become ready");
  const page = status("/");
  if (page !== "200") throw new Error(`Front page returned ${page}`);
  console.log("Image smoke passed (app ran as the runtime role)");
} finally {
  spawnSync("docker", ["logs", "--tail", "50", name], { stdio: "inherit" });
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  psql("polka", "polka", `
DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);
DROP ROLE IF EXISTS ${runtimeRole};
DROP ROLE IF EXISTS ${schemaRole};
`);
}
