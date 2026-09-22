import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalizeManifest } from "../packages/contracts/bundle.ts";
import { RUNTIME_LIBRARIES, runtimeLibraryFor } from "../packages/contracts/runtime.ts";
import { buildInlineBundle } from "../apps/server/bundle-inline.ts";
import { buildDerivative } from "../apps/server/react-runtime.ts";
import { componentShell } from "../packages/contracts/runtime.ts";

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const mimeOf = (path: string) =>
  path.endsWith(".html")
    ? "text/html"
    : path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".json")
        ? "application/json"
        : "text/javascript";

function fixture(sources: Record<string, string>) {
  const bytes = new Map(
    Object.entries(sources).map(([path, text]) => [path, Buffer.from(text)]),
  );
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "inline-live-experimental-v1",
    files: [...bytes].map(([path, value]) => ({
      path,
      mime: mimeOf(path),
      size: value.length,
      sha256: digest(value),
    })),
    provenance: {
      kind: "mcp",
      sourceUrl: null,
      capturedAt: "2026-09-22T10:00:00Z",
      attribution: "Test",
      license: "unknown",
    },
    dependencies: { status: "self-contained", unresolved: [] },
  });
  return { manifest, bytes };
}

const component = (source: string, file = "App.jsx") =>
  fixture({ "index.html": componentShell("App", file), [file]: source });

async function compile(source: string, file = "App.jsx") {
  const value = component(source, file);
  return buildDerivative(value.manifest, value.bytes);
}

async function compiled(source: string, file = "App.jsx") {
  const result = await compile(source, file);
  if (!result.ok) assert.fail(`build refused: ${result.reason} (${result.path})`);
  return result;
}

