import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseJs } from "acorn";
import { transform, type Loader } from "esbuild";
import { BUILD_LIMITS } from "./bundle-runtime-contract.ts";

/**
 * Guards for the Полка runtime builder. esbuild reads the disk on the
 * server, so what it may read is fenced three ways: user code may only use
 * static string import specifiers (no import attributes, no computed
 * import()/require(), which esbuild would expand into disk globs), every
 * file esbuild loads must belong to an allowlisted library or a package that
 * library resolves to, and the finished metafile is checked again.
 * Oversized or deeply nested sources are refused before esbuild parses them.
 */

const MAX_NESTING = BUILD_LIMITS.nesting;
const MAX_CHAIN = BUILD_LIMITS.chain;
const MAX_UNARY_RUN = BUILD_LIMITS.unaryRun;

const dependencyNames = (manifest: Record<string, unknown>) =>
  ["dependencies", "peerDependencies", "optionalDependencies"].flatMap(
    (field) =>
      Object.keys(
        (manifest[field] as Record<string, string> | undefined) ?? {},
      ),
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

// Words that make esbuild's parser recurse into what follows them.
const PREFIX_KEYWORDS = new Set([
  "typeof",
  "void",
  "delete",
  "new",
  "await",
  "yield",
  "if",
  "else",
  "while",
  "for",
  "do",
  "with",
]);

/**
 * An advisory, linear pre-filter on how deeply a source nests before
 * esbuild parses it recursively: brackets and JSX elements, chains of
 * right-nesting operators, prefix keywords and labels within one statement,
 * and runs of prefix operators. It cannot see strings or comments and a
 * crafted input can pass it (an else-if chain closes a block before each
 * else); the real bound is the hard memory limit of esbuild-limited.sh.
 */
export function withinNestingLimits(source: string) {
  let brackets = 0;
  let elements = 0;
  let chain = 0;
  let unary = 0;
  let keywords = 0;
  let previous = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r")
      continue;
    const next = source[index + 1] ?? "";
    if (/[A-Za-z_$]/.test(char) && !/[\w$]/.test(source[index - 1] ?? "")) {
      let end = index + 1;
      while (end < source.length && /[\w$]/.test(source[end])) end++;
      const word = source.slice(index, end);
      // Prose in JSX text is split by tags, which reset this count.
      if (PREFIX_KEYWORDS.has(word) && ++keywords > MAX_CHAIN) return false;
      // A label (`name:` right after a statement boundary or another label)
      // nests the next statement; object keys follow "," or "{".
      if (
        nextVisible(source, end) === ":" &&
        (previous === "" || ";}:".includes(previous)) &&
        ++keywords > MAX_CHAIN
      )
        return false;
      unary = 0;
      previous = source[end - 1];
      index = end - 1;
      continue;
    }
    if (";{}<>".includes(char)) keywords = 0;
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

const staticValue = (node: any) =>
  node?.type === "Literal"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? node.quasis[0].value.cooked
      : undefined;

/** `x.require`, `x["require"]` or `` x[`require`] ``. */
const namesRequire = (member: any) =>
  member.type === "MemberExpression" &&
  (member.computed
    ? staticValue(member.property) === "require"
    : member.property.type === "Identifier" &&
      member.property.name === "require");

/** The call `callee("plain string")` with nothing else. */
const plainCall = (call: any, callee: any) =>
  call?.type === "CallExpression" &&
  call.callee === callee &&
  call.arguments.length === 1 &&
  staticSpecifier(call.arguments[0]);

const PLAIN_REQUIRE = "require must be called directly with one plain string";

function parseEither(code: string) {
  const options = {
    ecmaVersion: "latest" as const,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  };
  try {
    return parseJs(code, {
      ...options,
      sourceType: "module",
      allowImportExportEverywhere: true,
    });
  } catch {
    // Sloppy-mode code (e.g. `with`) is valid only as a script; the
    // bundler compiles such a file as CommonJS, so it is checked too.
    return parseJs(code, { ...options, sourceType: "script" });
  }
}

/**
 * Refuses import attributes, any import() whose specifier is not a plain
 * string, and any use of `require` (or a member named require, such as
 * `module.require`) other than a direct call with one plain string. The
 * source is reduced to JavaScript by esbuild's transform with the loader
 * the bundler uses (it reads no files), parsed as a module or else as a
 * script, and walked iteratively. A source that cannot be transformed or
 * parsed is refused; a failure of esbuild itself is thrown.
 */
export async function staticImportsOnly(source: string, loader: Loader) {
  if (loader === "css" || loader === "json") return null;
  let code: string;
  try {
    code = (
      await transform(source, {
        loader,
        jsx: "automatic",
        target: "esnext",
        tsconfigRaw: "{}",
        logLevel: "silent",
      })
    ).code;
  } catch (error) {
    const errors = (
      error as {
        errors?: Array<{ text: string; location?: { line: number } | null }>;
      }
    ).errors;
    // No diagnostics means esbuild itself failed (stopped service, missing
    // binary, memory limit): not the page's fault, so the caller retries.
    if (!Array.isArray(errors)) throw error;
    const first = errors[0];
    return first
      ? `compilation failed: ${first.text.slice(0, 200)}${first.location ? ` (line ${first.location.line})` : ""}`
      : "compilation failed";
  }
  let program: any;
  try {
    program = parseEither(code);
  } catch {
    return "source could not be checked for imports";
  }
  const stack: Array<{ node: any; parent: any; key: string }> = [
    { node: program, parent: null, key: "" },
  ];
  while (stack.length) {
    const { node, parent, key } = stack.pop()!;
    switch (node.type) {
      case "ImportExpression":
        if (node.options)
          return "import attributes (with {...}) are not allowed";
        if (!staticSpecifier(node.source))
          return "import() must name a module with a plain string";
        break;
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.attributes?.length)
          return "import attributes (with {...}) are not allowed";
        break;
      case "MemberExpression":
        if (
          namesRequire(node) &&
          !(key === "callee" && plainCall(parent, node))
        )
          return PLAIN_REQUIRE;
        break;
      case "Identifier":
        if (node.name !== "require") break;
        // The property of `x.require` is judged with its member expression;
        // a plain object key is not a reference.
        if (
          key === "property" &&
          parent.type === "MemberExpression" &&
          !parent.computed
        )
          break;
        if (
          key === "key" &&
          ["Property", "PropertyDefinition", "MethodDefinition"].includes(
            parent.type,
          ) &&
          !parent.computed
        )
          break;
        if (key === "callee" && plainCall(parent, node)) break;
        return PLAIN_REQUIRE;
    }
    for (const child of Object.keys(node)) {
      const value = node[child];
      if (Array.isArray(value)) {
        for (const item of value)
          if (item && typeof item.type === "string")
            stack.push({ node: item, parent: node, key: child });
      } else if (value && typeof value.type === "string")
        stack.push({ node: value, parent: node, key: child });
    }
  }
  return null;
}
