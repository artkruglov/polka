import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJs } from "acorn";
import { build, type Loader, type Message, type Plugin } from "esbuild";
import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import {
  canonicalizeManifest,
  type BundleManifest,
} from "../../packages/contracts/bundle.ts";
import {
  RUNTIME_LIBRARIES,
  RUNTIME_LIBRARY_NAMES,
  RUNTIME_MODULE_LOADERS,
  RUNTIME_TAILWIND_META,
  runtimeLibraryFor,
  type RuntimeLibrary,
} from "../../packages/contracts/runtime.ts";
import {
  PRELUDE,
  attr,
  buildInlineBundle,
  checkGeneratedCss,
  digest,
  element,
  fail,
  findElement,
  insertIntoHead,
  resolveLocal,
  type BundleInlineResult,
  type Node,
} from "./bundle-inline.ts";
import {
  BUILD_FAILURE_MESSAGES,
  BUILD_LIMITS,
  BUNDLE_BUILDER_VERSION,
  REACT_RUNTIME_PROFILE,
} from "./bundle-runtime-contract.ts";
import {
  allowedPackageDirs,
  isAllowedLibraryFile,
  staticImportsOnly,
  withinNestingLimits,
} from "./runtime-guards.ts";

/**
 * The Полка runtime builder (profile react-runtime-v1). A page whose scripts
 * are ES modules or JSX (type=module, text/babel), or that loads a known
 * library from a CDN, is compiled at build time: allowlisted bare imports
 * resolve to Полка's own vendored copies, Tailwind CSS is generated for the
 * classes used, and the result is one HTML file with inline classic script
 * and style. Everything else in the page goes through the v4 rules, so the
 * output meets the same inline checks and viewer CSP. No network is used and
 * the same source always yields the same bytes.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const MAX_OUTPUT_BYTES = BUILD_LIMITS.outputBytes;
const MAX_SCRIPT_BYTES = BUILD_LIMITS.runtimeScriptBytes;
const MAX_CANDIDATES = BUILD_LIMITS.tailwindCandidates;
let allowedDirs: string[] | null = null;
const libraryDirs = () =>
  (allowedDirs ??= allowedPackageDirs(
    ROOT,
    RUNTIME_LIBRARIES.map((library) => library.name),
  ));

type Module = { path: string; source: string; loader: Loader };
/** Where lines of a compiled module came from, for refusals. */
type Segment = { start: number; path: string; line: number };

/** esbuild itself failed (not the page): the build may be retried. */
const compilerFailure = (): BundleInlineResult => ({
  ok: false,
  failed: true,
  category: "compiler",
  reason: BUILD_FAILURE_MESSAGES.compiler,
});

const MODULE_TYPES = ["module", "text/babel", "text/jsx"];
const CLASSIC_TYPES = [
  "",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
];
const BABEL_PACKAGES = ["@babel/standalone", "babel-standalone"];
const TAILWIND_PACKAGES = ["tailwindcss", "@tailwindcss/browser"];
// A UMD library that other CDN scripts depended on; the runtime needs none.
const DROPPED_PACKAGES = ["prop-types", "react-is"];

