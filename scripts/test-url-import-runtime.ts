import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { runMigrations } from "./migration-runner.ts";
import { SCHEMA_MIGRATIONS, migrationFileUrl } from "../packages/migrations.ts";

// Only this randomly named database is migrated and dropped. The configured
// application database supplies a local connection, never a migration target.
const source = new URL(process.env.DATABASE_URL!);
if (!["127.0.0.1", "localhost", "[::1]"].includes(source.hostname))
  throw new Error(
    "This test requires a local PostgreSQL server with CREATEDB.",
  );
const name = "polka_import_test_" + randomBytes(8).toString("hex");
const admin = new pg.Client({ connectionString: source.href });
await admin.connect();
const restricted = process.argv.includes("--restricted");
const runtimeRole = "polka_import_role_" + randomBytes(8).toString("hex");
const runtimePassword = randomBytes(32).toString("hex");
let roleCreated = false;
let created = false;
try {
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const target = new URL(source);
  target.pathname = "/" + name;
  const client = new pg.Client({ connectionString: target.href });
  await client.connect();
  try {
    if (restricted) {
      const owner = (await client.query("SELECT current_user AS name")).rows[0]
        .name as string;
      await client.query(
        `ALTER SCHEMA public OWNER TO "${owner.replaceAll('"', '""')}"`,
      );
    }
    await runMigrations(client, SCHEMA_MIGRATIONS, (file) =>
      readFile(migrationFileUrl(file), "utf8"),
    );
  } finally {
    await client.end();
  }
  if (restricted) {
    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    roleCreated = true;
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${runtimeRole}`);
    const owner = (await admin.query("SELECT current_user AS name")).rows[0]
      .name as string;
    const container = execFileSync(
      "docker",
      ["compose", "-f", "deploy/compose.local.yml", "ps", "-q", "postgres"],
      { encoding: "utf8", timeout: 10000 },
    ).trim();
    if (!/^[a-f0-9]{12,64}$/.test(container))
      throw new Error("Local PostgreSQL container unavailable");
    // Exact operator recipe, credentials on stdin, no SQL/password in argv or output.
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "timeout",
        "30",
        "sh",
        "-c",
        'IFS= read -r PGPASSWORD; export PGPASSWORD PGCONNECT_TIMEOUT=5; exec psql -X -h 127.0.0.1 -U "$1" -d "$2" --set=ON_ERROR_STOP=1 --set="schema_owner=$1" --set="runtime_role=$3"',
        "runtime-import",
        owner,
        name,
        runtimeRole,
      ],
      {
        input:
          decodeURIComponent(source.password) +
          "\n" +
          (await readFile(
            new URL("../deploy/runtime-grants.sql", import.meta.url),
            "utf8",
          )),
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 35000,
      },
    );
    target.username = runtimeRole;
    target.password = runtimePassword;
  }
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(
    process.execPath,
    process.argv.includes("--browser")
      ? ["--import", "tsx", "scripts/url-import-browser-check.ts"]
      : ["--import", "tsx", "--test", process.argv.includes("--library-access")
          ? "tests/template-library-access.test.ts"
          : "tests/url-import-runtime.test.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: target.href,
        URL_IMPORT_EXPECT_RUNTIME_ROLE: restricted ? runtimeRole : "",
        URL_IMPORT_PUBLIC_SOURCE_CHECK: process.argv.includes("--public-source")
          ? "true"
          : "false",
        URL_IMPORT_ENABLED: "true",
        HTML_LIVE_ENABLED: "true",
        APP_ORIGIN: `http://127.0.0.1:${port}`,
        HOST: "127.0.0.1",
        PORT: String(port),
        COOKIE_SECURE: "false",
        VIEWER_ORIGIN: "http://localhost:4599",
        VIEWER_HOST: "localhost",
        VIEWER_PORT: "4599",
      },
    },
  );
  // Forward parent termination, then wait for the fixture to finish its object
  // cleanup before the outer finally removes its database and runtime role.
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    process.exitCode = interrupted ? 130 : code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
} finally {
  try {
    if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    if (roleCreated) await admin.query(`DROP ROLE ${runtimeRole}`);
    const remains = await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS found",
      [name, runtimeRole],
    );
    if (remains.rows[0].found)
      throw new Error("Synthetic database/role cleanup incomplete");
    console.log(
      JSON.stringify({
        event: "url-import-runtime.cleanup",
        restricted,
        databaseAndRoleRemoved: true,
        workingDatabaseModified: false,
      }),
    );
  } finally {
    await admin.end();
  }
}
