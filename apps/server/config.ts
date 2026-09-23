import { z } from "zod";
import { HTML_LIVE_MODES, parseViewerConfig } from "./viewer-config.ts";
import {
  PUBLIC_MAIL_DOMAINS,
  parseSignupDomains,
} from "./mail-domains.ts";
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
    // Where users of this installation get its source code (AGPL-3.0 § 13).
    // Operators of a modified Полка point it at their modified source.
    SOURCE_URL: unsetIfEmpty(
      z
        .string()
        .url()
        .refine((value) => new URL(value).protocol === "https:", "an https URL"),
    ).transform((value) => value ?? "https://github.com/artkruglov/polka"),
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
    // Where a NEW shelf may open by an emailed code (docs/specs/
    // SIGN_IN_PROVIDERS.md § 3): any | ru-only | a list of domains (ru-only
    // may be one of its entries). Existing accounts sign in on any domain
    // unless EMAIL_LOGIN_DOMAINS=signup. Providers are not restricted.
    EMAIL_SIGNUP_DOMAINS: z.string().default("any"),
    EMAIL_LOGIN_DOMAINS: z.enum(["any", "signup"]).default("any"),
    // External sign-in (docs/specs/SIGN_IN_PROVIDERS.md § 1). A provider is
    // off until its client is configured.
    YANDEX_CLIENT_ID: unsetIfEmpty(z.string().max(200)),
    YANDEX_CLIENT_SECRET: unsetIfEmpty(z.string().max(200)),
    // Yandex confirms an address before it becomes the default one; false
    // stops its email from linking accounts and joining organisations.
    YANDEX_EMAIL_VERIFIED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    VK_CLIENT_ID: unsetIfEmpty(z.string().max(200)),
    // VK ID reports no verification of the address: off by default.
    VK_EMAIL_VERIFIED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OIDC_DISCOVERY_URL: unsetIfEmpty(z.string().url()),
    OIDC_CLIENT_ID: unsetIfEmpty(z.string().max(500)),
    OIDC_CLIENT_SECRET: unsetIfEmpty(z.string().max(500)),
    OIDC_SCOPES: z.string().default("openid email profile"),
    OIDC_NAME: unsetIfEmpty(z.string().max(60)).transform(
      (value) => value ?? "Единый вход компании",
    ),
    OIDC_ALLOWED_DOMAINS: z.string().default(""),
    OIDC_ORG_CLAIM: unsetIfEmpty(z.string().max(100)),
    OIDC_ORG_VALUE: unsetIfEmpty(z.string().max(500)),
    // Organisation access (§ 2): domain=libraryId[:reader|curator], …
    ORG_DOMAINS: z.string().default(""),
    OIDC_ORG_LIBRARY: z.string().default(""),
    // Comments (docs/specs/SIGN_IN_PROVIDERS.md § 4): on | owner-notes | off.
    COMMENTS_MODE: z.enum(["on", "owner-notes", "off"]).default("on"),
    // Abuse protection (docs/specs/ABUSE_PROTECTION.md). When a new link
    // waits for the operator: off, flagged (looks like phishing and the
    // author is not trusted), new-accounts (any link of an untrusted
    // account), all (any link of an account the operator did not create).
    SHARE_MODERATION: z
      .enum(["off", "flagged", "new-accounts", "all"])
      .default("flagged"),
    // Where moderation mail goes. Unset or empty: no mail, scripts only.
    OPERATOR_EMAIL: unsetIfEmpty(z.string().email()),
    // Distinct reporters of one link within 7 days that pause it. 0: never.
    MODERATION_AUTOPAUSE_REPORTS: z.coerce.number().int().min(0).max(1000).default(3),
    // An account younger than this (and not approved) is new: it may hold at
    // most NEW_ACCOUNT_MAX_LINKS live links, each for at most 7 days.
    NEW_ACCOUNT_DAYS: z.coerce.number().int().min(0).max(365).default(7),
    NEW_ACCOUNT_MAX_LINKS: z.coerce.number().int().min(0).max(10000).default(5),
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

const domainList = (value: string, name: string) =>
  value
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean)
    .map((entry) => {
      if (!/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,63}$/.test(entry))
        throw new Error(`${name}: not a domain: ${entry}`);
      return entry;
    });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type OrgRole = "reader" | "curator";
/** libraryId[:reader|curator]; admin is never granted automatically. */
function libraryGrant(value: string, name: string) {
  const [libraryId, role = "reader", ...rest] = value.trim().split(":");
  if (rest.length || !UUID.test(libraryId) || !["reader", "curator"].includes(role))
    throw new Error(`${name}: expected <library uuid>[:reader|curator]`);
  return { libraryId, role: role as OrgRole };
}
const orgDomains = env.ORG_DOMAINS.split(/[\s,]+/)
  .filter(Boolean)
  .map((entry) => {
    const [domain, grant, ...rest] = entry.split("=");
    if (rest.length || !grant) throw new Error("ORG_DOMAINS: domain=<library uuid>[:role]");
    const [clean] = domainList(domain, "ORG_DOMAINS");
    if (PUBLIC_MAIL_DOMAINS.includes(clean))
      throw new Error(`ORG_DOMAINS: ${clean} is a public mail service, not an organisation`);
    return { domain: clean, ...libraryGrant(grant, "ORG_DOMAINS") };
  });
const oidcConfigured = !!(env.OIDC_DISCOVERY_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
if (env.OIDC_DISCOVERY_URL) {
  const discovery = new URL(env.OIDC_DISCOVERY_URL);
  if (
    discovery.protocol !== "https:" &&
    !(discovery.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(discovery.hostname))
  )
    throw new Error("OIDC_DISCOVERY_URL must be https");
}
if (!!env.OIDC_ORG_CLAIM !== !!env.OIDC_ORG_VALUE)
  throw new Error("OIDC_ORG_CLAIM and OIDC_ORG_VALUE go together");
const signInConfig = {
  EMAIL_SIGNUP_DOMAINS: parseSignupDomains(env.EMAIL_SIGNUP_DOMAINS, env.APP_ORIGIN),
  OIDC_ALLOWED_DOMAINS: domainList(env.OIDC_ALLOWED_DOMAINS, "OIDC_ALLOWED_DOMAINS"),
  ORG_DOMAINS: orgDomains,
  OIDC_ORG_LIBRARY: env.OIDC_ORG_LIBRARY.trim()
    ? libraryGrant(env.OIDC_ORG_LIBRARY, "OIDC_ORG_LIBRARY")
    : null,
  /** Providers with a configured client, in the order the buttons show. */
  SIGN_IN_PROVIDERS: [
    ...(env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET ? (["yandex"] as const) : []),
    ...(env.VK_CLIENT_ID ? (["vk"] as const) : []),
    ...(oidcConfigured ? (["oidc"] as const) : []),
  ] as Array<"yandex" | "vk" | "oidc">,
};
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
export const config = { ...env, ...viewerConfig, ...signInConfig };
