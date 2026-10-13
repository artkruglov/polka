// Is this installation ready? One checklist for the person setting it up:
// settings, DNS and TLS of both hosts, the database and its schema, the S3
// bucket (versioning, conditional writes), the age of the last backup, mail,
// the company's IdP, ways to sign in and an administrator. Exit status 1
// when anything failed. Read-only: it creates no account and leaves no
// object (the conditional-write probe aims at the readiness object
// storage-check already made and expects 412; a store that wrongly accepts
// it gets that one version deleted again). Prints no secret.
//
//   npm run admin -- ops doctor [--send-test you@company.ru]
//   docker compose --env-file hosted.env run --rm -T --no-deps app \
//     node --import tsx scripts/admin.ts ops doctor
//
// --send-test sends one test letter through SMTP; without it no mail is sent.
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
import { parseArgs } from "node:util";
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";
import { getDomain } from "tldts";
import { CURRENT_SCHEMA_VERSION } from "../packages/migrations.ts";
import { READINESS_BYTES, READINESS_KEY } from "../packages/storage/readiness.ts";
import {
  backupCheck,
  certificateCheck,
  dnsCheck,
  exitCode,
  fail,
  httpCheck,
  info,
  oidcCheck,
  render,
  sameMachineCheck,
  schemaCheck,
  scrub,
  settingsChecks,
  signInChecks,
  siteCheck,
  smtpCheck,
  storageChecks,
  type Check,
} from "./doctor-lib.ts";

const USAGE = "Use npm run admin -- ops doctor [--send-test <email>]";
let sendTest: string | undefined;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { "send-test": { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  void positionals;
  sendTest = values["send-test"];
  if (sendTest !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTest))
    throw new Error("--send-test needs an email address");
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}

const TIMEOUT_MS = 8000;
const checks: Check[] = [];

let config: typeof import("../apps/server/config.ts").config;
try {
  ({ config } = await import("../apps/server/config.ts"));
} catch (error) {
  // A zod error lists paths and rules; never the values (they may be keys).
  const issues = (error as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
  const detail = issues
    ? issues.map((issue) => `${issue.path.join(".")}: ${issue.message.replace(/, received .*$/, "")}`).join("; ")
    : (error as Error).message;
  checks.push(
    fail(
      "Настройки (hosted.env)",
      scrub(detail, []),
      "исправьте hosted.env и запустите проверку снова; пример — hosted.env.example",
    ),
  );
  console.log(render(checks));
  process.exit(1);
}

const SECRETS = [
  config.S3_SECRET_KEY,
  config.S3_ACCESS_KEY,
  config.LINK_KEY,
  config.SMTP_PASS,
  config.OIDC_CLIENT_SECRET,
  new URL(config.DATABASE_URL).password,
];
const asError = (error: unknown) => {
  const raw = error as { message?: string; name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = raw?.$metadata?.httpStatusCode;
  const message = raw?.message || raw?.code || raw?.name || "ошибка";
  return new Error(scrub(status ? `${message} (HTTP ${status})` : message, SECRETS));
};
const attempt = async <T>(fn: () => Promise<T>): Promise<T | Error> => {
  try {
    return await fn();
  } catch (error) {
    return asError(error);
  }
};

const appHost = new URL(config.APP_ORIGIN).hostname;
const viewerHost = new URL(config.VIEWER_ORIGIN).hostname;
const loopback = (host: string) => ["127.0.0.1", "localhost", "::1"].includes(host);

// 1. Hosts.
checks.push(
  loopback(appHost)
    ? info("Адреса", `локальная установка (${config.APP_ORIGIN}), DNS и TLS не проверяются`)
    : siteCheck(appHost, viewerHost, (host) => getDomain(host, { allowPrivateDomains: true })),
);
if (!config.APP_ORIGIN.startsWith("https://") && !loopback(appHost))
  checks.push(
    fail("Адрес приложения", config.APP_ORIGIN, "APP_ORIGIN — https:// (compose.yml собирает его из APP_HOST)"),
  );

// 2. DNS and TLS of both hosts (skipped on a loopback development install).
const resolved: Record<string, string[]> = {};
for (const [label, host] of [
  ["приложения", appHost],
  ["просмотра", viewerHost],
] as const) {
  if (loopback(host)) continue;
  const addresses = await attempt(async () => (await lookup(host, { all: true })).map((entry) => entry.address));
  checks.push(dnsCheck(label, host, addresses));
  if (addresses instanceof Error) continue;
  resolved[host] = addresses;
  const certificate = await attempt(
    () =>
      new Promise<{ validTo: Date; authorized: boolean; error?: string }>((resolve, reject) => {
        const socket = connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
          const peer = socket.getPeerCertificate();
          resolve({
            validTo: new Date(peer.valid_to),
            authorized: socket.authorized,
            error: socket.authorizationError ? String(socket.authorizationError) : undefined,
          });
          socket.end();
        });
        socket.on("timeout", () => socket.destroy(new Error("нет ответа на 443")));
        socket.on("error", reject);
      }),
  );
  checks.push(certificateCheck(label, host, certificate));
}
const same = sameMachineCheck(resolved[appHost] ?? [], resolved[viewerHost] ?? []);
if (same) checks.push(same);
const status = (url: string) =>
  attempt(async () => (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })).status);
checks.push(
  httpCheck("Приложение отвечает", `${config.APP_ORIGIN}/readyz`, await status(`${config.APP_ORIGIN}/readyz`), true),
);
if (config.HTML_LIVE_MODE === "production")
  checks.push(
    httpCheck("Просмотр отвечает", `${config.VIEWER_ORIGIN}/`, await status(`${config.VIEWER_ORIGIN}/`), false),
  );

