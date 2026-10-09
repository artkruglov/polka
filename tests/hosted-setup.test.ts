// scripts/hosted-setup.mjs: a new installation's hosted.env with generated
// secrets, the hosts and S3 settings given, nothing printed that is secret.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/hosted-setup.mjs", import.meta.url));
const compose = readFileSync(new URL("../deploy/hosted/compose.yml", import.meta.url), "utf8");
const parse = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .flatMap((line) =>
        /^[A-Z0-9_]+=/.test(line) ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]] : [],
      ),
  );
const keys = {
  S3_ACCESS_KEY: "app-access-key",
  S3_SECRET_KEY: "app-secret-key-0123456789",
  BACKUP_S3_ACCESS_KEY: "backup-access-key",
  BACKUP_S3_SECRET_KEY: "backup-secret-key-0123456789",
};
const flags = [
  "--app-host",
  "polka.company.test",
  "--viewer-host",
  "polka-view.company.example",
  "--s3-endpoint",
  "https://storage.example.org",
  "--s3-region",
  "ru-central1",
  "--s3-bucket",
  "c-objects",
  "--backup-bucket",
  "c-backups",
  "--image",
  "polka:v0.12.1",
  "--live",
  "--set",
  "TEAM_SHELVES=on",
];
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

test("hosted:setup fills every required setting and generates distinct secrets", () => {
  const out = join(mkdtempSync(join(tmpdir(), "hosted-setup-")), "hosted.env");
  const res = run([...flags, "--out", out], keys);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const env = parse(readFileSync(out, "utf8"));
  // Every ${KEY:?} of the compose file has a value.
  const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]);
  for (const key of new Set(required)) assert.ok(env[key], `${key} is empty`);
  assert.equal(env.APP_HOST, "polka.company.test");
  assert.equal(env.HTML_LIVE_MODE, "production");
  assert.equal(env.TEAM_SHELVES, "on");
  assert.equal(env.S3_SECRET_KEY, keys.S3_SECRET_KEY);
  for (const key of ["POSTGRES_ADMIN_PASSWORD", "POLKA_SCHEMA_PASSWORD", "POLKA_RUNTIME_PASSWORD"])
    assert.match(env[key], /^[0-9a-f]{48}$/);
  assert.match(env.LINK_KEY, /^[0-9a-f]{64}$/);
  assert.equal(
    new Set([
      env.POSTGRES_ADMIN_PASSWORD,
      env.POLKA_SCHEMA_PASSWORD,
      env.POLKA_RUNTIME_PASSWORD,
      env.LINK_KEY,
      env.OPS_STATUS_TOKEN,
    ]).size,
    5,
  );
  // Comments of the example survive; nothing secret is printed.
  assert.match(readFileSync(out, "utf8"), /Keep LINK_KEY stable/);
  for (const secret of [env.LINK_KEY, env.POSTGRES_ADMIN_PASSWORD, keys.S3_SECRET_KEY])
    assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret));
  assert.match(res.stdout, /every required setting is filled/);
  // A second run keeps the file unless --force, and --force makes new secrets.
  assert.notEqual(run([...flags, "--out", out], keys).status, 0);
  assert.equal(run([...flags, "--out", out, "--force"], keys).status, 0);
  assert.notEqual(parse(readFileSync(out, "utf8")).LINK_KEY, env.LINK_KEY);
});

test("hosted:setup lists what is missing and refuses wrong input", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-setup-"));
  const partial = run([
    "--app-host",
    "polka.company.test",
    "--viewer-host",
    "view.company.example",
    "--out",
    join(dir, "a.env"),
  ]);
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /still to fill: .*POLKA_IMAGE.*S3_ENDPOINT.*S3_ACCESS_KEY/);
  for (const [args, env, why] of [
    [["--app-host", "same.company.test", "--viewer-host", "same.company.test"], {}, /its own host/],
    [["--app-host", "not a host"], {}, /host name/],
    [["--set", "NOT_A_SETTING=1"], {}, /not a setting/],
    [["--set", "TEAM_SHELVES=on\nLINK_KEY=x"], {}, /one line/],
    [[], { S3_SECRET_KEY: "short" }, /16 characters/],
    [[], { S3_ACCESS_KEY: "same", BACKUP_S3_ACCESS_KEY: "same" }, /its own write-only key/],
    [["--bogus"], {}, /unknown argument/],
  ] as Array<[string[], Record<string, string>, RegExp]>) {
    const res = run([...args, "--out", join(dir, `${Math.random()}.env`)], env);
    assert.notEqual(res.status, 0, String(why));
    assert.match(res.stderr, why);
  }
});

test("hosted:setup is the npm script the deploy guide names", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["hosted:setup"], "node scripts/hosted-setup.mjs");
  assert.match(readFileSync(new URL("../deploy/hosted/README.md", import.meta.url), "utf8"), /npm run hosted:setup/);
  void execFileSync;
  void writeFileSync;
});
