import { z } from "zod";
import { HTML_LIVE_MODES, parseViewerConfig } from "./viewer-config.ts";
const unsetIfEmpty = (schema: z.ZodType<string, string>) =>
  z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .pipe(schema.optional());
const env = z
  .object({
    URL_IMPORT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    DATABASE_URL: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(16),
    S3_BUCKET: z.string().min(3),
    LINK_KEY: z.string().min(64),
    APP_ORIGIN: z.string().url(),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4390),
    // Comma-separated addresses/CIDRs of reverse proxies whose X-Forwarded-For
    // is trusted for client IPs (rate limits). Empty: use the socket address.
    TRUST_PROXY: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    HTML_LIVE_MODE: z.enum(HTML_LIVE_MODES).optional(),
    HTML_LIVE_ENABLED: z.enum(["true", "false"]).optional(),
    HTML_LIVE_STAGING_REVISION_IDS: z.string().optional(),
    VIEWER_ORIGIN: z.string().url().default("http://localhost:4391"),
    VIEWER_HOST: z.string().default("localhost"),
    VIEWER_PORT: z.coerce.number().int().min(1).max(65535).default(4391),
    MAIL_MODE: z.enum(["disabled", "local", "smtp"]).default("disabled"),
    // Compose passes unset SMTP variables as empty strings: empty means unset.
    SMTP_HOST: unsetIfEmpty(z.string()),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: unsetIfEmpty(z.string()),
    SMTP_PASS: unsetIfEmpty(z.string()),
    MAIL_FROM: unsetIfEmpty(z.string().email()),
    // Who may receive a sign-in code. open: anyone, and a new address gets a
    // shelf. invite: only addresses that already have an account or match
    // EMAIL_SIGNUP_ALLOW (addresses and @domains, comma- or space-separated).
    EMAIL_SIGNUP: z.enum(["open", "invite"]).default("open"),
    // New shelves created by email sign-in per day: for the whole installation,
    // and per client IP. 0 stops new shelves; existing accounts sign in as usual.
    EMAIL_SIGNUP_DAILY_LIMIT: z.coerce.number().int().min(0).max(100000).default(50),
    EMAIL_SIGNUP_DAILY_PER_IP: z.coerce.number().int().min(0).max(1000).default(3),
    EMAIL_SIGNUP_ALLOW: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(/[\s,]+/)
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(
        z.array(
          z.string().regex(/^(?:[^@\s]+)?@[^@\s]+\.[^@\s]+$/, "an address or @domain"),
        ),
      ),
    COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
    ACCOUNT_DELETION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ACCOUNT_PURGE_MAX_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(8760)
      .optional(),
    BACKUP_RETENTION_MAX_DAYS: z.coerce
      .number()
      .int()
      .min(0)
      .max(3650)
      .optional(),
    ACCOUNT_DELETION_POLICY_VERSION: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,80}$/)
      .optional(),
    // Operator status for external monitoring (GET /api/ops/status). Unset or
    // empty: the route does not exist. OPS_BACKUP_BUCKET is where the backup
    // job writes dumps; the app only lists it to report the newest dump's age.
    OPS_STATUS_TOKEN: unsetIfEmpty(z.string().min(32)),
    OPS_BACKUP_BUCKET: unsetIfEmpty(z.string()),
    RESTORE_MODE: z.enum(["off", "required"]).default("off"),
    RESTORE_RECEIPT_PATH: z.string().optional(),
    RESTORE_RUN_ID: z.string().uuid().optional(),
    RESTORE_BACKUP_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    RESTORE_LEDGER_ID: z.string().uuid().optional(),
    RESTORE_LEDGER_MANIFEST_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .parse(process.env);
if (new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN)
  throw new Error("APP_ORIGIN must be an origin");
if (new URL(env.VIEWER_ORIGIN).origin !== env.VIEWER_ORIGIN)
  throw new Error("VIEWER_ORIGIN must be an origin");
if (
  env.COOKIE_SECURE === "false" &&
  !["127.0.0.1", "localhost"].includes(new URL(env.APP_ORIGIN).hostname)
)
  throw new Error("Insecure cookies only supported on loopback");
if (
  env.MAIL_MODE === "local" &&
  (!["127.0.0.1", "localhost"].includes(new URL(env.APP_ORIGIN).hostname) ||
    !["127.0.0.1", "localhost"].includes(env.HOST))
)
  throw new Error("Local mail is restricted to loopback installations");
if (env.MAIL_MODE === "smtp" && (!env.SMTP_HOST || !env.MAIL_FROM))
  throw new Error("SMTP_HOST and MAIL_FROM are required");
const viewerConfig = parseViewerConfig(env);
if (env.ACCOUNT_DELETION_ENABLED) {
  const appUrl = new URL(env.APP_ORIGIN);
  if (
    appUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(appUrl.hostname) ||
    env.HOST !== appUrl.hostname
  )
    throw new Error("Experimental account deletion requires HTTP loopback");
  if (
    env.ACCOUNT_PURGE_MAX_HOURS === undefined ||
    env.BACKUP_RETENTION_MAX_DAYS === undefined ||
    !env.ACCOUNT_DELETION_POLICY_VERSION
  )
    throw new Error("Account deletion policy settings are required");
}
if (
  env.RESTORE_MODE === "required" &&
  (!env.RESTORE_RECEIPT_PATH ||
    !env.RESTORE_RUN_ID ||
    !env.RESTORE_BACKUP_SHA256 ||
    !env.RESTORE_LEDGER_ID ||
    !env.RESTORE_LEDGER_MANIFEST_SHA256)
)
  throw new Error(
    "Restore mode requires the exact completion receipt identity",
  );
export const config = { ...env, ...viewerConfig };
