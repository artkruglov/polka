import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const baseEnv = {
  DATABASE_URL: "postgres://runtime:password@example.invalid:5432/polka",
  S3_ENDPOINT: "https://objects.example.invalid",
  S3_ACCESS_KEY: "synthetic-access",
  S3_SECRET_KEY: "synthetic-storage-secret",
  S3_BUCKET: "synthetic-bucket",
  LINK_KEY: "a".repeat(64),
  APP_ORIGIN: "https://app.example.invalid",
  HOST: "127.0.0.1",
  PORT: "4390",
  HTML_LIVE_ENABLED: "false",
  VIEWER_ORIGIN: "http://localhost:4391",
  VIEWER_HOST: "localhost",
  VIEWER_PORT: "4391",
  MAIL_MODE: "disabled",
  COOKIE_SECURE: "true",
};

function loadConfig(extra: Record<string, string | undefined> = {}) {
  const env = { ...baseEnv, ...extra };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key as keyof typeof env];
  }
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import('./apps/server/config.ts').then(({config}) => console.log(JSON.stringify({ enabled: config.ACCOUNT_DELETION_ENABLED })))",
    ],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined, result.error?.message ?? "Config subprocess failed");
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of [env.S3_SECRET_KEY, env.LINK_KEY, "postgres://runtime:password"]) {
    assert.equal(output.includes(value), false, "config subprocess leaked a synthetic secret");
  }
  return result;
}

test("account deletion defaults off without policy settings", () => {
  const result = loadConfig({ ACCOUNT_DELETION_ENABLED: undefined });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"enabled":false/);
});

test("accepts explicit loopback HTTP deletion policy", () => {
  const result = loadConfig({
    ACCOUNT_DELETION_ENABLED: "true",
    APP_ORIGIN: "http://127.0.0.1:4390",
    HOST: "127.0.0.1",
    ACCOUNT_PURGE_MAX_HOURS: "24",
    BACKUP_RETENTION_MAX_DAYS: "30",
    ACCOUNT_DELETION_POLICY_VERSION: "r17-v1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"enabled":true/);
});

test("rejects enabled deletion for a remote HTTP origin", () => {
  const result = loadConfig({
    ACCOUNT_DELETION_ENABLED: "true",
    APP_ORIGIN: "http://app.example.invalid",
    HOST: "app.example.invalid",
    ACCOUNT_PURGE_MAX_HOURS: "24",
    BACKUP_RETENTION_MAX_DAYS: "30",
    ACCOUNT_DELETION_POLICY_VERSION: "r17-v1",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Experimental account deletion requires HTTP loopback/);
});

test("rejects enabled deletion for an HTTPS loopback origin or host mismatch", () => {
  for (const extra of [
    {
      ACCOUNT_DELETION_ENABLED: "true",
      APP_ORIGIN: "https://127.0.0.1:4390",
      HOST: "127.0.0.1",
      ACCOUNT_PURGE_MAX_HOURS: "24",
      BACKUP_RETENTION_MAX_DAYS: "30",
      ACCOUNT_DELETION_POLICY_VERSION: "r17-v1",
    },
    {
      ACCOUNT_DELETION_ENABLED: "true",
      APP_ORIGIN: "http://127.0.0.1:4390",
      HOST: "localhost",
      ACCOUNT_PURGE_MAX_HOURS: "24",
      BACKUP_RETENTION_MAX_DAYS: "30",
      ACCOUNT_DELETION_POLICY_VERSION: "r17-v1",
    },
  ]) {
    const result = loadConfig(extra);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Experimental account deletion requires HTTP loopback/);
  }
});

test("rejects enabled deletion when policy is missing or invalid", () => {
  const missing = loadConfig({
    ACCOUNT_DELETION_ENABLED: "true",
    APP_ORIGIN: "http://127.0.0.1:4390",
    HOST: "127.0.0.1",
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /Account deletion policy settings are required/);

  const invalid = loadConfig({
    ACCOUNT_DELETION_ENABLED: "true",
    APP_ORIGIN: "http://127.0.0.1:4390",
    HOST: "127.0.0.1",
    ACCOUNT_PURGE_MAX_HOURS: "0",
    BACKUP_RETENTION_MAX_DAYS: "30",
    ACCOUNT_DELETION_POLICY_VERSION: "r17-v1",
  });
  assert.notEqual(invalid.status, 0);
});