/** The npm package and file a CDN URL names, or null. */
function cdnReference(reference: string | undefined) {
  if (!reference) return null;
  let url: URL;
  try {
    url = new URL(reference.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "cdn.tailwindcss.com")
    return { name: "tailwindcss", file: "", esm: false };
  let pathname = url.pathname;
  let esm = false;
  if (url.hostname === "unpkg.com") pathname = pathname.slice(1);
  else if (url.hostname === "cdn.jsdelivr.net") {
    if (!pathname.startsWith("/npm/")) return null;
    pathname = pathname.slice(5);
    if (/(?:^|\/)\+esm$/.test(pathname)) {
      esm = true;
      pathname = pathname.replace(/\/?\+esm$/, "");
    }
  } else if (url.hostname === "cdnjs.cloudflare.com") {
    const match = /^\/ajax\/libs\/([^/]+)\/[^/]+\/(.*)$/.exec(pathname);
    return match ? { name: match[1], file: match[2], esm: false } : null;
  } else if (url.hostname === "esm.sh" || url.hostname === "cdn.skypack.dev") {
    esm = true;
    // Version prefixes (/v135/, /stable/) and the "*" external marker.
    pathname = pathname
      .slice(1)
      .replace(/^(?:v\d+|stable|pin\/v\d+)\//, "")
      .replace(/^\*/, "");
  } else return null;
  const match = /^((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?(?:\/(.*))?$/.exec(pathname);
  return match ? { name: match[1], file: match[2] ?? "", esm } : null;
}

const cdnLibrary = (name: string) =>
  RUNTIME_LIBRARIES.find((library) =>
    (library.cdnNames as readonly string[]).includes(name),
  ) ?? null;

/** Vendored three.js example modules, by their path under examples/jsm. */
function threeAddon(file: string) {
  const match =
    /^examples\/(?:js|jsm)\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+)(?:\.min)?\.js$/.exec(
      file,
    );
  if (!match) return null;
  const module = `three/examples/jsm/${match[1]}.js`;
  const exists = existsSync(path.join(ROOT, "node_modules", module));
  return {
    module: exists ? module : null,
    name: path.posix.basename(match[1]),
  };
}

type CdnRole =
  | { kind: "library"; library: RuntimeLibrary }
  | { kind: "addon"; module: string; name: string }
  | { kind: "tailwind" }
  | { kind: "drop" }
  | { kind: "refuse"; reason: string };

/** What a CDN script or stylesheet stands for in the runtime, or null. */
export function cdnRole(reference: string | undefined): CdnRole | null {
  const cdn = cdnReference(reference);
  if (!cdn) return null;
  if (TAILWIND_PACKAGES.includes(cdn.name)) return { kind: "tailwind" };
  if (BABEL_PACKAGES.includes(cdn.name) || DROPPED_PACKAGES.includes(cdn.name))
    return { kind: "drop" };
  const library = cdnLibrary(cdn.name);
  if (!library) return null;
  if (library.name === "three" && /^examples\//.test(cdn.file)) {
    const addon = threeAddon(cdn.file);
    return addon?.module
      ? { kind: "addon", module: addon.module, name: addon.name }
      : {
          kind: "refuse",
          reason: `three.js example ${cdn.file.slice(0, 120)} is not part of the runtime's three ${library.version}; import it from "three/addons/…" instead`,
        };
  }
  return { kind: "library", library };
}

/**
 * The vendored module an ES import URL stands for (esm.sh, Skypack,
 * jsDelivr +esm, unpkg), or null. Only allowlisted libraries map; the
 * version in the URL is ignored in favour of the vendored one.
 */
export function vendoredSpecifier(reference: string) {
  const cdn = cdnReference(reference);
  if (!cdn) return null;
  const library =
    cdnLibrary(cdn.name) ??
    (runtimeLibraryFor(cdn.name) ? { name: cdn.name } : null);
  if (!library) return null;
  const file = cdn.file.replace(/\?.*$/, "");
  if (!file) return library.name;
  const subpath = `${library.name}/${file.replace(/\.(?:m?js)$/, "")}`;
  if (library.name === "three" && file.startsWith("examples/")) {
    const addon = threeAddon(file);
    return addon?.module ?? null;
  }
  // react-dom/client, react/jsx-runtime, lodash/debounce, chart.js/auto…
  for (const candidate of [subpath, `${library.name}/${file}`])
    if (runtimeLibraryFor(candidate)) return candidate;
  // A library's own build file (three/build/three.module.js,
  // react/umd/react.production.min.js) stands for the library.
  if (
    /^(?:build|dist|umd|esm|es|lib|es20\d\d|denonext)\/[^/]+\.m?js$/.test(file)
  )
    return library.name;
  return null;
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of [...(node.childNodes ?? [])]) walk(child, visit);
}

function remove(node: Node) {
  const siblings = node.parentNode?.childNodes;
  if (siblings) siblings.splice(siblings.indexOf(node), 1);
  node.parentNode = null;
}

// Shown in the page when a compiled module throws, so a broken artifact does
// not look like an empty one.
const REPORT = `const __polkaReport=(error)=>{console.error(error);try{const box=document.createElement("pre");box.setAttribute("role","alert");box.style.cssText="position:fixed;left:12px;right:12px;bottom:12px;margin:0;padding:12px;max-height:40vh;overflow:auto;background:#fff4f2;color:#8a1c0b;border:1px solid #e8b4aa;border-radius:8px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:2147483647";box.textContent="Ошибка в странице: "+(error&&error.message?error.message:String(error));(document.body||document.documentElement).appendChild(box)}catch{}};`;

const GLOBAL_SETUP: Record<string, string> = {
  react: `import * as __g_react from "react";globalThis.React=__g_react;`,
  "react-dom": `import * as __g_rd from "react-dom";import * as __g_rdc from "react-dom/client";globalThis.ReactDOM=Object.assign({},__g_rd,__g_rdc,{render(element,container,done){const root=container.__polkaRoot??__g_rdc.createRoot(container);container.__polkaRoot=root;root.render(element);if(typeof done==="function")queueMicrotask(done)},unmountComponentAtNode(container){const root=container.__polkaRoot;if(!root)return false;root.unmount();delete container.__polkaRoot;return true}});`,
  "lucide-react": `import * as __g_lucide from "lucide-react";globalThis.LucideReact=__g_lucide;`,
  recharts: `import * as __g_recharts from "recharts";globalThis.Recharts=__g_recharts;`,
  lodash: `import __g_lodash from "lodash";globalThis._=__g_lodash;`,
  d3: `import * as __g_d3 from "d3";globalThis.d3=__g_d3;`,
  // A plain object, so CDN example scripts can hang their classes on it.
  three: `import * as __g_three from "three";globalThis.THREE={...__g_three};`,
  papaparse: `import __g_papa from "papaparse";globalThis.Papa=__g_papa;`,
  mathjs: `import * as __g_math from "mathjs";globalThis.math=__g_math;`,
  "chart.js": `import __g_chart from "chart.js/auto";globalThis.Chart=__g_chart;`,
};

const MOUNT = `import { createElement as __polkaCreate } from "react";import { createRoot as __polkaRoot } from "react-dom/client";
const __polkaMount=(module)=>{const App=module&&module.default;if(typeof App!=="function")return false;let target=document.getElementById("root");if(!target){target=document.createElement("div");target.id="root";document.body.appendChild(target)}__polkaRoot(target).render(__polkaCreate(App));return true};`;

const exportsDefault = (source: string) =>
  /\bexport\s+default\b|\bas\s+default\b/.test(source);

function entrySource(
  modules: Module[],
  globals: Set<string>,
  addons: Array<{ module: string; name: string }>,
  mount: boolean,
) {
  const lines = [...globals].map((name) => GLOBAL_SETUP[name]);
  // three.js example classes from a CDN script (THREE.OrbitControls).
  lines.push(
    ...addons.map(
      (addon, index) =>
        `import { ${addon.name} as __g_addon${index} } from ${JSON.stringify(addon.module)};globalThis.THREE.${addon.name}=__g_addon${index};`,
    ),
  );
  if (mount) lines.push(MOUNT);
  lines.push(REPORT);
  const loads = modules
    .map(
      (module) =>
        `{const m=await import(${JSON.stringify(`user:${module.path}`)});${mount ? "if(!mounted)mounted=__polkaMount(m);" : ""}}`,
    )
    .join("");
  // Module scripts run after the document is parsed; so do these.
  lines.push(
    `const __polkaRun=async()=>{let mounted=false;try{${loads}}catch(error){__polkaReport(error)}};`,
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{__polkaRun()},{once:true});else __polkaRun();`,
    `addEventListener("error",(event)=>{if(event.error)__polkaReport(event.error)});`,
  );
  return lines.join("\n");
}

const loaderFor = (file: string): Loader | null =>
  (RUNTIME_MODULE_LOADERS as Record<string, Loader>)[
    path.posix.extname(file)
  ] ?? (file.endsWith(".css") ? "css" : file.endsWith(".json") ? "json" : null);

/** Words that may be Tailwind classes; the compiler ignores the rest. */
function candidates(sources: string[]) {
  const found = new Set<string>();
  for (const source of sources)
    for (const token of source.split(/[\s"'`{}<>;,=\\]+/)) {
      if (!token || token.length > 120 || found.size >= MAX_CANDIDATES)
        continue;
      // An arbitrary value must not smuggle a resource into the stylesheet.
      if (/url\(|image-set|:\/\/|@import/i.test(token)) continue;
      found.add(token);
    }
  return [...found].sort();
}

