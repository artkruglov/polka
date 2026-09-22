import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  buildInlineBundle,
  checkGeneratedCss,
  type BundleInlineResult,
} from "./bundle-inline.ts";
import {
  BUNDLE_BUILDER_VERSION,
  REACT_RUNTIME_PROFILE,
} from "./bundle-runtime-contract.ts";
import {
  MAX_RUNTIME_MODULES,
  MAX_RUNTIME_SOURCE_BYTES,
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
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 7 * 1024 * 1024;
const MAX_CANDIDATES = 20_000;
const XHTML = "http://www.w3.org/1999/xhtml";
let allowedDirs: string[] | null = null;
const libraryDirs = () =>
  (allowedDirs ??= allowedPackageDirs(
    ROOT,
    RUNTIME_LIBRARIES.map((library) => library.name),
  ));

type Node = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  namespaceURI?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
  parentNode?: Node | null;
};

type Module = { path: string; source: string; loader: Loader };

const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

const fail = (reason: string, resourcePath?: string): BundleInlineResult => ({
  ok: false,
  reason,
  ...(resourcePath ? { path: resourcePath } : {}),
});

const attr = (node: Node, name: string) =>
  node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;

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

/** The npm package a CDN script or stylesheet URL names, or null. */
function cdnPackage(reference: string | undefined) {
  if (!reference) return null;
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "cdn.tailwindcss.com") return "tailwindcss";
  const match =
    url.hostname === "unpkg.com"
      ? /^\/((?:@[^/@]+\/)?[^/@]+)/.exec(url.pathname)
      : url.hostname === "cdn.jsdelivr.net"
        ? /^\/npm\/((?:@[^/@]+\/)?[^/@]+)/.exec(url.pathname)
        : url.hostname === "cdnjs.cloudflare.com"
          ? /^\/ajax\/libs\/([^/]+)/.exec(url.pathname)
          : null;
  return match?.[1] ?? null;
}

const cdnLibrary = (name: string) =>
  RUNTIME_LIBRARIES.find((library) =>
    (library.cdnNames as readonly string[]).includes(name),
  ) ?? null;

type CdnRole =
  | { kind: "library"; library: RuntimeLibrary }
  | { kind: "tailwind" }
  | { kind: "drop" };

