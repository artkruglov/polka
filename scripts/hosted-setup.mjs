// Writes deploy/hosted/hosted.env for a new installation from
// hosted.env.example: the hosts you name, fresh database passwords, LINK_KEY
// and OPS_STATUS_TOKEN, and the S3 settings you pass. Secrets are generated
// here and never printed; S3 keys come from the environment, not the command
// line, so they stay out of shell history (so do SMTP_PASS and OIDC_CLIENT_SECRET). An existing file is kept unless
// --force; with --force every value already in it stays (the generated
// secrets included: new database passwords would lock the app out of its
// database, a new LINK_KEY breaks every link and webhook secret) unless you
// pass it again, and --rotate makes new secrets on purpose. Afterwards it
// lists what is still empty and required.
//
//   S3_ACCESS_KEY=… S3_SECRET_KEY=… BACKUP_S3_ACCESS_KEY=… BACKUP_S3_SECRET_KEY=… \
//   npm run hosted:setup -- --app-host polka.company.ru --viewer-host polka-view.company.net \
//     --s3-endpoint https://storage.yandexcloud.net --s3-region ru-central1 \
//     --s3-bucket company-polka-objects --backup-bucket company-polka-backups \
//     --image polka:v0.12.1 [--backup-image …] --live [--set TEAM_SHELVES=on] [--out path] [--force [--rotate]]
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
/** Not needed to start, but the installation owes them to its users. */
const TO_FILL = [
  // Where an owner appeals a block: shown on their shelf.
  "OPERATOR_CONTACT",
];
// Secrets: from the environment only, never the command line (shell history, ps).
const FROM_ENV = [
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "BACKUP_S3_ACCESS_KEY",
  "BACKUP_S3_SECRET_KEY",
  "SMTP_PASS",
  "OIDC_CLIENT_SECRET",
];
const FLAGS = {
  "--app-host": "APP_HOST",
  "--viewer-host": "VIEWER_HOST_NAME",
  "--image": "POLKA_IMAGE",
  "--backup-image": "POLKA_BACKUP_IMAGE",
  "--s3-endpoint": "S3_ENDPOINT",
  "--s3-region": "S3_REGION",
  "--s3-bucket": "S3_BUCKET",
  "--backup-bucket": "BACKUP_BUCKET",
};
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Second-level suffixes under which anyone registers a name: the registrable
// domain is one label longer. The common ones; with node_modules installed
// the full Public Suffix List (tldts) decides instead.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.ru",
  "net.ru",
  "org.ru",
  "pp.ru",
  "msk.ru",
  "spb.ru",
  "com.ua",
  "com.by",
  "com.kz",
  "co.jp",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.cn",
  "com.tr",
  "co.in",
  "co.il",
  "co.za",
  "com.mx",
  "com.ar",
  "com.sg",
]);

function fail(message) {
  console.error(`hosted:setup: ${message}`);
  process.exit(2);
}

/** The registrable domain of a host (eTLD+1): the browser's «same site». */
async function registrableDomain(host) {
  try {
    const { getDomain } = await import("tldts");
    const domain = getDomain(host, { allowPrivateDomains: true });
    if (domain) return domain;
  } catch {
    // No node_modules on the VM: the short list below.
  }
  const labels = host.split(".");
  const suffix = labels.slice(-2).join(".");
  return labels.slice(MULTI_PART_SUFFIXES.has(suffix) ? -3 : -2).join(".");
}

const args = process.argv.slice(2);
const values = {};
let out = join(root, "deploy/hosted/hosted.env");
let force = false;
let rotate = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--force") force = true;
  else if (arg === "--rotate") rotate = true;
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
if (rotate && !force) fail("--rotate replaces the secrets of an existing file: pass it with --force");

const exists = existsSync(out);
if (exists && !force) fail(`${out} exists; pass --force to update it (its secrets stay unless --rotate)`);
// hosted.env is read by Docker Compose (`--env-file`), whose dotenv rules
// interpolate `$NAME` and cut ` #…` in an unquoted value. A value is written
// bare only when it has none of that; anything else goes in double quotes
// with \\, " and $ escaped, which Compose (and a POSIX shell) reads back
// literally. Lines kept from an existing file stay as they are.
const PLAIN = /^[A-Za-z0-9_.,:/@+=%-]*$/;
const dotenvValue = (value) => (PLAIN.test(value) ? value : `"${value.replace(/[\\"$]/g, (char) => `\\${char}`)}"`);
/** What Compose makes of a value as written: quotes, escapes, inline comments. */
function readDotenvValue(raw) {
  const text = raw.trim();
  const quote = text[0];
  if ((quote === "'" || quote === '"') && text.length > 1) {
    let value = "";
    for (let i = 1; i < text.length; i++) {
      const char = text[i];
      if (char === quote) return value;
      if (char === "\\" && i + 1 < text.length) {
        const next = text[i + 1];
        if (quote === "'" && next === "'") {
          value += next;
          i++;
          continue;
        }
        if (quote === '"') {
          value += { n: "\n", t: "\t", r: "\r" }[next] ?? next;
          i++;
          continue;
        }
      }
      if (quote === '"' && char === "$" && text[i + 1] === "$") i++;
      value += char;
    }
  }
  return text.replace(/\s+#.*$/, "");
}
const parse = (text) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
      return key ? [[key, line.slice(key.length + 1)]] : [];
    }),
  );