let tailwind: Promise<typeof import("tailwindcss")> | null = null;
const stylesheets = new Map<string, string>();

function tailwindStylesheet(id: string) {
  const file = {
    tailwindcss: "tailwindcss/index.css",
    "tailwindcss/theme": "tailwindcss/theme.css",
    "tailwindcss/theme.css": "tailwindcss/theme.css",
    "tailwindcss/preflight": "tailwindcss/preflight.css",
    "tailwindcss/preflight.css": "tailwindcss/preflight.css",
    "tailwindcss/utilities": "tailwindcss/utilities.css",
    "tailwindcss/utilities.css": "tailwindcss/utilities.css",
  }[id];
  if (!file) throw Error(`stylesheet ${id} is not part of the runtime`);
  let content = stylesheets.get(file);
  if (content === undefined) {
    content = readFileSync(require.resolve(file), "utf8");
    stylesheets.set(file, content);
  }
  return { path: file, base: ROOT, content };
}

// Tailwind v3 (the CDN and chat artifacts) drew borders gray-200 by default;
// v4 uses currentColor. Pages that get preflight keep the v3 look.
const V3_BORDER_COMPAT = `@layer base { *,::after,::before,::backdrop,::file-selector-button{border-color:var(--color-gray-200,currentColor)} }`;
const TAILWIND_CONFIG_ID = "polka:tailwind-config";

async function tailwindCss(
  words: string[],
  preflight: boolean,
  config: Record<string, unknown> | null,
) {
  tailwind ??= import("tailwindcss");
  const { compile } = await tailwind;
  const input = [
    preflight
      ? `@import "tailwindcss";`
      : `@layer theme, base, components, utilities;\n@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);`,
    config ? `@config "${TAILWIND_CONFIG_ID}";` : "",
    preflight ? V3_BORDER_COMPAT : "",
  ].join("\n");
  const compiler = await compile(input, {
    base: ROOT,
    loadStylesheet: async (id) => tailwindStylesheet(id),
    loadModule: async (id, base, hint) => {
      if (hint === "config" && id === TAILWIND_CONFIG_ID && config)
        return { path: TAILWIND_CONFIG_ID, base, module: config };
      throw Error("Tailwind plugins are not part of the runtime");
    },
  });
  return compiler.build(words);
}