function cdnRole(reference: string | undefined): CdnRole | null {
  const name = cdnPackage(reference);
  if (!name) return null;
  if (TAILWIND_PACKAGES.includes(name)) return { kind: "tailwind" };
  if (BABEL_PACKAGES.includes(name) || DROPPED_PACKAGES.includes(name))
    return { kind: "drop" };
  const library = cdnLibrary(name);
  return library ? { kind: "library", library } : null;
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

function element(tag: string, text: string, parentNode: Node): Node {
  const node: Node = {
    nodeName: tag,
    tagName: tag,
    namespaceURI: XHTML,
    attrs: [],
    childNodes: [],
    parentNode,
  };
  node.childNodes!.push({ nodeName: "#text", value: text, parentNode: node });
  return node;
}

function find(node: Node, tag: string): Node | null {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes ?? []) {
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

/** Inserts after the leading meta/title/base elements of head. */
function insertIntoHead(head: Node, nodes: Node[]) {
  const children = head.childNodes!;
  let at = 0;
  while (
    at < children.length &&
    (!children[at].tagName ||
      ["meta", "title", "base"].includes(children[at].tagName!))
  )
    at++;
  for (const node of nodes) node.parentNode = head;
  children.splice(at, 0, ...nodes);
}

/**
 * Browser APIs the sandbox refuses, replaced so a chat artifact keeps
 * working: storage lives in memory for the open page, network and the
 * artifact model API fail with a clear message instead of a SecurityError.
 */
const PRELUDE = `(()=>{"use strict";
const memory=()=>{const m=new Map();return{get length(){return m.size},key(i){return[...m.keys()][i]??null},getItem(k){k=String(k);return m.has(k)?m.get(k):null},setItem(k,v){m.set(String(k),String(v))},removeItem(k){m.delete(String(k))},clear(){m.clear()}}};
for(const name of["localStorage","sessionStorage"])try{Object.defineProperty(window,name,{value:memory(),configurable:true})}catch{}
try{Object.defineProperty(document,"cookie",{get(){return""},set(){},configurable:true})}catch{}
const kept=new Map();
window.storage={async get(key){key=String(key);return kept.has(key)?{key,value:kept.get(key),shared:false}:null},async set(key,value){key=String(key);kept.set(key,String(value));return{key,value:String(value),shared:false}},async delete(key){key=String(key);return{key,deleted:kept.delete(key),shared:false}},async list(prefix){prefix=prefix==null?"":String(prefix);return{keys:[...kept.keys()].filter(k=>k.startsWith(prefix)),prefix,shared:false}}};
const offline=()=>Promise.reject(new TypeError("Полка: у страницы нет доступа к сети."));
window.fetch=offline;
window.claude={complete:()=>Promise.reject(new Error("Полка: вызовы модели из страницы недоступны."))};
})();`;

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
  three: `import * as __g_three from "three";globalThis.THREE=__g_three;`,
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
  mount: boolean,
) {
  const lines = [...globals].map((name) => GLOBAL_SETUP[name]);
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
  (RUNTIME_MODULE_LOADERS as Record<string, Loader>)[path.posix.extname(file)] ??
  (file.endsWith(".css") ? "css" : file.endsWith(".json") ? "json" : null);

/**
 * A compile error is reported only when it points into the page's own
 * source; anything about library or server files stays generic, and
 * absolute paths are removed from the text.
 */
function describe(errors: Message[]) {
  const first = errors[0];
  if (!first?.location?.file.startsWith("user:")) return "compilation failed";
  const text = first.text.replace(/(?:^|(?<=[\s"'(]))\/[^\s"')]*/g, "…");
  return `compilation failed: ${text} (${first.location.file.slice(5)}:${first.location.line})`.slice(0, 280);
}

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

async function tailwindCss(words: string[], preflight: boolean) {
  tailwind ??= import("tailwindcss");
  const { compile } = await tailwind;
  const compiler = await compile(
    preflight
      ? `@import "tailwindcss";`
      : `@layer theme, base, components, utilities;\n@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);`,
    {
      base: ROOT,
      loadStylesheet: async (id) => tailwindStylesheet(id),
      loadModule: async () => {
        throw Error("Tailwind plugins are not part of the runtime");
      },
    },
  );
  return compiler.build(words);
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

/**
 * Whether a page is built by the runtime (esbuild) rather than the v4 rules.
 * The build service uses it to admit one runtime build at a time.
 */
export function needsRuntimeBuild(
  manifest: BundleManifest,
  sourceBytes: Map<string, Buffer>,
) {
  const entry = sourceBytes.get(manifest.entrypoint);
  if (!entry) return false;
  try {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(entry);
    return scanPage(parse(html) as Node).runtime;
  } catch {
    return false;
  }
}

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
  if (entryHtml === null) return fail("entrypoint is not valid UTF-8", entryPath);
  let document: Node;
  try {
    document = parse(entryHtml) as Node;
  } catch {
    return fail("entrypoint is not valid HTML", entryPath);
  }

  const { scripts, cdnLinks, runtime } = scanPage(document);
  if (!runtime) return null;

  const files = new Map(canonical.files.map((file) => [file.path, file]));
  const modules: Module[] = [];
  const globals = new Set<string>();
  let preflight = cdnLinks.length > 0;
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
  for (const [index, node] of scripts.entries()) {
    const type = typeOf(node);
    const source = attr(node, "src");
    if (!isRuntimeScript(node)) {
      if (source && /^[a-z][a-z\d+.-]*:|^\/\//i.test(source.trim()))
        return fail(
          `script ${source.trim().slice(0, 120)} needs the network; the Полка runtime is offline and provides: ${RUNTIME_LIBRARY_NAMES}`,
          entryPath,
        );
      continue;
    }
    if (type === "importmap") {
      // Bare specifiers resolve to the vendored libraries, never to its URLs.
      remove(node);
      continue;
    }
    if (!MODULE_TYPES.includes(type)) {
      const role = cdnRole(source)!;
      if (role.kind === "tailwind") preflight = true;
      if (role.kind === "library") globals.add(role.library.name);
      if (!anchor) anchor = node;
      else remove(node);
      continue;
    }
    // Babel-in-the-browser pages use React and ReactDOM as globals.
    if (type !== "module") {
      globals.add("react");
      globals.add("react-dom");
    }
    if (source !== undefined) {
      const resolved = localPath(source, entryPath);
      if (!resolved)
        return fail(
          `module script ${source.slice(0, 120)} is not a file of this page; the runtime has no network`,
          entryPath,
        );
      const file = files.get(resolved);
      const loader = loaderFor(resolved);
      if (!file) return fail("module script is missing from the bundle", resolved);
      if (file.mime !== "text/javascript" || !loader || loader === "css" || loader === "json")
        return fail("module script must be a .js, .mjs, .jsx, .ts or .tsx file", resolved);
      const text = decode(resolved);
      if (text === null) return fail("module script is not valid UTF-8", resolved);
      modules.push({ path: resolved, source: text, loader });
    } else {
      const text = (node.childNodes ?? []).map((child) => child.value ?? "").join("");
      const virtual = path.posix.join(
        path.posix.dirname(entryPath),
        `polka-inline-${index}.jsx`,
      );
      modules.push({ path: virtual, source: text, loader: "jsx" });
    }
    if (!anchor) anchor = node;
    else remove(node);
  }
  const head = find(document, "head");
  const body = find(document, "body");
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
  );
  if (!page.ok) return page;

  // Everything esbuild could parse from the page, checked before it runs:
  // count and size caps, a nesting bound, and static import specifiers only.
  const codeFiles = canonical.files.filter(
    (file) => file.path !== entryPath && loaderFor(file.path) !== null,
  );
  const sources = [
    ...modules.filter((module) => !files.has(module.path)),
    ...codeFiles.map((file) => ({
      path: file.path,
      source: decode(file.path),
      loader: loaderFor(file.path)!,
    })),
  ];
  if (sources.length > MAX_RUNTIME_MODULES)
    return fail(`a runtime page may have at most ${MAX_RUNTIME_MODULES} source files`, entryPath);
  if (
    sources.reduce((total, item) => total + Buffer.byteLength(item.source ?? ""), 0) >
    MAX_RUNTIME_SOURCE_BYTES
  )
    return fail("runtime sources exceed 2 MiB", entryPath);
  for (const item of sources) {
    if (item.source === null) return fail("source is not valid UTF-8", item.path);
    if (!withinNestingLimits(item.source))
      return fail("source nests too deeply to compile safely", item.path);
  }
  for (const item of sources) {
    const refusal = await staticImportsOnly(item.source!, item.loader);
    if (refusal) return fail(refusal, item.path);
  }

  const userSources = new Map(modules.map((module) => [module.path, module]));
  const mount = modules.some((module) => exportsDefault(module.source));
  let refused: { reason: string; path: string } | null = null;
  const notAllowed = () => {
    refused ??= { reason: "import not allowed", path: entryPath };
    return { errors: [{ text: "import not allowed" }] };
  };
  const plugin: Plugin = {
    name: "polka-runtime",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point")
          return { path: "entry", namespace: "polka" };
        if (args.namespace !== "polka" && args.namespace !== "user") return;
        // Only the generated entry names page modules directly.
        if (args.namespace === "polka" && args.path.startsWith("user:")) {
          const target = args.path.slice(5);
          if (userSources.has(target)) return { path: target, namespace: "user" };
        }
        const importer = args.namespace === "user" ? args.importer : entryPath;
        if (args.path.startsWith("./") || args.path.startsWith("../")) {
          const resolved = resolveUserFile(args.path, importer, files, entryPath);
          if (resolved) return { path: resolved, namespace: "user" };
          refused ??= {
            reason: `import "${args.path}" is not a file of this page`,
            path: importer,
          };
          return { errors: [{ text: refused.reason }] };
        }
        // Library imports resolve from Полка's node_modules.
        if (args.kind !== "url-token" && runtimeLibraryFor(args.path)) return;
        refused ??= {
          reason:
            args.kind === "url-token"
              ? `stylesheet resource "${args.path.slice(0, 120)}" is unsupported; inline it as a data: URI`
              : /^[a-z][a-z\d+.-]*:|^\/\//i.test(args.path)
                ? `import "${args.path.slice(0, 120)}" needs the network; the Полка runtime is offline and provides: ${RUNTIME_LIBRARY_NAMES}`
                : `module "${args.path.slice(0, 120)}" is not available in the Полка runtime; it provides: ${RUNTIME_LIBRARY_NAMES}`,
          path: importer,
        };
        return { errors: [{ text: refused.reason }] };
      });
      builder.onLoad({ filter: /.*/, namespace: "polka" }, () => ({
        contents: entrySource(modules, globals, mount),
        loader: "js",
        resolveDir: ROOT,
      }));
      builder.onLoad({ filter: /.*/, namespace: "user" }, (args) => {
        const inline = userSources.get(args.path);
        if (inline) return { contents: inline.source, loader: inline.loader, resolveDir: ROOT };
        const loader = loaderFor(args.path);
        const contents = files.has(args.path) ? decode(args.path) : null;
        if (!loader || contents === null) return notAllowed();
        return { contents, loader, resolveDir: ROOT };
      });
      // Every file esbuild reads from disk, including glob expansions that
      // never pass onResolve, must belong to an allowed library package.
      builder.onLoad({ filter: /.*/ }, (args) => {
        // A library's browser-disabled builtin ("crypto": false) is an
        // empty stub esbuild makes without reading anything.
        if (args.namespace === "") return undefined;
        if (args.namespace !== "file") return notAllowed();
        if (!isAllowedLibraryFile(args.path, libraryDirs())) return notAllowed();
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
    js = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "";
    importedCss =
      result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input.startsWith("user:") || input === "polka:entry" || input.startsWith("(disabled):")) continue;
      if (/^[a-z-]+:/.test(input) || !isAllowedLibraryFile(path.resolve(ROOT, input), libraryDirs()))
        return fail("import not allowed", entryPath);
    }
    consumed = Object.keys(result.metafile.inputs)
      .filter((input) => input.startsWith("user:"))
      .map((input) => input.slice(5))
      .filter((input) => files.has(input));
  } catch (error) {
    const current = refused as { reason: string; path: string } | null;
    if (current) return fail(current.reason, current.path);
    const errors = (error as { errors?: Message[] }).errors;
    return fail(errors ? describe(errors) : "compilation failed", entryPath);
  }
  if (Buffer.byteLength(js) > MAX_SCRIPT_BYTES)
    return fail("compiled script exceeds 7 MiB", entryPath);
  // esbuild escapes "</script"; an HTML comment opener could still change how
  // the parser ends the inline script, so it is refused.
  if (/<\/script/i.test(js) || js.includes("<!--"))
    return fail("compiled script contains an HTML comment or closing sequence", entryPath);

  const words = candidates([
    entryHtml,
    ...modules.map((module) => module.source),
    ...consumed.map((file) => decode(file) ?? ""),
  ]);
  let css: string;
  try {
    css = (await tailwindCss(words, preflight)) + importedCss;
  } catch {
    return fail("Tailwind CSS could not be generated", entryPath);
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
        ...modules.map((module) => module.path).filter((file) => files.has(file)),
      ]),
    ].sort(),
  };
}

function localPath(reference: string, from: string) {
  if (
    !reference ||
    /^[a-z][a-z\d+.-]*:/i.test(reference) ||
    reference.startsWith("/") ||
    /[?#%\\\s\u0000-\u001f\u007f]/.test(reference)
  )
    return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), reference),
  );
  return resolved === "." || resolved.startsWith("../") || resolved === ".."
    ? null
    : resolved;
}

/** A relative import to another source file of the bundle. */
function resolveUserFile(
  reference: string,
  importer: string,
  files: Map<string, BundleManifest["files"][number]>,
  entryPath: string,
) {
  const base = localPath(reference, importer);
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
      loader === "css" ? "text/css" : loader === "json" ? "application/json" : "text/javascript";
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