/** The compiled page must reference nothing outside itself. */
function assertSelfContained(html: string) {
  assert.doesNotMatch(html, /<(?:link|iframe|object|embed|base)\b/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<script\b[^>]*\btype\s*=/i);
  assert.doesNotMatch(html, /\bsrc\s*=\s*["']?(?:https?:)?\/\//i);
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  assert.ok(css.length > 0);
  assert.equal(/url\(\s*["']?(?!data:)/i.test(css), false, "stylesheet references a resource");
  assert.equal(/@import/i.test(css), false, "stylesheet imports");
  // The final page passes the v4 inline checks as a single file.
  const single = fixture({ "index.html": html });
  const again = buildInlineBundle(single.manifest, single.bytes);
  assert.equal(again.ok, true, again.ok ? "" : again.reason);
}

test("allowlist matches the installed library versions", () => {
  for (const library of RUNTIME_LIBRARIES) {
    const installed = JSON.parse(
      readFileSync(new URL(`../node_modules/${library.name}/package.json`, import.meta.url), "utf8"),
    );
    assert.equal(installed.version, library.version, library.name);
    assert.equal(installed.license, library.license, library.name);
  }
  assert.equal(runtimeLibraryFor("three/addons/controls/OrbitControls.js")?.name, "three");
  assert.equal(runtimeLibraryFor("lodash/debounce")?.name, "lodash");
  assert.equal(runtimeLibraryFor("lodash/../fs"), null);
  assert.equal(runtimeLibraryFor("react-dom/server"), null);
  assert.equal(runtimeLibraryFor("fs"), null);
});

test("a useState counter with a lucide icon and Tailwind classes compiles into one page", async () => {
  const result = await compiled(`import React, { useState } from "react";
import { Heart } from "lucide-react";
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="p-4 md:flex bg-blue-500 hover:bg-red-200 text-[13px]">
      <Heart className="w-6 h-6" />
      <button id="add" onClick={() => setCount(count + 1)}>Clicked {count}</button>
    </main>
  );
}`);
  assert.equal(result.runtimeProfile, "react-runtime-v1");
  assert.equal(result.builderVersion, "bundle-inline-v6");
  assert.deepEqual(result.consumedPaths, ["App.jsx", "index.html"]);
  const html = result.html.toString("utf8");
  assert.match(html, /\.p-4\s*\{/);
  assert.match(html, /\.md\\:flex/);
  assert.match(html, /\.bg-blue-500/);
  assert.match(html, /\.text-\\\[13px\\\]/);
  // Preflight is part of a component page, as in the chat environment.
  assert.match(html, /box-sizing:\s*border-box/);
  assert.match(html, /Clicked /);
  assert.match(html, /localStorage/);
  assert.ok(result.size < 1024 * 1024, `${result.size} bytes`);
  assertSelfContained(html);
});

test("a Recharts chart compiles and stays within the output budget", async () => {
  const result = await compiled(`import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
const data = [{ month: "Jan", value: 12 }, { month: "Feb", value: 18 }, { month: "Mar", value: 9 }];
export default function Chart() {
  return (
    <div style={{ width: 480, height: 240 }}>
      <ResponsiveContainer><LineChart data={data}>
        <XAxis dataKey="month" /><YAxis /><Tooltip /><Line dataKey="value" stroke="#2563eb" />
      </LineChart></ResponsiveContainer>
    </div>
  );
}`);
  assert.ok(result.size < 8 * 1024 * 1024);
  assertSelfContained(result.html.toString("utf8"));
});

test("TypeScript components and relative source files compile", async () => {
  const value = fixture({
    "index.html": componentShell("App", "App.tsx"),
    "App.tsx": `import { total } from "./lib/sum";
import data from "./data.json";
import "./app.css";
type Props = { label?: string };
export default function App({ label = "Sum" }: Props) { return <p className="font-bold">{label}: {total(data.values)}</p>; }`,
    "lib/sum.ts": `export const total = (values: number[]): number => values.reduce((a, b) => a + b, 0);`,
    "data.json": `{"values":[1,2,3]}`,
    "app.css": `p { color: rgb(10 20 30); }`,
  });
  const result = await buildDerivative(value.manifest, value.bytes);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.deepEqual(result.consumedPaths, ["App.tsx", "app.css", "data.json", "index.html", "lib/sum.ts"]);
  assert.match(result.html.toString("utf8"), /p\{color:#0a141e\}/);
  assertSelfContained(result.html.toString("utf8"));
});

test("every allowlisted library compiles together within size and time", async () => {
  const started = Date.now();
  const result = await compiled(`import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import _ from "lodash";
import debounce from "lodash/debounce";
import * as d3 from "d3";
import Papa from "papaparse";
import * as math from "mathjs";
import Chart from "chart.js/auto";
import { BarChart } from "recharts";
import { Star } from "lucide-react";
import { createRoot } from "react-dom/client";
export default function App() {
  return <p>{[typeof THREE.Scene, typeof OrbitControls, _.sum([1, 2]), typeof debounce, d3.sum([1]), typeof Papa.parse, math.sqrt(16), typeof Chart, typeof BarChart, typeof Star, typeof createRoot].join(" ")}</p>;
}`);
  assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
  assert.ok(result.size < 8 * 1024 * 1024, `${result.size} bytes`);
  assertSelfContained(result.html.toString("utf8"));
});

test("a module outside the allowlist refuses the build and names the module", async () => {
  const result = await compile(`import { motion } from "framer-motion";
export default function App() { return <motion.div />; }`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /module "framer-motion" is not available in the Полка runtime/);
  assert.match(result.reason, /recharts/);
  // Refusal reasons are stored up to 300 characters; the module comes first.
  assert.ok(result.reason.length <= 300, `${result.reason.length}`);
  assert.equal(result.path, "App.jsx");
  for (const specifier of ["fs", "node:child_process", "react-dom/server", "@/components/ui/button"]) {
    const refused = await compile(`import x from "${specifier}"; export default () => x;`);
    assert.equal(refused.ok, false, specifier);
    if (!refused.ok) assert.match(refused.reason, new RegExp(`"${specifier.replace(/[/.]/g, "\\$&")}"`));
  }
});

test("network imports and missing files are refused", async () => {
  const remote = await compile(`import confetti from "https://esm.sh/canvas-confetti"; export default () => null;`);
  assert.equal(remote.ok, false);
  if (!remote.ok) assert.match(remote.reason, /needs the network/);
  const missing = await compile(`import { x } from "./nowhere"; export default () => x;`);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /"\.\/nowhere" is not a file of this page/);
  const syntax = await compile(`export default function App( { return <div>; }`);
  assert.equal(syntax.ok, false);
  if (!syntax.ok) {
    assert.match(syntax.reason, /compilation failed: .*\(App\.jsx:1\)/);
    assert.equal(syntax.path, "App.jsx");
  }
  const cdn = fixture({
    "index.html": `<!doctype html><html><head><script src="https://cdn.example.test/lib.js"></script></head><body><script type="module">console.log(1)</script></body></html>`,
  });
  const unknown = await buildDerivative(cdn.manifest, cdn.bytes);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /cdn\.example\.test.*needs the network/);
});

test("an HTML comment opener in compiled code is refused", async () => {
  const result = await compile(`export default () => <p>{"<!-- <script>"}</p>;`);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /HTML comment/);
});

test("Tailwind arbitrary values cannot reference a resource", async () => {
  const result = await compiled(
    `export default () => <div className="bg-[url(https://tracker.example/p.png)] bg-[url('/x.png')] p-2" />;`,
  );
  const css = [...result.html.toString("utf8").matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");
  assert.doesNotMatch(css, /tracker\.example|x\.png/);
  assert.match(css, /\.p-2/);
});

test("builds are deterministic and leave the source bytes untouched", async () => {
  const value = component(`export default () => <h1 className="text-xl">Hi</h1>;`);
  const before = new Map([...value.bytes].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const first = await buildDerivative(value.manifest, value.bytes);
  const second = await buildDerivative(value.manifest, value.bytes);
  assert.deepEqual(second, first);
  assert.deepEqual(value.bytes, before);
});

test("a chat HTML page with CDN React, Babel and Tailwind compiles offline", async () => {
  const value = fixture({
    "index.html": `<!doctype html><html><head><meta charset="utf-8">
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>h1{letter-spacing:.02em}</style></head>
<body><div id="root"></div>
<script type="text/babel">
const { useState } = React;
function App() { const [n, setN] = useState(1); return <h1 className="text-2xl font-bold" onClick={() => setN(n * 2)}>{n}</h1>; }
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
</script></body></html>`,
  });
  const result = await buildDerivative(value.manifest, value.bytes);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const html = result.html.toString("utf8");
  assert.equal(result.runtimeProfile, "react-runtime-v1");
  assert.match(html, /\.text-2xl/);
  assert.match(html, /letter-spacing/);
  assert.doesNotMatch(html, /unpkg|tailwindcss\.com\/|babel\.min/);
  assert.equal(html.match(/<\/script>/g)?.length, 2);
  assertSelfContained(html);
});

test("a page with only a Tailwind CDN stylesheet or an importmap is compiled", async () => {
  for (const head of [
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css">',
    '<script type="importmap">{"imports":{"react":"https://esm.sh/react"}}</script>',
  ]) {
    const value = fixture({
      "index.html": `<!doctype html><html><head>${head}</head><body><p class="text-lg underline">Hi</p></body></html>`,
    });
    const result = await buildDerivative(value.manifest, value.bytes);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) continue;
    const html = result.html.toString("utf8");
    assert.match(html, /\.text-lg/);
    assert.doesNotMatch(html, /jsdelivr|esm\.sh/);
    assertSelfContained(html);
  }
});

test("a page without module scripts keeps the v4 rules and profile", async () => {
  const value = fixture({
    "index.html": `<!doctype html><html><head><style>p{color:red}</style></head><body><p>x</p><script>document.body.dataset.ok=1</script></body></html>`,
  });
  const result = await buildDerivative(value.manifest, value.bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.runtimeProfile, "bundle-inline-experimental-v1");
  assert.equal(result.builderVersion, "bundle-inline-v6");
  // v6: a plain script gets the same environment prelude, but no compiler.
  assert.match(result.html.toString("utf8"), /^<!DOCTYPE html><html><head><script>\(\(\)=>\{"use strict";/);
  assert.doesNotMatch(result.html.toString("utf8"), /__polkaRun/);
});

// Security review of the runtime builder (22.09.2026): esbuild reads the
// server's disk, so computed imports, import attributes and files outside
// the allowlisted packages must never reach the bundle.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRETS = /S3_SECRET_KEY|DATABASE_URL|POSTGRES_PASSWORD|LINK_KEY|localhost|"name":\s*"polka"/;

async function refused(source: string, pattern: RegExp, file = "App.jsx") {
  const result = await compile(source, file);
  if (result.ok) {
    assert.doesNotMatch(result.html.toString("utf8"), SECRETS);
    assert.fail(`built instead of refusing: ${source}`);
  }
  assert.match(result.reason, pattern, source);
  assert.ok(!result.reason.includes(ROOT) && !result.reason.includes("node_modules"), result.reason);
}

test("computed imports and import attributes are refused before esbuild can glob the disk", async () => {
  const computed = /must name a module with a plain string|require must be called directly with one plain string/;
  const attributes = /import attributes/;
  await refused('const n = ""; export default async () => (await import(`../../.env${n}`)).default;', computed);
  await refused('const n = ""; export default async () => (await import(`../../.env${n}`, { with: { type: "text" } })).default;', attributes);
  await refused('const n = "self/environ"; export default async () => (await import(`../../../../../../../../proc/${n}`, { with: { type: "text" } })).default;', attributes);
  await refused('const n = "package"; export default () => require(`./${n}.json`);', computed);
  await refused('const n = "package"; export default () => require("../../" + n + ".json");', computed);
  await refused('const n = "x"; export default () => require.resolve(n);', computed);
  await refused('export default async () => import("./" + location.hash);', computed);
  await refused('import text from "./App.jsx" with { type: "text" };\nexport default () => text;', attributes);
  await refused('export * from "react" with { type: "js" };', attributes, "App.tsx");
  // A plain string, or a template without expressions, stays allowed.
  const ok = await compile('export default async () => { const m = await import(`react`); return typeof m; };');
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
});

test("page modules are named only through the generated entry", async () => {
  await refused('import secret from "user:../../.env";\nexport default () => secret;', /import "user:\.\.\/\.\.\/\.env" needs the network/);
  await refused('import secret from "/etc/hosts";\nexport default () => secret;', /is not available/);
});

test("only files of allowlisted library packages and their dependencies are readable", async () => {
  const { allowedPackageDirs, isAllowedLibraryFile } = await import("../apps/server/runtime-guards.ts");
  const dirs = allowedPackageDirs(ROOT, RUNTIME_LIBRARIES.map((library) => library.name));
  const at = (file: string) => isAllowedLibraryFile(path.join(ROOT, file), dirs);
  assert.equal(at("node_modules/react/index.js"), true);
  assert.equal(at("node_modules/d3-array/src/index.js"), true); // a resolved d3 dependency
  assert.equal(at("node_modules/immer/package.json"), true); // recharts -> @reduxjs/toolkit -> immer
  assert.equal(at("package.json"), false);
  assert.equal(at(".env"), false);
  assert.equal(at("apps/server/config.ts"), false);
  assert.equal(at("node_modules/pg/package.json"), false);
  assert.equal(at("node_modules/esbuild/package.json"), false);
  assert.equal(at("node_modules/react/../pg/package.json"), false);
  assert.equal(isAllowedLibraryFile("/etc/hosts", dirs), false);
  assert.equal(isAllowedLibraryFile("/proc/self/environ", dirs), false);
});

test("deeply nested sources are refused before esbuild parses them", async () => {
  const deep = /nests too deeply/;
  await refused(`export default () => ${"(".repeat(600)}1${")".repeat(600)};`, deep);
  await refused(`export default () => ${"<a>".repeat(600)}${"</a>".repeat(600)};`, deep);
  await refused(`export default () => ${"-".repeat(2000)}1;`, deep);
  await refused(`let a; export default () => ${"a?1:".repeat(1500)}2;`, deep);
  await refused(`let a; export default () => ${"a=".repeat(1500)}1;`, deep);
  const json = fixture({
    "index.html": componentShell("App", "App.jsx"),
    "App.jsx": 'import data from "./data.json"; export default () => data.length;',
    "data.json": `${"[".repeat(700)}${"]".repeat(700)}`,
  });
  const nested = await buildDerivative(json.manifest, json.bytes);
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.equal(nested.path, "data.json");
  // Ordinary components with many attributes, handlers and separators pass.
  const ok = await compile(`// ${"-".repeat(120)}
export default () => <svg>${'<path d="M0 0" fill="red" stroke="blue" />'.repeat(800)}</svg>;`);
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
});

test("a runtime page is limited in source files and size", async () => {
  const many: Record<string, string> = { "index.html": componentShell("App", "App.jsx") };
  many["App.jsx"] = `${Array.from({ length: 32 }, (_, index) => `import { v${index} } from "./lib/m${index}.js";`).join("\n")}\nexport default () => v0;`;
  for (let index = 0; index < 32; index++) many[`lib/m${index}.js`] = `export const v${index} = ${index};`;
  const tooMany = fixture(many);
  const result = await buildDerivative(tooMany.manifest, tooMany.bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /at most 32 source files/);
  const big = await compile(`export default () => ${JSON.stringify("x".repeat(2 * 1024 * 1024))};`);
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.reason, /exceed 2 MiB/);
});

test("files the page never loads are neither checked nor counted", async () => {
  const sources: Record<string, string> = {
    "index.html": componentShell("App", "App.jsx"),
    "App.jsx": 'import { label } from "./used.js";\nexport default () => <p>{label}</p>;',
    "used.js": 'export const label = "used";',
    // Would be refused if it were loaded: a computed import and a require alias.
    "unused.js": 'const x = "a"; export default () => import(`./${x}`);',
  };
  for (let index = 0; index < 40; index++) sources[`spare/m${index}.js`] = `export const v = ${index};`;
  const value = fixture(sources);
  const result = await buildDerivative(value.manifest, value.bytes);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} (${result.path})`);
  if (result.ok) {
    assert.ok(result.consumedPaths.includes("used.js"));
    assert.equal(result.consumedPaths.includes("unused.js"), false);
  }
  // Loaded, the same file is refused and named.
  const loaded = fixture({ ...sources, "App.jsx": 'import f from "./unused.js";\nexport default f;' });
  const refusal = await buildDerivative(loaded.manifest, loaded.bytes);
  assert.equal(refusal.ok, false);
  if (!refusal.ok) {
    assert.match(refusal.reason, /import\(\) must name a module with a plain string/);
    assert.equal(refusal.path, "unused.js");
  }
});

test("the build service admits a runtime page only when asked to", async () => {
  const value = component("export default () => null;");
  const result = await buildDerivative(value.manifest, value.bytes, { allowRuntime: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not admitted/);
});

test("require is usable only as a direct call with one plain string", async () => {
  const plain = /require must be called directly with one plain string/;
  for (const source of [
    'const x = "a"; export default () => module.require(`../${x}`);',
    'const x = "a"; export default () => module["require"]("../" + x);',
    'const x = "a"; export default () => module[`require`](x);',
    'const x = "a"; const r = require; export default () => r(x);',
    'const x = "a"; export default () => require.call(null, x);',
    'const x = "a"; export default () => (0, require)(x);',
    'const x = "a"; export default () => [require][0](x);',
    'export default () => typeof require;',
    'export default () => require("react", "x");',
  ])
    await refused(source, plain);
  // A plain require of an allowlisted library still compiles.
  const ok = await compile('const React = require("react");\nexport default () => React.version;');
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
  // An object key named require is not a reference.
  const key = await compile('const o = { require: 1 };\nexport default () => o.require;');
  assert.equal(key.ok, false);
  if (!key.ok) assert.match(key.reason, plain); // o.require is a member named require
  const literal = await compile('const o = { require: 1 };\nexport default () => o.value;');
  assert.equal(literal.ok, true, literal.ok ? "" : literal.reason);
});

test("sloppy-mode sources are checked too and unparsable ones are refused", async () => {
  const sloppy = (legacy: string) =>
    fixture({
      "index.html": componentShell("App", "App.jsx"),
      "App.jsx": 'import "./legacy.js";\nexport default () => <p>{String(globalThis.value)}</p>;',
      "legacy.js": legacy,
    });
  const leak = sloppy('var n = "package"; with (Math) { globalThis.value = require(`./${n}.json`); }');
  const refusedLeak = await buildDerivative(leak.manifest, leak.bytes);
  assert.equal(refusedLeak.ok, false);
  if (!refusedLeak.ok) {
    assert.match(refusedLeak.reason, /require must be called directly/);
    assert.equal(refusedLeak.path, "legacy.js");
  }
  const clean = sloppy("with (Math) { globalThis.value = max(1, 2); }");
  const built = await buildDerivative(clean.manifest, clean.bytes);
  assert.equal(built.ok, true, built.ok ? "" : built.reason);
  // JSX that only a module could hold, mixed with `with`, cannot be parsed
  // either way and is refused rather than allowed.
  await refused("with (Math) { var el = <p>{max(1, 2)}</p>; }", /compilation failed|could not be checked/);
});

test("keyword, statement and label nesting counts toward the pre-filter", async () => {
  const deep = /nests too deeply/;
  await refused(`export default () => ${"typeof ".repeat(1200)}1;`, deep);
  await refused(`export default () => ${"void ".repeat(1200)}1;`, deep);
  await refused(`let a; export function f() { ${"if (a) ".repeat(1200)}a++; }\nexport default () => null;`, deep);
  await refused(`let a; export function f() { ${"while (a) ".repeat(1200)}a++; }\nexport default () => null;`, deep);
  await refused(`export function f() { ${"x: ".repeat(1200)}return 1; }\nexport default () => null;`, deep);
  // Prose in JSX mentions these words often; tags keep the count local.
  const prose = Array.from({ length: 600 }, () => "<p>If you do this for a new user, wait while it loads.</p>").join("");
  const ok = await compile(`export default () => <main>${prose}</main>;`);
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
});

test("esbuild crash output stays out of the server logs", async () => {
  const { spawnSync } = await import("node:child_process");
  const wrapper = path.join(ROOT, "apps/server/esbuild-limited.sh");
  const run = spawnSync(wrapper, ["-c", "echo traceback >&2; echo protocol"], {
    env: { PATH: "/usr/bin:/bin", POLKA_ESBUILD_BINARY: "/bin/sh" },
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "protocol\n");
  assert.equal(run.stderr, "");
});

// Release review (22.09.2026): common chat HTML the runtime used to refuse
// or build into a page that fails at run time.
const CDN_HEAD = `<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>`;

async function page(html: string) {
  const value = fixture({ "index.html": html });
  return buildDerivative(value.manifest, value.bytes);
}

test("text/babel scripts share one module scope, in page order", async () => {
  const result = await page(`<!doctype html><html><head>${CDN_HEAD}</head><body><div id="root"></div>
<script type="text/babel">const Header = () => <h1>Hi</h1>;</script>
<script>window.plain = 1;</script>
<script type="text/babel">ReactDOM.createRoot(document.getElementById("root")).render(<Header/>);</script>
</body></html>`);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const html = result.html.toString("utf8");
  // One compiled script replaces both Babel scripts; the classic one stays,
  // after the environment prelude: three script elements in all.
  const parts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(parts.length, 3, parts.map((part) => part.slice(0, 40)).join(" | "));
  assert.match(parts[0], /localStorage/);
  assert.equal(parts[2], "window.plain = 1;");
  assert.doesNotMatch(html, /text\/babel/);
  assertSelfContained(html);
});

test("a refusal in an inline script names the page file and its line", async () => {
  const result = await page(`<!doctype html><html><head>${CDN_HEAD}</head><body>
<script type="text/babel">const A = 1;</script>
<script type="text/babel">
const B = 2;
const C = 1 +* 2;
</script></body></html>`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.path, "index.html");
  assert.match(result.reason, /\(index\.html:8\)$/);
  const module = await page(`<!doctype html><html><body>\n<script type="module">\nimport x from "left-pad";\n</script></body></html>`);
  assert.equal(module.ok, false);
  if (!module.ok) {
    assert.equal(module.path, "index.html");
    assert.match(module.reason, /module "left-pad" is not available/);
  }
});

test("ES imports from esm.sh, Skypack, jsDelivr and unpkg use the vendored libraries", async () => {
  const result = await compile(`import React, { useState } from "https://esm.sh/react@18.2.0";
import { createRoot } from "https://esm.sh/react-dom@18.2.0/client?deps=react@18.2.0";
import { Camera } from "https://cdn.skypack.dev/lucide-react@0.300.0";
import debounce from "https://cdn.jsdelivr.net/npm/lodash@4.17.21/debounce/+esm";
import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js?module";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";
export default () => <p>{typeof createRoot}{typeof debounce}{typeof OrbitControls}{THREE.REVISION}<Camera/>{String(useState)}</p>;`);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (result.ok) assert.doesNotMatch(result.html.toString("utf8"), /esm\.sh|skypack|jsdelivr|unpkg/);
  await refused(`import confetti from "https://esm.sh/canvas-confetti"; export default () => null;`, /needs the network/);
  await refused(`import x from "https://esm.sh/react@18/cjs/react.development.js"; export default () => null;`, /needs the network/);
});

test("three.js example scripts from a CDN become THREE members or refuse by name", async () => {
  const ok = await page(`<!doctype html><html><body>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script>const scene = new THREE.Scene(); window.hasControls = typeof THREE.OrbitControls;</script></body></html>`);
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
  if (ok.ok) assert.match(ok.html.toString("utf8"), /OrbitControls/);
  const missing = await page(`<!doctype html><html><body>
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>
<script src="https://unpkg.com/three@0.128.0/examples/js/NoSuchAddon.js"></script></body></html>`);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /three\.js example examples\/js\/NoSuchAddon\.js is not part of the runtime/);
});

test("an inline Tailwind v3 config is applied and v3 borders keep their gray", async () => {
  const result = await page(`<!doctype html><html><head>${CDN_HEAD}
<script>tailwind.config = { darkMode: "class", theme: { extend: { colors: { brand: { 500: "#123456" } }, fontFamily: { display: ["Inter", "sans-serif"] } } }, plugins: [window.x] };</script>
</head><body><div id="root" class="bg-brand-500 font-display dark:text-brand-500 border"></div>
<script type="text/babel">ReactDOM.createRoot(document.getElementById("root")).render(<p>x</p>);</script></body></html>`);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const html = result.html.toString("utf8");
  assert.match(html, /\.bg-brand-500\s*\{\s*background-color:\s*#123456/);
  assert.match(html, /font-family:\s*Inter,\s*sans-serif/);
  assert.match(html, /\.dark\\:text-brand-500:is\(\.dark \*\)/);
  assert.match(html, /border-color:\s*var\(--color-gray-200,\s*currentColor\)/);
  // The config script still runs against the prelude's tailwind object.
  assert.match(html, /tailwind\.config = \{/);
  assert.ok(result.warnings.some((warning) => warning.includes("tailwind.config")));
});

test("a failure of esbuild itself is retryable, not a refusal of the page", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(path.join(tmpdir(), "polka-esbuild-"));
  const broken = path.join(directory, "esbuild");
  writeFileSync(broken, "#!/bin/sh\nexit 97\n");
  chmodSync(broken, 0o755);
  const script = `
import { buildDerivative } from ${JSON.stringify(new URL("../apps/server/react-runtime.ts", import.meta.url).href)};
import { componentShell } from ${JSON.stringify(new URL("../packages/contracts/runtime.ts", import.meta.url).href)};
import { canonicalizeManifest } from ${JSON.stringify(new URL("../packages/contracts/bundle.ts", import.meta.url).href)};
import { createHash } from "node:crypto";
const files = new Map([["index.html", Buffer.from(componentShell("App", "App.jsx"))], ["App.jsx", Buffer.from("export default () => null;")]]);
const manifest = canonicalizeManifest({ version: 1, entrypoint: "index.html", runtime: "inline-live-experimental-v1",
  files: [...files].map(([path, value]) => ({ path, mime: path.endsWith(".html") ? "text/html" : "text/javascript", size: value.length, sha256: createHash("sha256").update(value).digest("hex") })),
  provenance: { kind: "mcp", sourceUrl: null, capturedAt: "2026-09-22T10:00:00Z", attribution: "Test", license: "unknown" },
  dependencies: { status: "self-contained", unresolved: [] } });
console.log(JSON.stringify(await buildDerivative(manifest, files)));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, ESBUILD_BINARY_PATH: broken },
  });
  const result = JSON.parse(child.stdout.trim().split("\n").at(-1) || "{}");
  assert.equal(result.ok, false, child.stderr);
  assert.equal(result.failed, true);
  assert.equal(result.category, "compiler");
});