/**
 * The static part of an inline `tailwind.config = {...}` (Tailwind v3 CDN),
 * or null. Only literal values are taken (no functions, plugins or
 * references); anything else is left out and reported.
 */
function inlineTailwindConfig(source: string) {
  let program: any;
  try {
    program = parseJs(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return null;
  }
  let skipped = false;
  const literal = (node: any): unknown => {
    switch (node?.type) {
      case "Literal":
        return node.regex ? undefined : node.value;
      case "TemplateLiteral":
        return node.expressions.length
          ? undefined
          : node.quasis[0].value.cooked;
      case "UnaryExpression":
        return node.operator === "-" &&
          typeof literal(node.argument) === "number"
          ? -(literal(node.argument) as number)
          : undefined;
      case "ArrayExpression": {
        const items = node.elements.map(literal);
        return items.includes(undefined) ? undefined : items;
      }
      case "ObjectExpression": {
        const result: Record<string, unknown> = {};
        for (const property of node.properties) {
          const key =
            property.type === "Property" && !property.computed
              ? property.key.type === "Identifier"
                ? property.key.name
                : typeof property.key.value === "string" ||
                    typeof property.key.value === "number"
                  ? String(property.key.value)
                  : undefined
              : undefined;
          const value =
            key === undefined || property.kind !== "init"
              ? undefined
              : literal(property.value);
          if (
            key === undefined ||
            value === undefined ||
            key === "plugins" ||
            key === "presets" ||
            key === "__proto__"
          ) {
            skipped = true;
            continue;
          }
          result[key] = value;
        }
        return result;
      }
    }
    return undefined;
  };
  for (const statement of program.body) {
    const expression =
      statement.type === "ExpressionStatement" ? statement.expression : null;
    const target =
      expression?.type === "AssignmentExpression" && expression.operator === "="
        ? expression.left
        : null;
    const names: string[] = [];
    for (let node = target; node; node = node.object) {
      if (node.type === "Identifier") {
        names.unshift(node.name);
        break;
      }
      if (node.type !== "MemberExpression" || node.computed) break;
      names.unshift(node.property.name);
    }
    const name = names.join(".");
    if (name !== "tailwind.config" && name !== "window.tailwind.config")
      continue;
    const config = literal(expression.right);
    if (config && typeof config === "object" && !Array.isArray(config))
      return { config: config as Record<string, unknown>, skipped };
  }
  return null;
}

const typeOf = (node: Node) => (attr(node, "type") ?? "").trim().toLowerCase();
const isRuntimeScript = (node: Node) =>
  MODULE_TYPES.includes(typeOf(node)) ||
  typeOf(node) === "importmap" ||
  (CLASSIC_TYPES.includes(typeOf(node)) && !!cdnRole(attr(node, "src")));

function scanPage(document: Node) {
  const scripts: Node[] = [];
  const cdnLinks: Node[] = [];
  walk(document, (node) => {
    if (node.tagName === "script") scripts.push(node);
    else if (
      node.tagName === "link" &&
      /\bstylesheet\b/i.test(attr(node, "rel") ?? "") &&
      cdnRole(attr(node, "href"))?.kind === "tailwind"
    )
      cdnLinks.push(node);
  });
  return {
    scripts,
    cdnLinks,
    runtime: scripts.some(isRuntimeScript) || cdnLinks.length > 0,
  };
}

// A page the runtime builds names a module type or a CDN host somewhere.
const RUNTIME_HINT =
  /type\s*=\s*["']?\s*(?:module|text\/babel|text\/jsx|importmap)|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|cdn\.tailwindcss\.com|esm\.sh|cdn\.skypack\.dev/i;

/**
 * Whether a page is built by the runtime (esbuild) rather than the v4 rules.
 * The build worker asks for the one runtime slot when it is. A page without
 * any module type or CDN host is answered without parsing it.
 */
export function needsRuntimeBuild(
  manifest: BundleManifest,
  sourceBytes: Map<string, Buffer>,
) {
  const entry = sourceBytes.get(manifest.entrypoint);
  if (!entry || entry.length > MAX_OUTPUT_BYTES) return false;
  try {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(entry);
    if (!RUNTIME_HINT.test(html)) return false;
    return scanPage(parse(html) as Node).runtime;
  } catch {
    return false;
  }
}

/** The first line of an inline script's text in its HTML file. */
const scriptLine = (node: Node) =>
  node.childNodes?.[0]?.sourceCodeLocation?.startLine ??
  node.sourceCodeLocation?.startLine ??
  1;

/**
 * Builds a runtime page, or returns null when the entrypoint has no module,
 * JSX or known-CDN script (the caller then applies the v4 rules as before).
 */
export async function buildRuntimeBundle(
  manifest: BundleManifest,
  sourceBytes: Map<string, Buffer>,
): Promise<BundleInlineResult | null> {
  let canonical: BundleManifest;
  try {
    canonical = canonicalizeManifest(manifest);
  } catch {
    return fail("manifest is not canonical and valid");
  }
  for (const file of canonical.files) {
    const value = sourceBytes.get(file.path);
    if (!value || value.length !== file.size || digest(value) !== file.sha256)
      return fail("manifest file does not match its bytes", file.path);
  }
  const entryPath = canonical.entrypoint;
  const decode = (file: string) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        sourceBytes.get(file)!,
      );
    } catch {
      return null;
    }
  };
  const entryHtml = decode(entryPath);
  if (entryHtml === null)
    return fail("entrypoint is not valid UTF-8", entryPath);
  let document: Node;
  try {
    document = parse(entryHtml, { sourceCodeLocationInfo: true }) as Node;
  } catch {
    return fail("entrypoint is not valid HTML", entryPath);
  }

  const { scripts, cdnLinks, runtime } = scanPage(document);
  if (!runtime) return null;

  const files = new Map(canonical.files.map((file) => [file.path, file]));
  const modules: Module[] = [];
  const globals = new Set<string>();
  const addons: Array<{ module: string; name: string }> = [];
  const warnings = new Set<string>();
  // Compiled lines that came from inline scripts or merged Babel scripts.
  const origins = new Map<string, Segment[]>();
  let preflight = cdnLinks.length > 0;
  let tailwindConfig: Record<string, unknown> | null = null;
  let anchor: Node | null = null;
  const placeholderJs = `/*polka-runtime-js:${digest(JSON.stringify(canonical))}*/`;
  const placeholderCss = `/*polka-runtime-css:${digest(JSON.stringify(canonical))}*/`;
  walk(document, (node) => {
    if (
      node.tagName === "meta" &&
      (attr(node, "name") ?? "").toLowerCase() === RUNTIME_TAILWIND_META &&
      (attr(node, "content") ?? "").trim().toLowerCase() === "preflight"
    )
      preflight = true;
  });
  for (const node of cdnLinks) remove(node);
  // Babel standalone runs every text/babel script after the document is
  // parsed, as scripts sharing one global scope; here they become one module
  // (in page order) so a component declared in one is visible in the next.
  let babelModule: {
    module: Module;
    segments: Segment[];
    lines: number;
  } | null = null;
  const babelSources = new Set<string>();
  const babelPath = path.posix.join(
    path.posix.dirname(entryPath),
    "polka-babel.jsx",
  );
  for (const [index, node] of scripts.entries()) {
    const type = typeOf(node);
    const source = attr(node, "src");
    if (!isRuntimeScript(node)) {
      if (source && /^[a-z][a-z\d+.-]*:|^\/\//i.test(source.trim()))
        return fail(
          `script ${source.trim().slice(0, 120)} needs the network; the Полка runtime is offline and provides: ${RUNTIME_LIBRARY_NAMES}`,
          entryPath,
        );
      if (!source && CLASSIC_TYPES.includes(type)) {
        const text = (node.childNodes ?? [])
          .map((child) => child.value ?? "")
          .join("");
        if (/\btailwind\s*\.\s*config\s*=/.test(text)) {
          const found = inlineTailwindConfig(text);
          if (!found)
            warnings.add(
              "tailwind.config не применён: в нём есть функции или ссылки, поддерживаются только значения",
            );
          else {
            tailwindConfig = found.config;
            if (found.skipped)
              warnings.add(
                "из tailwind.config взяты только значения; функции, плагины и ссылки пропущены",
              );
          }
        }
      }
      continue;
    }
    if (type === "importmap") {
      // Bare specifiers resolve to the vendored libraries, never to its URLs.
      remove(node);
      continue;
    }
    if (!MODULE_TYPES.includes(type)) {
      const role = cdnRole(source)!;
      if (role.kind === "refuse") return fail(role.reason, entryPath);
      if (role.kind === "tailwind") preflight = true;
      if (role.kind === "library") globals.add(role.library.name);
      if (role.kind === "addon") {
        globals.add("three");
        if (!addons.some((addon) => addon.module === role.module))
          addons.push({ module: role.module, name: role.name });
      }
      if (!anchor) anchor = node;
      else remove(node);
      continue;
    }
    let text: string;
    let origin: { path: string; line: number };
    let module: Module;
    if (source !== undefined) {
      const resolved = resolveLocal(source, entryPath);
      if (!resolved)
        return fail(
          `module script ${source.slice(0, 120)} is not a file of this page; the runtime has no network`,
          entryPath,
        );
      const file = files.get(resolved);
      const loader = loaderFor(resolved);
      if (!file)
        return fail("module script is missing from the bundle", resolved);
      if (
        file.mime !== "text/javascript" ||
        !loader ||
        loader === "css" ||
        loader === "json"
      )
        return fail(
          "module script must be a .js, .mjs, .jsx, .ts or .tsx file",
          resolved,
        );
      const decoded = decode(resolved);
      if (decoded === null)
        return fail("module script is not valid UTF-8", resolved);
      text = decoded;
      origin = { path: resolved, line: 1 };
      module = { path: resolved, source: text, loader };
    } else {
      text = (node.childNodes ?? []).map((child) => child.value ?? "").join("");
      origin = { path: entryPath, line: scriptLine(node) };
      const virtual = path.posix.join(
        path.posix.dirname(entryPath),
        `polka-inline-${index}.jsx`,
      );
      module = { path: virtual, source: text, loader: "jsx" };
    }
    if (type !== "module") {
      // Babel-in-the-browser pages use React and ReactDOM as globals.
      globals.add("react");
      globals.add("react-dom");
      if (!babelModule) {
        babelModule = {
          module: { path: babelPath, source: "", loader: "jsx" },
          segments: [],
          lines: 0,
        };
        modules.push(babelModule.module);
        origins.set(babelPath, babelModule.segments);
      }
      babelModule.segments.push({ start: babelModule.lines + 1, ...origin });
      babelModule.module.source += `${text}\n`;
      babelModule.lines += text.split("\n").length;
      if (origin.path !== entryPath) babelSources.add(origin.path);
    } else {
      if (source === undefined)
        origins.set(module.path, [{ start: 1, ...origin }]);
      modules.push(module);
    }
    if (!anchor) anchor = node;
    else remove(node);
  }
  const head = findElement(document, "head");
  const body = findElement(document, "body");
  if (!head || !body) return fail("entrypoint has no head or body", entryPath);
  // The compiled script takes the place of the first runtime script (so CDN
  // globals exist for later classic scripts), or ends the body.
  const parent: Node = (anchor as Node | null)?.parentNode ?? body;
  const runtimeScript = element("script", placeholderJs, parent);
  const siblings = parent.childNodes!;
  if (anchor) siblings.splice(siblings.indexOf(anchor), 1, runtimeScript);
  else siblings.push(runtimeScript);
  insertIntoHead(head, [
    element("script", PRELUDE, head),
    element("style", placeholderCss, head),
  ]);

  // The rest of the page (styles, images, links, classic scripts) is checked
  // and inlined by the v4 rules on the rewritten entrypoint.
  const rewritten = Buffer.from(
    serialize(document as unknown as DefaultTreeAdapterTypes.ParentNode),
  );
  const rewrittenManifest = {
    ...canonical,
    files: canonical.files.map((file) =>
      file.path === entryPath
        ? { ...file, size: rewritten.length, sha256: digest(rewritten) }
        : file,
    ),
  };
  const page = buildInlineBundle(
    rewrittenManifest,
    new Map([...sourceBytes, [entryPath, rewritten]]),
    { prelude: false },
  );
  if (!page.ok) return page;
  for (const warning of page.warnings) warnings.add(warning);

  /** A compiled file and line as the page's own file and line. */
  const where = (file: string, line?: number) => {
    const segments = origins.get(file);
    if (!segments)
      return { path: file, label: line ? `${file}:${line}` : file };
    const at = line ?? 1;
    const segment =
      [...segments].reverse().find((item) => item.start <= at) ?? segments[0];
    const real = segment.line + (at - segment.start);
    return {
      path: segment.path,
      label: line ? `${segment.path}:${real}` : segment.path,
    };
  };

  // All code files together stay bounded even when most are never loaded.
  const codeBytes = canonical.files
    .filter((file) => file.path !== entryPath && loaderFor(file.path) !== null)
    .reduce((total, file) => total + file.size, 0);
  if (codeBytes > BUILD_LIMITS.bundleCodeBytes)
    return fail("the bundle's code files exceed 8 MiB", entryPath);

  const userSources = new Map(modules.map((module) => [module.path, module]));
  const mount = modules.some((module) => exportsDefault(module.source));
  let refused: { reason: string; path: string } | null = null;
  let broken = false;
  const refuse = (reason: string, file: string) => {
    refused ??= { reason, path: where(file).path };
    return { errors: [{ text: reason }] };
  };
  const notAllowed = () => refuse("import not allowed", entryPath);
  // Each file esbuild loads from the page is checked before esbuild parses
  // it: count and size caps, a nesting bound, and static import specifiers
  // only. Files the page never loads are not checked or counted.
  let loadedFiles = 0;
  let loadedBytes = 0;
  const guard = async (file: string, source: string, loader: Loader) => {
    if (++loadedFiles > BUILD_LIMITS.runtimeModules)
      return refuse(
        `a runtime page may load at most ${BUILD_LIMITS.runtimeModules} source files`,
        file,
      );
    loadedBytes += Buffer.byteLength(source);
    if (loadedBytes > BUILD_LIMITS.runtimeSourceBytes)
      return refuse("runtime sources exceed 2 MiB", file);
    if (!withinNestingLimits(source))
      return refuse("source nests too deeply to compile safely", file);
    let refusal: string | null;
    try {
      refusal = await staticImportsOnly(source, loader);
    } catch {
      broken = true;
      return { errors: [{ text: "compiler failed" }] };
    }
    if (refusal) {
      const line = /\(line (\d+)\)$/.exec(refusal);
      const place = where(file, line ? Number(line[1]) : undefined);
      return refuse(
        line ? refusal.replace(/\(line \d+\)$/, `(${place.label})`) : refusal,
        file,
      );
    }
    return null;
  };
  const plugin: Plugin = {
    name: "polka-runtime",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point")
          return { path: "entry", namespace: "polka" };
        if (args.namespace !== "polka" && args.namespace !== "user") return;
        // Only the generated entry names page modules directly.
        if (args.namespace === "polka" && args.path.startsWith("user:")) {
          const target = args.path.slice(5);
          if (userSources.has(target))
            return { path: target, namespace: "user" };
        }
        const importer = args.namespace === "user" ? args.importer : entryPath;
        if (args.path.startsWith("./") || args.path.startsWith("../")) {
          const resolved = resolveUserFile(
            args.path,
            importer,
            files,
            entryPath,
          );
          if (resolved) return { path: resolved, namespace: "user" };
          return refuse(
            `import "${args.path}" is not a file of this page`,
            importer,
          );
        }
        // Library imports resolve from Полка's node_modules.
        if (args.kind !== "url-token" && runtimeLibraryFor(args.path)) return;
        // A CDN URL of an allowlisted library is the vendored library.
        const vendored =
          args.kind !== "url-token" && /^https?:\/\//i.test(args.path)
            ? vendoredSpecifier(args.path)
            : null;
        if (vendored) {
          const resolved = await builder.resolve(vendored, {
            kind: args.kind,
            resolveDir: ROOT,
          });
          if (resolved.errors.length) return { errors: resolved.errors };
          return {
            path: resolved.path,
            namespace: resolved.namespace,
            sideEffects: resolved.sideEffects,
          };
        }
        return refuse(
          args.kind === "url-token"
            ? `stylesheet resource "${args.path.slice(0, 120)}" is unsupported; inline it as a data: URI`
            : /^[a-z][a-z\d+.-]*:|^\/\//i.test(args.path)
              ? `import "${args.path.slice(0, 120)}" needs the network; the Полка runtime is offline and provides: ${RUNTIME_LIBRARY_NAMES}`
              : `module "${args.path.slice(0, 120)}" is not available in the Полка runtime; it provides: ${RUNTIME_LIBRARY_NAMES}`,
          importer,
        );
      });
      builder.onLoad({ filter: /.*/, namespace: "polka" }, () => ({
        contents: entrySource(modules, globals, addons, mount),
        loader: "js",
        resolveDir: ROOT,
      }));
      builder.onLoad({ filter: /.*/, namespace: "user" }, async (args) => {
        const inline = userSources.get(args.path);
        const loader = inline?.loader ?? loaderFor(args.path);
        const contents =
          inline?.source ?? (files.has(args.path) ? decode(args.path) : null);
        if (!loader) return notAllowed();
        if (contents === null)
          return refuse("source is not valid UTF-8", args.path);
        const refusal = await guard(args.path, contents, loader);
        if (refusal) return refusal;
        return { contents, loader, resolveDir: ROOT };
      });
      // Every file esbuild reads from disk, including glob expansions that
      // never pass onResolve, must belong to an allowed library package.
      builder.onLoad({ filter: /.*/ }, (args) => {
        // A library's browser-disabled builtin ("crypto": false) is an
        // empty stub esbuild makes without reading anything.
        if (args.namespace === "") return undefined;
        if (args.namespace !== "file") return notAllowed();
        if (!isAllowedLibraryFile(args.path, libraryDirs()))
          return notAllowed();
        return undefined;
      });
    },
  };
  let js: string;
  let importedCss = "";
  let consumed: string[];
  try {
    const result = await build({
      entryPoints: [{ in: "polka:entry", out: "runtime" }],
      outdir: "/polka-runtime",
      absWorkingDir: ROOT,
      bundle: true,
      write: false,
      metafile: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      jsx: "automatic",
      tsconfigRaw: "{}",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
      plugins: [plugin],
    });
    js =
      result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "";
    importedCss =
      result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
    for (const input of Object.keys(result.metafile.inputs)) {
      if (
        input.startsWith("user:") ||
        input === "polka:entry" ||
        input.startsWith("(disabled):")
      )
        continue;
      if (
        /^[a-z-]+:/.test(input) ||
        !isAllowedLibraryFile(path.resolve(ROOT, input), libraryDirs())
      )
        return fail("import not allowed", entryPath);
    }
    consumed = Object.keys(result.metafile.inputs)
      .filter((input) => input.startsWith("user:"))
      .map((input) => input.slice(5))
      .filter((input) => files.has(input));
  } catch (error) {
    if (broken) return compilerFailure();
    const current = refused as { reason: string; path: string } | null;
    if (current) return fail(current.reason, current.path);
    const errors = (error as { errors?: Message[] }).errors;
    // No diagnostics: the esbuild service itself stopped or never started.
    if (!Array.isArray(errors) || !errors.length) return compilerFailure();
    return describe(errors, where, entryPath);
  }
  if (Buffer.byteLength(js) > MAX_SCRIPT_BYTES)
    return fail("compiled script exceeds 7 MiB", entryPath);
  // esbuild escapes "</script"; an HTML comment opener could still change how
  // the parser ends the inline script, so it is refused.
  if (/<\/script/i.test(js) || js.includes("<!--"))
    return fail(
      "compiled script contains an HTML comment or closing sequence",
      entryPath,
    );

  const words = candidates([
    entryHtml,
    ...modules.map((module) => module.source),
    ...consumed.map((file) => decode(file) ?? ""),
  ]);
  let css: string;
  try {
    css = (await tailwindCss(words, preflight, tailwindConfig)) + importedCss;
  } catch {
    return fail(
      tailwindConfig
        ? "Tailwind CSS could not be generated with the page's tailwind.config"
        : "Tailwind CSS could not be generated",
      entryPath,
    );
  }
  const checked = checkGeneratedCss(css);
  if (checked.error !== undefined)
    return fail(`generated stylesheet refused: ${checked.error}`, entryPath);

  const html = page.html.toString("utf8");
  const jsTag = `<script>${placeholderJs}</script>`;
  const cssTag = `<style>${placeholderCss}</style>`;
  if (html.split(jsTag).length !== 2 || html.split(cssTag).length !== 2)
    return fail("runtime placeholders were not preserved", entryPath);
  const output = Buffer.from(
    html
      .replace(cssTag, () => `<style>${checked.css}</style>`)
      .replace(jsTag, () => `<script>${js}</script>`),
  );
  if (output.length > MAX_OUTPUT_BYTES)
    return fail("compiled page exceeds 8 MiB", entryPath);
  return {
    ok: true,
    sourceManifestSha256: digest(JSON.stringify(canonical)),
    builderVersion: BUNDLE_BUILDER_VERSION,
    runtimeProfile: REACT_RUNTIME_PROFILE,
    html: output,
    sha256: digest(output),
    size: output.length,
    consumedPaths: [
      ...new Set([
        ...page.consumedPaths,
        ...consumed,
        ...babelSources,
        ...modules
          .map((module) => module.path)
          .filter((file) => files.has(file)),
      ]),
    ].sort(),
    warnings: [...warnings],
  };
}

