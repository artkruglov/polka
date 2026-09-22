/**
 * v5 adds the Полка runtime: a page with module or JSX scripts is compiled
 * with vendored libraries (profile react-runtime-v1); any other page is built
 * by the unchanged v4 rules (profile bundle-inline-experimental-v1).
 */
export const BUNDLE_BUILDER_VERSION = "bundle-inline-v5" as const;
/**
 * Builder versions whose ready derivatives are still served. New builds use
 * BUNDLE_BUILDER_VERSION; a ready derivative of an older listed version keeps
 * its links and grants and is not rebuilt. Non-ready older rows are ignored,
 * so a page the older builder refused can be built again with the new one.
 */
export const SERVED_BUILDER_VERSIONS = [
  BUNDLE_BUILDER_VERSION,
  "bundle-inline-v4",
  "bundle-inline-v3",
] as const;
export const BUNDLE_RUNTIME_PROFILE = "bundle-inline-experimental-v1" as const;
/** A compiled Полка runtime page; the viewer isolation is the same. */
export const REACT_RUNTIME_PROFILE = "react-runtime-v1" as const;
/** Runtime profiles a ready derivative may carry to be served. */
export const SERVED_RUNTIME_PROFILES = [
  BUNDLE_RUNTIME_PROFILE,
  REACT_RUNTIME_PROFILE,
] as const;
export const DERIVATIVE_RESERVATION_BYTES = 8 * 1024 * 1024;
export const DERIVATIVE_BUILD_TIMEOUT_MS = 5_000;

/** SQL list literal of SERVED_BUILDER_VERSIONS, for `builder_version IN ...`. */
export const SERVED_BUILDER_VERSIONS_SQL = `(${SERVED_BUILDER_VERSIONS.map((v) => `'${v}'`).join(",")})`;

/** SQL list literal of SERVED_RUNTIME_PROFILES, for `runtime_profile IN ...`. */
export const SERVED_RUNTIME_PROFILES_SQL = `(${SERVED_RUNTIME_PROFILES.map((v) => `'${v}'`).join(",")})`;

/**
 * SQL condition for the derivative alias `d` that may describe a revision:
 * any current-version row, or a ready row of an older served version.
 */
export const derivativeVersionSql = (d: string) =>
  `(${d}.builder_version='${BUNDLE_BUILDER_VERSION}' OR (${d}.state='ready' AND ${d}.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}))`;

/** Prefers a ready derivative, then the current builder version. */
export const derivativePreferenceSql = (d: string) =>
  `(${d}.state='ready') DESC,(${d}.builder_version='${BUNDLE_BUILDER_VERSION}') DESC`;

export const isServedBuilderVersion = (value: unknown) =>
  (SERVED_BUILDER_VERSIONS as readonly unknown[]).includes(value);

export const isServedRuntimeProfile = (value: unknown) =>
  (SERVED_RUNTIME_PROFILES as readonly unknown[]).includes(value);
