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
  assert.match(res.stdout, /still to fill: OPERATOR_CONTACT$/m);
  // A second run keeps the file unless --force.
  assert.notEqual(run([...flags, "--out", out], keys).status, 0);
  // --force updates it: secrets, keys and earlier settings stay, what is given again changes.
  writeFileSync(out, `${readFileSync(out, "utf8")}\nBACKUP_INTERVAL_SECONDS=3600\n`);
  const update = run(["--out", out, "--force", "--set", "OPERATOR_CONTACT=privacy@company.test"]);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /every required setting is filled/);
  const updated = parse(readFileSync(out, "utf8"));
  for (const key of [
    "POSTGRES_ADMIN_PASSWORD",
    "POLKA_SCHEMA_PASSWORD",
    "POLKA_RUNTIME_PASSWORD",
    "LINK_KEY",
    "OPS_STATUS_TOKEN",
    "S3_SECRET_KEY",
    "APP_HOST",
    "HTML_LIVE_MODE",
  ])
    assert.equal(updated[key], env[key], key);
  assert.equal(updated.OPERATOR_CONTACT, "privacy@company.test");
  assert.equal(updated.BACKUP_INTERVAL_SECONDS, "3600");
  assert.equal(statSync(out).mode & 0o777, 0o600);
  // --rotate makes new secrets on purpose, and only with --force.
  assert.match(run(["--out", out, "--rotate"]).stderr, /with --force/);
  const rotated = run(["--out", out, "--force", "--rotate"]);
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.match(rotated.stdout, /ALTER ROLE/);
  const after = parse(readFileSync(out, "utf8"));
  assert.notEqual(after.LINK_KEY, env.LINK_KEY);
  assert.notEqual(after.POLKA_RUNTIME_PASSWORD, env.POLKA_RUNTIME_PASSWORD);
  assert.equal(after.S3_SECRET_KEY, env.S3_SECRET_KEY);
});

test("hosted:setup refuses a viewer on the app's registrable domain", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-setup-"));
  for (const [app, viewer] of [
    ["polka.company.ru", "view.company.ru"],
    ["polka.company.ru", "company.ru"],
    ["polka.company.co.uk", "viewer.company.co.uk"],
    ["polka.company.com.ru", "v.company.com.ru"],
  ]) {
    const res = run(["--app-host", app, "--viewer-host", viewer, "--out", join(dir, `${Math.random()}.env`)]);
    assert.notEqual(res.status, 0, `${app} ${viewer}`);
    assert.match(res.stderr, /another registrable domain/);
  }
  for (const [app, viewer] of [
    ["polka.company.ru", "polka-view.company.net"],
    ["polka.one.co.uk", "polka.two.co.uk"],
  ]) {
    const res = run(["--app-host", app, "--viewer-host", viewer, "--out", join(dir, `${Math.random()}.env`)]);
    assert.equal(res.status, 0, `${app} ${viewer}: ${res.stderr}`);
  }
});

test("the example suits a company: no model without a key, no polochka.app contact, one company per installation", () => {
  const example = parse(readFileSync(new URL("../deploy/hosted/hosted.env.example", import.meta.url), "utf8"));
  assert.equal(example.CONTENT_MODEL_PROVIDER, "off");
  assert.equal(example.OPERATOR_CONTACT, "");
  assert.equal(example.TEAM_SHELVES_SCOPE, "installation");
  assert.doesNotMatch(JSON.stringify(example), /polochka\.app/);
  // Every OIDC_* the compose file passes can be set with --set.
  const oidc = new Set([...compose.matchAll(/^\s+(OIDC_[A-Z_]+):/gm)].map((m) => m[1]));
  assert.ok(oidc.size >= 5);
  for (const key of oidc) assert.ok(key in example, `${key} is missing from the example`);
  assert.match(compose, /TEAM_SHELVES_SCOPE: \$\{TEAM_SHELVES_SCOPE:-installation\}/);
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
    [["--rotate"], {}, /with --force/],
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

test("published images and mail/IdP secrets from the environment (install.sh)", () => {
  const out = join(mkdtempSync(join(tmpdir(), "hosted-setup-")), "hosted.env");
  const secrets = { ...keys, SMTP_PASS: "smtp-password-123", OIDC_CLIENT_SECRET: "oidc-secret-456" };
  const res = run(
    [
      ...flags.filter((flag) => flag !== "polka:v0.12.1" && flag !== "--image"),
      "--image",
      "ghcr.io/artkruglov/polka:0.16.0",
      "--backup-image",
      "ghcr.io/artkruglov/polka-backup:0.16.0",
      "--set",
      "MAIL_MODE=smtp",
      "--out",
      out,
    ],
    secrets,
  );
  assert.equal(res.status, 0, res.stderr);
  const env = parse(readFileSync(out, "utf8"));
  assert.equal(env.POLKA_IMAGE, "ghcr.io/artkruglov/polka:0.16.0");
  assert.equal(env.POLKA_BACKUP_IMAGE, "ghcr.io/artkruglov/polka-backup:0.16.0");
  assert.equal(env.SMTP_PASS, secrets.SMTP_PASS);
  assert.equal(env.OIDC_CLIENT_SECRET, secrets.OIDC_CLIENT_SECRET);
  for (const secret of [secrets.SMTP_PASS, secrets.OIDC_CLIENT_SECRET])
    assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret));
  // compose.yml takes the backup image from hosted.env and still builds without it.
  assert.match(compose, /image: \$\{POLKA_BACKUP_IMAGE:-polka-backup:local\}/);
  assert.match(compose, /build: \.\/backup/);
});

test("the image carries what install.sh needs, and nothing secret", () => {
  const ignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  for (const path of [
    "scripts/hosted-setup.mjs",
    "deploy/hosted/compose.yml",
    "deploy/hosted/hosted.env.example",
    "deploy/hosted/install.sh",
    "deploy/runtime-grants.sql",
  ])
    assert.match(ignore, new RegExp(`^!${path.replace(/[.]/g, "\\.")}$`, "m"), path);
  // Files are allowed one by one: no pattern that would let hosted.env in.
  assert.doesNotMatch(ignore, /^!deploy\/hosted\/\*/m);
  assert.match(ignore, /^\*\*\/\*\.env$/m);
});

test("hosted:setup is the npm script the deploy guide names", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["hosted:setup"], "node scripts/hosted-setup.mjs");
  assert.match(readFileSync(new URL("../deploy/hosted/README.md", import.meta.url), "utf8"), /npm run hosted:setup/);
  void execFileSync;
  void writeFileSync;
});
