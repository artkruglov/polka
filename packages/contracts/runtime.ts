/**
 * The Полка runtime (react-runtime-v1): what a chat artifact written as React
 * or module JavaScript may import. The derivative builder resolves exactly
 * these bare specifiers to libraries vendored in Полка's own node_modules and
 * compiles the page into one self-contained HTML; any other import refuses
 * the build and names the module.
 *
 * No manifest schema change is needed: the entrypoint stays text/html, and
 * component sources are ordinary bundle files (mime text/javascript) whose
 * extension picks the syntax (.js/.mjs/.jsx: JavaScript with JSX, .ts, .tsx).
 */
export const RUNTIME_LIBRARIES = [
  {
    name: "react",
    version: "19.3.0",
    license: "MIT",
    imports: ["react", "react/jsx-runtime"],
    global: "React",
    cdnNames: ["react"],
  },
  {
    name: "react-dom",
    version: "19.3.0",
    license: "MIT",
    imports: ["react-dom", "react-dom/client"],
    global: "ReactDOM",
    cdnNames: ["react-dom"],
  },
  {
    name: "lucide-react",
    version: "1.45.0",
    license: "ISC",
    imports: ["lucide-react"],
    global: "LucideReact",
    cdnNames: ["lucide-react"],
  },
  {
    name: "recharts",
    version: "3.10.1",
    license: "MIT",
    imports: ["recharts"],
    global: "Recharts",
    cdnNames: ["recharts"],
  },
  {
    name: "lodash",
    version: "4.18.1",
    license: "MIT",
    imports: ["lodash", "lodash/*"],
    global: "_",
    cdnNames: ["lodash", "lodash.js"],
  },
  {
    name: "d3",
    version: "7.9.0",
    license: "ISC",
    imports: ["d3"],
    global: "d3",
    cdnNames: ["d3"],
  },
  {
    name: "three",
    version: "0.186.0",
    license: "MIT",
    imports: ["three", "three/addons/*", "three/examples/jsm/*"],
    global: "THREE",
    cdnNames: ["three", "three.js"],
  },
  {
    name: "papaparse",
    version: "5.7.0",
    license: "MIT",
    imports: ["papaparse"],
    global: "Papa",
    cdnNames: ["papaparse", "PapaParse"],
  },
  {
    name: "mathjs",
    version: "15.2.0",
    license: "Apache-2.0",
    imports: ["mathjs"],
    global: "math",
    cdnNames: ["mathjs"],
  },
  {
    name: "chart.js",
    version: "4.5.1",
    license: "MIT",
    imports: ["chart.js", "chart.js/auto", "chart.js/helpers"],
    global: "Chart",
    cdnNames: ["chart.js", "Chart.js"],
  },
] as const;

export type RuntimeLibrary = (typeof RUNTIME_LIBRARIES)[number];

/** The library a bare specifier belongs to, or null when it is not allowed. */
export function runtimeLibraryFor(specifier: string): RuntimeLibrary | null {
  for (const library of RUNTIME_LIBRARIES)
    for (const pattern of library.imports as readonly string[]) {
      if (pattern === specifier) return library;
      if (
        pattern.endsWith("/*") &&
        specifier.startsWith(pattern.slice(0, -1)) &&
        specifier.length > pattern.length - 1 &&
        /^[A-Za-z0-9_./-]+$/.test(specifier) &&
        !specifier.split("/").some((part) => part === ".." || part === ".")
      )
        return library;
    }
  return null;
}

/** Human list for guidance and refusals: `react, react-dom/client, ...`. */
export const RUNTIME_IMPORT_LIST = RUNTIME_LIBRARIES.flatMap(
  (library) => library.imports as readonly string[],
).join(", ");

/** Short list for build refusals, which are stored up to 300 characters. */
export const RUNTIME_LIBRARY_NAMES = RUNTIME_LIBRARIES.map(
  (library) => library.name,
).join(", ");

/** Source file extensions the runtime compiles, with their syntax. */
export const RUNTIME_MODULE_LOADERS = {
  ".js": "jsx",
  ".mjs": "jsx",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
} as const;

/**
 * A page published as a component gets this meta tag: Tailwind's base reset
 * (preflight) is added, as in the chat artifact environment. Pages without it
 * get Tailwind utilities for the classes they use but keep their own base.
 */
export const RUNTIME_TAILWIND_META = "polka-tailwind" as const;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

/**
 * The HTML entrypoint Полка stores next to a component published as source:
 * a root element and one module script. The component's default export is
 * rendered into #root by the runtime; the static view shows no content.
 * html, body and #root fill the viewport, as in a Vite or CRA template: an
 * app whose root is height:100% would otherwise collapse to nothing.
 */
export function componentShell(title: string, file: string) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="${RUNTIME_TAILWIND_META}" content="preflight">
<title>${escapeHtml(title)}</title>
<style>html,body,#root{height:100%}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="${escapeHtml(file)}"></script>
</body>
</html>
`;
}
