export const BUNDLE_BUILDER_VERSION = "bundle-inline-v4" as const;
/**
 * Builder versions whose ready derivatives are still served. New builds use
 * BUNDLE_BUILDER_VERSION; a ready derivative of an older listed version keeps
 * its links and grants and is not rebuilt. Non-ready older rows are ignored,
 * so a page the older builder refused can be built again with the new one.
 */
export const SERVED_BUILDER_VERSIONS = [
  BUNDLE_BUILDER_VERSION,
  "bundle-inline-v3",
] as const;
export const BUNDLE_RUNTIME_PROFILE = "bundle-inline-experimental-v1" as const;
export const DERIVATIVE_RESERVATION_BYTES = 8 * 1024 * 1024;
export const DERIVATIVE_BUILD_TIMEOUT_MS = 5_000;

/** SQL list literal of SERVED_BUILDER_VERSIONS, for `builder_version IN ...`. */
export const SERVED_BUILDER_VERSIONS_SQL = `(${SERVED_BUILDER_VERSIONS.map((v) => `'${v}'`).join(",")})`;

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