// 3. Database: reachable as the runtime role, schema current, accounts.
const client = new pg.Client({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: TIMEOUT_MS,
  query_timeout: TIMEOUT_MS,
});
let companyAdmins: number | null = null;
let passwordAccounts: number | null = null;
const applied = await attempt(async () => {
  await client.connect();
  const { rows } = await client.query("SELECT max(version)::int AS version FROM schema_migrations");
  return (rows[0]?.version as number | null) ?? null;
});
checks.push(schemaCheck(applied, CURRENT_SCHEMA_VERSION));
if (!(applied instanceof Error) && applied !== null) {
  const counts = await attempt(async () => {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE company_admin)::int AS admins,
              count(*) FILTER (WHERE name !~ '^(email|yandex|vk|google|oidc|guest|sso)-')::int AS passwords
         FROM accounts WHERE NOT disabled AND deletion_requested_at IS NULL`,
    );
    return rows[0] as { admins: number; passwords: number };
  });
  if (!(counts instanceof Error)) {
    companyAdmins = counts.admins;
    passwordAccounts = counts.passwords;
  }
}
await client.end().catch(() => {});

// 4. Objects bucket: versioning, the readiness object, conditional create.
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: process.env.S3_REGION || "us-east-1",
  forcePathStyle: true,
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 3000, requestTimeout: TIMEOUT_MS },
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});
const Bucket = config.S3_BUCKET;
const versioning = await attempt(async () => (await s3.send(new GetBucketVersioningCommand({ Bucket }))).Status);
let canary: "present" | "missing" | Error = new Error("не проверено");
let conditional: "enforced" | "not-enforced" | "skipped" | Error = "skipped";
if (!(versioning instanceof Error)) {
  canary = await attempt(async () => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket, Key: READINESS_KEY }));
      return "present" as const;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return "missing" as const;
      throw error;
    }
  });
  if (canary === "present")
    conditional = await attempt(async () => {
      try {
        const written = await s3.send(
          new PutObjectCommand({
            Bucket,
            Key: READINESS_KEY,
            Body: READINESS_BYTES,
            IfNoneMatch: "*",
            ContentType: "text/plain",
          }),
        );
        // Accepted over an existing object: not enforced. Take our version back.
        if (written.VersionId && written.VersionId !== "null")
          await s3
            .send(new DeleteObjectCommand({ Bucket, Key: READINESS_KEY, VersionId: written.VersionId }))
            .catch(() => {});
        return "not-enforced" as const;
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412)
          return "enforced" as const;
        throw error;
      }
    });
}
checks.push(...storageChecks(Bucket, { versioning, canary, conditional }));

// 5. Backups: the newest dump the app key can list.
const backupBucket = config.OPS_BACKUP_BUCKET;
const newest = backupBucket
  ? await attempt(async () => {
      let latest = 0;
      let ContinuationToken: string | undefined;
      let pages = 0;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({ Bucket: backupBucket, Prefix: "postgres/", ContinuationToken }),
        );
        for (const object of page.Contents ?? []) latest = Math.max(latest, object.LastModified?.getTime() ?? 0);
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken && ++pages < 50);
      return latest ? new Date(latest) : null;
    })
  : null;
checks.push(backupCheck(backupBucket, newest, config.OPS_BACKUP_INTERVAL_SECONDS));
s3.destroy();

// 6. Mail: connect and authenticate; a letter only on request.
let smtp: "ok" | Error | null = null;
if (config.MAIL_MODE === "smtp") {
  const { smtpTransport } = await import("../apps/server/mailer.ts");
  smtp = await attempt(async () => {
    const transport = smtpTransport();
    try {
      await transport.verify();
      if (sendTest) {
        const sent = await transport.sendMail({
          from: config.MAIL_FROM,
          to: sendTest,
          subject: "Полка: проверка почты",
          text: `Это проверочное письмо установки ${config.APP_ORIGIN}. Если оно дошло, коды для входа тоже дойдут.`,
        });
        if (!sent.accepted.length) throw new Error("сервер не принял письмо");
      }
      return "ok" as const;
    } finally {
      transport.close();
    }
  });
} else if (sendTest) checks.push(fail("Проверочное письмо", "почта выключена", "MAIL_MODE=smtp и SMTP_* в hosted.env"));
checks.push(smtpCheck(config.MAIL_MODE, config.SMTP_HOST, smtp, smtp === "ok" ? sendTest : undefined));

// 7. The company's IdP.
const discovery = config.OIDC_DISCOVERY_URL
  ? await attempt(async () => {
      const response = await fetch(config.OIDC_DISCOVERY_URL!, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as unknown;
    })
  : undefined;
checks.push(oidcCheck(config.OIDC_DISCOVERY_URL, discovery, `${config.APP_ORIGIN}/api/auth/idp/oidc/callback`));

// 8. Ways in, an administrator, and what is switched on.
checks.push(
  ...signInChecks({
    mailMode: config.MAIL_MODE,
    providers: config.SIGN_IN_PROVIDERS,
    extensions: config.POLKA_EXTENSIONS.split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    passwordAccounts,
    companyAdmins,
    teamShelves: config.TEAM_SHELVES,
  }),
  ...settingsChecks({
    teamShelves: config.TEAM_SHELVES,
    teamShelvesScope: config.TEAM_SHELVES_SCOPE,
    webhooks: config.WEBHOOKS,
    serviceAccounts: config.SERVICE_ACCOUNTS,
    htmlLiveMode: config.HTML_LIVE_MODE,
    emailSignup: config.EMAIL_SIGNUP,
    commentsMode: config.COMMENTS_MODE,
    operatorContact: config.OPERATOR_CONTACT,
  }),
);

console.log(render(checks));
process.exitCode = exitCode(checks);
