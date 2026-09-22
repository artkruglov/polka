import { getDomain } from "tldts";
import { z } from "zod";

export const HTML_LIVE_MODES = [
  "disabled",
  "local",
  "staging",
  "production",
] as const;
export type HtmlLiveMode = (typeof HTML_LIVE_MODES)[number];

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;
const uuid = z.string().uuid();

export type ViewerConfigInput = {
  HTML_LIVE_MODE?: string;
  HTML_LIVE_ENABLED?: string;
  HTML_LIVE_STAGING_REVISION_IDS?: string;
  APP_ORIGIN: string;
  VIEWER_ORIGIN: string;
  HOST: string;
  PORT: number;
  VIEWER_HOST: string;
  VIEWER_PORT: number;
  COOKIE_SECURE: "true" | "false";
};

export type ViewerConfig = {
  HTML_LIVE_MODE: HtmlLiveMode;
  HTML_LIVE_ENABLED: boolean;
  HTML_LIVE_STAGING_REVISION_IDS: readonly string[];
  VIEWER_UPSTREAM_HOST: string;
};

const loopback = (host: string) =>
  (LOOPBACK_HOSTS as readonly string[]).includes(host);

function modeFor(input: ViewerConfigInput): HtmlLiveMode {
  const explicit = input.HTML_LIVE_MODE;
  if (
    explicit !== undefined &&
    !(HTML_LIVE_MODES as readonly string[]).includes(explicit)
  )
    throw new Error(
      "HTML_LIVE_MODE must be disabled, local, staging or production",
    );
  if (
    input.HTML_LIVE_ENABLED !== undefined &&
    input.HTML_LIVE_ENABLED !== "true" &&
    input.HTML_LIVE_ENABLED !== "false"
  )
    throw new Error("HTML_LIVE_ENABLED must be true or false");

  const mode = (explicit ??
    (input.HTML_LIVE_ENABLED === "true"
      ? "local"
      : "disabled")) as HtmlLiveMode;
  if (
    ((mode === "staging" || mode === "production") &&
      input.HTML_LIVE_ENABLED !== undefined) ||
    (mode === "disabled" && input.HTML_LIVE_ENABLED === "true") ||
    (mode === "local" && input.HTML_LIVE_ENABLED === "false")
  )
    throw new Error("HTML_LIVE_MODE conflicts with legacy HTML_LIVE_ENABLED");
  return mode;
}

function stagingAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.length === 0)
    throw new Error(
      "Staging live HTML requires a non-empty revision allowlist",
    );
  const values = raw.split(",").map((value) => value.trim().toLowerCase());
  if (values.length > 100)
    throw new Error(
      "Staging live HTML revision allowlist is limited to 100 IDs",
    );
  if (values.some((value) => !uuid.safeParse(value).success))
    throw new Error(
      "Staging live HTML revision allowlist contains an invalid UUID",
    );
  if (new Set(values).size !== values.length)
    throw new Error("Staging live HTML revision allowlist contains duplicates");
  return Object.freeze(values);
}

function registrableDomain(hostname: string) {
  return getDomain(hostname, { allowPrivateDomains: true });
}

export function parseViewerConfig(input: ViewerConfigInput): ViewerConfig {
  const mode = modeFor(input);
  const appUrl = new URL(input.APP_ORIGIN);
  const viewerUrl = new URL(input.VIEWER_ORIGIN);
  const allowlist =
    mode === "staging"
      ? stagingAllowlist(input.HTML_LIVE_STAGING_REVISION_IDS)
      : Object.freeze([] as string[]);

  if (mode !== "staging" && input.HTML_LIVE_STAGING_REVISION_IDS !== undefined)
    throw new Error(
      "HTML_LIVE_STAGING_REVISION_IDS is only valid in staging mode",
    );

  if (mode !== "disabled") {
    if (!loopback(input.HOST) || !loopback(input.VIEWER_HOST))
      throw new Error("Live HTML listeners must bind to loopback");
    if (input.PORT === input.VIEWER_PORT)
      throw new Error("App and viewer listeners must use different ports");
  }

  if (mode === "local") {
    if (
      appUrl.protocol !== "http:" ||
      viewerUrl.protocol !== "http:" ||
      !loopback(appUrl.hostname) ||
      !loopback(viewerUrl.hostname)
    )
      throw new Error(
        "Experimental local live HTML requires plain HTTP loopback origins",
      );
    if (
      appUrl.hostname === viewerUrl.hostname ||
      input.HOST !== appUrl.hostname ||
      input.VIEWER_HOST !== viewerUrl.hostname
    )
      throw new Error(
        "APP_ORIGIN and VIEWER_ORIGIN must use opposite loopback hostnames",
      );
    if (Number(appUrl.port || 80) !== input.PORT)
      throw new Error("APP_ORIGIN port must match PORT in local mode");
    if (Number(viewerUrl.port || 80) !== input.VIEWER_PORT)
      throw new Error(
        "VIEWER_ORIGIN port must match VIEWER_PORT in local mode",
      );
  }

  // Production differs from staging only by serving every eligible revision
  // instead of an explicit allowlist; the delivery requirements are the same.
  if (mode === "staging" || mode === "production") {
    const label = mode === "staging" ? "Staging" : "Production";
    if (appUrl.protocol !== "https:" || viewerUrl.protocol !== "https:")
      throw new Error(`${label} live HTML requires canonical HTTPS origins`);
    if (
      appUrl.origin !== input.APP_ORIGIN ||
      viewerUrl.origin !== input.VIEWER_ORIGIN
    )
      throw new Error(`${label} live HTML requires canonical HTTPS origins`);
    if (input.COOKIE_SECURE !== "true")
      throw new Error(`${label} live HTML requires secure cookies`);
    const appDomain = registrableDomain(appUrl.hostname);
    const viewerDomain = registrableDomain(viewerUrl.hostname);
    if (!appDomain || !viewerDomain || appDomain === viewerDomain)
      throw new Error(
        `${label} app and viewer require different registrable domains`,
      );
  }

  return Object.freeze({
    HTML_LIVE_MODE: mode,
    HTML_LIVE_ENABLED: mode !== "disabled",
    HTML_LIVE_STAGING_REVISION_IDS: allowlist,
    VIEWER_UPSTREAM_HOST:
      mode === "local"
        ? viewerUrl.host
        : `${input.VIEWER_HOST}:${input.VIEWER_PORT}`,
  });
}

export function isLiveRevisionEligible(
  viewer: Pick<
    ViewerConfig,
    "HTML_LIVE_MODE" | "HTML_LIVE_ENABLED" | "HTML_LIVE_STAGING_REVISION_IDS"
  >,
  revisionId: string,
) {
  if (!viewer.HTML_LIVE_ENABLED) return false;
  return (
    viewer.HTML_LIVE_MODE !== "staging" ||
    viewer.HTML_LIVE_STAGING_REVISION_IDS.includes(revisionId.toLowerCase())
  );
}
