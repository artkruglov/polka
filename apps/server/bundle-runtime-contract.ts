/**
 * v5 adds the Полка runtime: a page with module or JSX scripts is compiled
 * with vendored libraries (profile react-runtime-v1); any other page is built
 * by the v4 rules (profile bundle-inline-experimental-v1). v6 gives every
 * page with scripts the environment prelude (storage in memory, dialogs in
 * the page), drops remote hints/fonts/images the CSP would block anyway with
 * a warning, and shares one module scope between text/babel scripts.
 */
export const BUNDLE_BUILDER_VERSION = "bundle-inline-v6" as const;
/**
 * Builder versions whose ready derivatives are still served. New builds use
 * BUNDLE_BUILDER_VERSION; a ready derivative of an older listed version keeps
 * its links and grants and is not rebuilt. Non-ready older rows are ignored,
 * so a page the older builder refused can be built again with the new one.
 */
export const SERVED_BUILDER_VERSIONS = [
  BUNDLE_BUILDER_VERSION,
  "bundle-inline-v5",
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

/**
 * Every limit of the derivative builder, in one place. The output limit is
 * also the per-derivative quota reservation.
 */
export const BUILD_LIMITS = {
  /** A finished page, and every inlined resource budget within it. */
  outputBytes: 8 * 1024 * 1024,
  htmlNodes: 100_000,
  htmlDepth: 256,
  svgNodes: 20_000,
  svgDepth: 256,
  /** The compiled runtime script. */
  runtimeScriptBytes: 7 * 1024 * 1024,
  /** Source files esbuild actually loads, and their total size. */
  runtimeModules: 32,
  runtimeSourceBytes: 2 * 1024 * 1024,
  /** All code files of a bundle, loaded or not. */
  bundleCodeBytes: 8 * 1024 * 1024,
  /** Advisory nesting pre-filter (see runtime-guards.ts). */
  nesting: 500,
  chain: 1000,
  unaryRun: 1000,
  tailwindCandidates: 20_000,
  /** Wall clock of one build worker, including esbuild. */
  timeoutMs: 5_000,
  /** Build workers per process; runtime (esbuild) builds are one of them. */
  workers: 2,
  runtimeBuilds: 1,
  workerHeapMb: 64,
  workerYoungMb: 16,
  workerStackMb: 4,
} as const;

export const DERIVATIVE_RESERVATION_BYTES = BUILD_LIMITS.outputBytes;
export const DERIVATIVE_BUILD_TIMEOUT_MS = BUILD_LIMITS.timeoutMs;

/**
 * Why a build worker did not return a result. Only the category is logged
 * and shown; stored HTML and paths never are.
 */
export type BuildFailureCategory = "timeout" | "oom" | "crash" | "compiler";

export const BUILD_FAILURE_MESSAGES: Record<BuildFailureCategory, string> = {
  timeout:
    "Сборка не уложилась в отведённое время. Повторите подготовку; если не поможет, упростите страницу или уменьшите её.",
  oom: "Сборке не хватило памяти. Уменьшите страницу (данные, картинки, число библиотек) и повторите.",
  crash: "Сборщик неожиданно остановился. Повторите подготовку.",
  compiler:
    "Компилятор страниц временно недоступен. Повторите подготовку через минуту.",
};

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