// --force: what the file already says, unless given again.
// `raw` is each line's text after `=`, `current` what Compose reads from it.
const raw = exists ? parse(readFileSync(out, "utf8")) : {};
const current = Object.fromEntries(Object.entries(raw).map(([key, text]) => [key, readDotenvValue(text)]));

const merged = { ...current, ...values };
for (const key of ["APP_HOST", "VIEWER_HOST_NAME"])
  if (values[key] && !HOST.test(values[key])) fail(`${key} must be a host name like polka.company.ru`);
if (merged.APP_HOST && merged.APP_HOST === merged.VIEWER_HOST_NAME)
  fail("the viewer needs its own host on another registrable domain");
if (
  merged.APP_HOST &&
  merged.VIEWER_HOST_NAME &&
  HOST.test(merged.APP_HOST) &&
  HOST.test(merged.VIEWER_HOST_NAME) &&
  !/example\.(com|net)$/.test(merged.VIEWER_HOST_NAME)
) {
  const app = await registrableDomain(merged.APP_HOST);
  if (app === (await registrableDomain(merged.VIEWER_HOST_NAME)))
    fail(
      `the viewer host must be on another registrable domain than the app (both are ${app}): ` +
        "a browser treats them as one site, so a page's scripts would run next to the owner's session",
    );
}
if (values.S3_ENDPOINT && !/^https?:\/\/[^\s/]+\/?$/.test(values.S3_ENDPOINT))
  fail("S3_ENDPOINT must be a URL like https://storage.example.com");
if (values.S3_SECRET_KEY && values.S3_SECRET_KEY.length < 16) fail("S3_SECRET_KEY must be at least 16 characters");
if (merged.S3_ACCESS_KEY && merged.S3_ACCESS_KEY === merged.BACKUP_S3_ACCESS_KEY)
  fail("the backup job needs its own write-only key, not the app's");
for (const [key, value] of Object.entries(values)) if (/[\r\n]/.test(value)) fail(`${key} must be one line`);

const lines = readFileSync(example, "utf8").split("\n");
const known = new Set(lines.map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean));
for (const key of Object.keys(values)) if (!known.has(key)) fail(`${key} is not a setting of hosted.env.example`);

const hex = (bytes) => randomBytes(bytes).toString("hex");
const fresh = {
  POSTGRES_ADMIN_PASSWORD: hex(24),
  POLKA_SCHEMA_PASSWORD: hex(24),
  POLKA_RUNTIME_PASSWORD: hex(24),
  LINK_KEY: hex(32),
  OPS_STATUS_TOKEN: hex(32),
};
// A secret already in the file stays, unless --rotate.
const generated = Object.fromEntries(Object.entries(fresh).filter(([key]) => rotate || !current[key]));
const final = {};
const written = lines.map((line) => {
  const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
  if (!key) return line;
  const given = values[key] ?? generated[key];
  if (given !== undefined) {
    final[key] = given;
    return `${key}=${dotenvValue(given)}`;
  }
  const text = raw[key] ?? line.slice(key.length + 1);
  final[key] = readDotenvValue(text);
  return `${key}=${text}`;
});
// Settings of the old file the example does not have (BACKUP_INTERVAL_SECONDS…) stay too.
const extra = Object.keys(current).filter((key) => !known.has(key));
if (extra.length) {
  written.push("", "# Kept from the previous hosted.env (not in hosted.env.example).");
  for (const key of extra) {
    written.push(`${key}=${raw[key]}`);
    final[key] = current[key];
  }
}
writeFileSync(out, written.join("\n"), { mode: 0o600 });
chmodSync(out, 0o600);

const missing = [...REQUIRED, ...TO_FILL].filter((key) => !final[key] || /example\.(com|net)/.test(final[key]));
const made = Object.keys(generated);
const kept = Object.keys(fresh).filter((key) => !generated[key]);
console.log(
  `wrote ${out} (600): ${made.length ? `generated ${made.join(", ")}` : "no new secrets"}` +
    (kept.length ? `; kept ${kept.join(", ")}` : ""),
);
if (rotate && exists)
  console.log(
    "rotated: set the new database passwords with ALTER ROLE before `up` (init-roles.sh runs only on an empty volume); " +
      "a new LINK_KEY breaks every share link and webhook secret",
  );
if (missing.length) console.log(`still to fill: ${missing.join(", ")}`);
else console.log("every required setting is filled; keep a copy of LINK_KEY in your secret manager");
