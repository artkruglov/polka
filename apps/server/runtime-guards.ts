import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseJs } from "acorn";
import { transform, type Loader } from "esbuild";

/**
 * Guards for the Полка runtime builder. esbuild reads the disk on the
 * server, so what it may read is fenced three ways: user code may only use
 * static string import specifiers (no import attributes, no computed
 * import()/require(), which esbuild would expand into disk globs), every
 * file esbuild loads must belong to an allowlisted library or a package that
 * library resolves to, and the finished metafile is checked again.
 * Oversized or deeply nested sources are refused before esbuild parses them.
 */

export const MAX_RUNTIME_MODULES = 32;
export const MAX_RUNTIME_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_NESTING = 500;
const MAX_CHAIN = 1000;
const MAX_UNARY_RUN = 1000;

const dependencyNames = (manifest: Record<string, unknown>) =>
  [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ].flatMap((field) =>
    Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
  );

/**
 * Real directories of the allowlisted packages and every package they
 * resolve to, following Node's node_modules lookup from each package
 * directory and never above root.
 */
export function allowedPackageDirs(root: string, names: readonly string[]) {
  const top = realpathSync(root);
  const found = new Set<string>();
  const queue: string[] = [];
  const add = (directory: string) => {
    const real = realpathSync(directory);
    if (!real.startsWith(top + path.sep) || found.has(real)) return;
    found.add(real);
    queue.push(real);
  };
  for (const name of names) add(path.join(top, "node_modules", name));
  while (queue.length) {
    const directory = queue.shift()!;
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const dependency of dependencyNames(manifest)) {
      for (
        let current = directory;
        current.startsWith(top);
        current = path.dirname(current)
      ) {
        if (path.basename(current) === "node_modules") continue;
        const candidate = path.join(current, "node_modules", dependency);
        if (existsSync(path.join(candidate, "package.json"))) {
          add(candidate);
          break;
        }
        if (current === top) break;
      }
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** True when a file esbuild wants to load lies inside an allowed package. */
export function isAllowedLibraryFile(file: string, allowed: string[]) {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  // Longest match first: a nested package is judged by its own directory.
  const owner = allowed.find((directory) =>
    real.startsWith(directory + path.sep),
  );
  if (!owner) return false;
  return !real
    .slice(owner.length + 1)
    .split(path.sep)
    .includes("node_modules");
}

function nextVisible(source: string, from: number) {
  for (let index = from; index < source.length; index++)
    if (!" \t\n\r".includes(source[index])) return source[index];
  return "";
}

/**
 * A cheap linear bound on how deeply a source nests before esbuild parses
 * it recursively: brackets and JSX elements, chains of right-nesting
 * operators within one statement, and runs of prefix operators. It cannot
 * see strings or comments, so it is a first filter; the hard memory limit
 * on the esbuild process is what bounds a crafted input.
 */
export function withinNestingLimits(source: string) {
  let brackets = 0;
  let elements = 0;
  let chain = 0;
  let unary = 0;
  let previous = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r")
      continue;
    const next = source[index + 1] ?? "";
    if (char === "(" || char === "[" || char === "{") {
      if (++brackets > MAX_NESTING) return false;
      if (char === "{") chain = 0;
    } else if (char === ")" || char === "]" || char === "}") {
      brackets = Math.max(0, brackets - 1);
      if (char === "}") chain = 0;
    } else if (char === ";") chain = 0;
    else if (char === "<") {
      if (next === "/") elements = Math.max(0, elements - 1);
      else if (
        /[A-Za-z>]/.test(next) &&
        (previous === "" || ">({[,?:=&|;".includes(previous))
      ) {
        if (++elements > MAX_NESTING) return false;
      }
    } else if (char === "/" && next === ">") {
      elements = Math.max(0, elements - 1);
    }
    if (
      char === "?" ||
      (char === "=" &&
        next !== "=" &&
        !"=!<>".includes(previous) &&
        // A JSX attribute value is not an assignment.
        !`"'{`.includes(nextVisible(source, index + 1))) ||
      (char === "*" && next === "*")
    ) {
      if (++chain > MAX_CHAIN) return false;
    }
    if ("-+!~".includes(char)) {
      if (++unary > MAX_UNARY_RUN) return false;
    } else unary = 0;
    previous = char;
  }
  return true;
}

const staticSpecifier = (node: any) =>
  (node?.type === "Literal" && typeof node.value === "string") ||
  (node?.type === "TemplateLiteral" && node.expressions.length === 0);

const isRequire = (callee: any) =>
  (callee?.type === "Identifier" && callee.name === "require") ||
  (callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "require");

/**
 * Refuses import attributes and any import()/require() whose specifier is
 * not a plain string. Returns the reason, or null when the module is fine.
 * The source is first reduced to JavaScript by esbuild's transform (which
 * reads no files), then walked iteratively.
 */
export async function staticImportsOnly(source: string, loader: Loader) {
  if (loader === "css" || loader === "json") return null;
  let code: string;
  try {
    code = (
      await transform(source, {
        loader,
        jsx: "automatic",
        format: "esm",
        target: "esnext",
        tsconfigRaw: "{}",
        logLevel: "silent",
      })
    ).code;
  } catch {
    // The bundle step reports the syntax error with its location.
    return null;
  }
  let program: any;
  try {
    program = parseJs(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    return "source could not be checked for imports";
  }
  const stack: any[] = [program];
  while (stack.length) {
    const node = stack.pop();
    switch (node.type) {
      case "ImportExpression":
        if (node.options) return "import attributes (with {...}) are not allowed";
        if (!staticSpecifier(node.source))
          return "import() must name a module with a plain string";
        break;
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.attributes?.length)
          return "import attributes (with {...}) are not allowed";
        break;
      case "CallExpression":
        if (
          isRequire(node.callee) &&
          (node.arguments.length !== 1 || !staticSpecifier(node.arguments[0]))
        )
          return "require() must name a module with a plain string";
        break;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value)
          if (item && typeof item.type === "string") stack.push(item);
      } else if (value && typeof value.type === "string") stack.push(value);
    }
  }
  return null;
}