/**
 * A compile error is reported only when it points into the page's own
 * source; anything about library or server files stays generic, and
 * absolute paths are removed from the text. Lines of inline and merged
 * scripts are named by the page file and line they came from.
 */
function describe(
  errors: Message[],
  where: (file: string, line?: number) => { path: string; label: string },
  entryPath: string,
) {
  const first = errors[0];
  if (!first?.location?.file.startsWith("user:"))
    return fail("compilation failed", entryPath);
  const text = first.text.replace(/(?:^|(?<=[\s"'(]))\/[^\s"')]*/g, "…");
  const place = where(first.location.file.slice(5), first.location.line);
  return fail(
    `compilation failed: ${text} (${place.label})`.slice(0, 280),
    place.path,
  );
}

/** A relative import to another source file of the bundle. */
function resolveUserFile(
  reference: string,
  importer: string,
  files: Map<string, BundleManifest["files"][number]>,
  entryPath: string,
) {
  const base = resolveLocal(reference, importer);
  if (!base) return null;
  const extensions = Object.keys(RUNTIME_MODULE_LOADERS);
  for (const candidate of [
    base,
    ...extensions.map((extension) => base + extension),
    ...extensions.map((extension) => `${base}/index${extension}`),
  ]) {
    const file = files.get(candidate);
    const loader = loaderFor(candidate);
    if (!file || candidate === entryPath || !loader) continue;
    const expected =
      loader === "css"
        ? "text/css"
        : loader === "json"
          ? "application/json"
          : "text/javascript";
    if (file.mime === expected) return candidate;
  }
  return null;
}

/**
 * The builder entry: a runtime page when the entrypoint asks for one,
 * otherwise the v4 rules. Both carry the current builder version.
 */
export async function buildDerivative(
  manifest: BundleManifest,
  sourceBytes: Map<string, Buffer>,
  { allowRuntime = true }: { allowRuntime?: boolean } = {},
): Promise<BundleInlineResult> {
  // The service admits runtime builds one at a time; a page it classified as
  // classic must not start esbuild here.
  if (!allowRuntime && needsRuntimeBuild(manifest, sourceBytes))
    return fail("runtime build was not admitted", manifest.entrypoint);
  return (
    (await buildRuntimeBundle(manifest, sourceBytes)) ??
    buildInlineBundle(manifest, sourceBytes)
  );
}
