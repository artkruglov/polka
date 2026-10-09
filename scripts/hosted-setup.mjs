// Writes deploy/hosted/hosted.env for a new installation from
// hosted.env.example: the hosts you name, fresh database passwords, LINK_KEY
// and OPS_STATUS_TOKEN, and the S3 settings you pass. Secrets are generated
// here and never printed; S3 keys come from the environment, not the command
// line, so they stay out of shell history. An existing file is kept unless
// --force. Afterwards it lists what is still empty and required.
//
//   S3_ACCESS_KEY=… S3_SECRET_KEY=… BACKUP_S3_ACCESS_KEY=… BACKUP_S3_SECRET_KEY=… \
//   npm run hosted:setup -- --app-host polka.company.ru --viewer-host polka-view.company.net \
//     --s3-endpoint https://storage.yandexcloud.net --s3-region ru-central1 \
//     --s3-bucket company-polka-objects --backup-bucket company-polka-backups \
//     --image polka:v0.12.1 --live [--set TEAM_SHELVES=on] [--out path] [--force]
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "deploy/hosted/hosted.env.example");

/** Keys compose refuses to start without (`${KEY:?}` in deploy/hosted/compose.yml). */
const REQUIRED = [
  "APP_HOST",
  "VIEWER_HOST_NAME",
  "POLKA_IMAGE",
  "POSTGRES_ADMIN_PASSWORD",
  "POLKA_SCHEMA_PASSWORD",
  "POLKA_RUNTIME_PASSWORD",
  "LINK_KEY",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "BACKUP_BUCKET",
  "BACKUP_S3_ACCESS_KEY",
  "BACKUP_S3_SECRET_KEY",
];
const FROM_ENV = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY"];
const FLAGS = {
  "--app-host": "APP_HOST",
  "--viewer-host": "VIEWER_HOST_NAME",
  "--image": "POLKA_IMAGE",
  "--s3-endpoint": "S3_ENDPOINT",
  "--s3-region": "S3_REGION",
  "--s3-bucket": "S3_BUCKET",
  "--backup-bucket": "BACKUP_BUCKET",
};
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function fail(message) {
  console.error(`hosted:setup: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const values = {};
let out = join(root, "deploy/hosted/hosted.env");
let force = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--force") force = true;
  else if (arg === "--live") values.HTML_LIVE_MODE = "production";
  else if (arg === "--out") out = resolve(args[++i] ?? fail("--out needs a path"));
  else if (arg === "--set") {
    const pair = args[++i] ?? fail("--set needs KEY=VALUE");
    const at = pair.indexOf("=");
    if (at < 1) fail(`--set ${pair}: expected KEY=VALUE`);
    values[pair.slice(0, at)] = pair.slice(at + 1);
  } else if (FLAGS[arg]) values[FLAGS[arg]] = args[++i] ?? fail(`${arg} needs a value`);
  else fail(`unknown argument ${arg}`);
}
for (const key of FROM_ENV) if (process.env[key]) values[key] = process.env[key];

for (const key of ["APP_HOST", "VIEWER_HOST_NAME"])
  if (values[key] && !HOST.test(values[key])) fail(`${key} must be a host name like polka.company.ru`);
if (values.APP_HOST && values.APP_HOST === values.VIEWER_HOST_NAME)
  fail("the viewer needs its own host, ideally on another registrable domain");
if (values.S3_ENDPOINT && !/^https?:\/\/[^\s/]+\/?$/.test(values.S3_ENDPOINT))
  fail("S3_ENDPOINT must be a URL like https://storage.example.com");
if (values.S3_SECRET_KEY && values.S3_SECRET_KEY.length < 16)
  fail("S3_SECRET_KEY must be at least 16 characters");
if (values.S3_ACCESS_KEY && values.S3_ACCESS_KEY === values.BACKUP_S3_ACCESS_KEY)
  fail("the backup job needs its own write-only key, not the app's");
for (const [key, value] of Object.entries(values))
  if (/[\r\n]/.test(value)) fail(`${key} must be one line`);

if (existsSync(out) && !force) fail(`${out} exists; pass --force to replace it`);

const lines = readFileSync(example, "utf8").split("\n");
const known = new Set(lines.map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean));
for (const key of Object.keys(values)) if (!known.has(key)) fail(`${key} is not a setting of hosted.env.example`);

const hex = (bytes) => randomBytes(bytes).toString("hex");
const generated = {
  POSTGRES_ADMIN_PASSWORD: hex(24),
  POLKA_SCHEMA_PASSWORD: hex(24),
  POLKA_RUNTIME_PASSWORD: hex(24),
  LINK_KEY: hex(32),
  OPS_STATUS_TOKEN: hex(32),
};
const final = {};
const written = lines.map((line) => {
  const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
  if (!key) return line;
  const value = values[key] ?? generated[key] ?? line.slice(key.length + 1);
  final[key] = value;
  return `${key}=${value}`;
});
writeFileSync(out, written.join("\n"), { mode: 0o600 });
chmodSync(out, 0o600);

const missing = REQUIRED.filter((key) => !final[key] || /example\.(com|net)/.test(final[key]));
console.log(`wrote ${out} (600): generated ${Object.keys(generated).join(", ")}`);
if (missing.length) console.log(`still to fill: ${missing.join(", ")}`);
else console.log("every required setting is filled; keep a copy of LINK_KEY in your secret manager");
