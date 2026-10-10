/**
 * Frontend layer gate for apps/web/src, run by `npm run check:layers` (part of `npm run check`).
 *
 * The layers, from lowest to highest: shared → entities → features → widgets → pages → app.
 * A layer is the first directory under apps/web/src; a slice is the directory inside a layer
 * (features/comments, pages/bring, …).
 *
 * Rules:
 * 1. Every module (.ts, .tsx, .js, .jsx, .mjs) under apps/web/src belongs to a layer. Only the
 *    mount and dev entries (main.tsx, component-catalog-entry.tsx) and vite-env.d.ts live at the root.
 * 2. Imports point down: a module may import from its own layer or a lower one, never a higher one.
 * 3. Slices of one layer do not import each other. shared and app are the exception: any part of
 *    them may import any other part of the same layer.
 * 4. From outside apps/web/src only packages/contracts, packages/editorial.ts and the Markdown
 *    texts in docs/legal (imported with `?raw`) are allowed.
 * 5. Package imports (`react`, `zod`, …) are allowed; absolute (`/src/…`), `node:` and `#` paths are not.
 * 6. Module paths are string literals, so the gate can resolve them; a computed path fails.
 * 7. A module that does not parse fails.
 *
 * Every kind of reference counts: import and export … from, import(), import type,
 * TypeScript `import("…").T`, require() and `import x = require()`. Modules are parsed with
 * rolldown's parser, so comments and strings that merely look like imports are ignored.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils";

const LAYERS = ["shared", "entities", "features", "widgets", "pages", "app"];
/** Layers whose slices may import each other. */
const LAYERS_WITHOUT_SLICE_ISOLATION = ["shared", "app"];
/** Root files of apps/web/src allowed outside the layers (relative to the root). */
const ROOT_FILES_OUTSIDE_LAYERS = ["main.tsx", "component-catalog-entry.tsx", "vite-env.d.ts"];
const MODULE_FILE = /\.(tsx?|mjs|jsx?)$/;
const DEPENDENCY_DECLARATIONS = [
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
];
const SKIPPED_AST_KEYS = ["comments", "tokens"];

/** A loosely typed ESTree node: the walker only reads `type` and a few known fields. */
type AstNode = { type?: string; [key: string]: unknown };

interface Location {
  /** First directory under the root, e.g. "features". */
  layer: string;
  /** Second path segment, e.g. "comments" in features/comments/index.tsx. */
  slice: string;
}

/** Whether `file` is `parent` itself or lies somewhere inside it. */
function isInside(parent: string, file: string): boolean {
  const path = relative(parent, file);
  if (path === "") return true;
  return !path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep);
}

function locate(root: string, file: string): Location {
  const [layer, slice] = relative(root, file).split(sep);
  return { layer, slice };
}

function isLayer(name: string): boolean {
  return LAYERS.includes(name);
}

/** The module path written in a source node, or null when it is computed at runtime. */
function literalSpecifier(node: AstNode | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral") {
    const template = node as AstNode & { expressions: unknown[]; quasis: { value: { cooked: string } }[] };
    if (template.expressions.length === 0) return template.quasis[0].value.cooked;
  }
  return null;
}

/** Package imports are fine; paths that bypass relative resolution are not. */
function isUnsupportedBareSpecifier(specifier: string): boolean {
  return specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("#");
}

/** Rule 4: the few files outside apps/web/src that the frontend may import. */
function isAllowedOutsideFrontend(root: string, target: string, specifier: string): boolean {
  const repository = resolve(root, "../../..");
  const contracts = resolve(repository, "packages/contracts");
  const editorial = resolve(repository, "packages/editorial.ts");
  const legal = resolve(repository, "docs/legal");
  // Legal texts are reviewed as Markdown in docs/legal and bundled as raw strings.
  const isLegalText = isInside(legal, target) && target.endsWith(".md") && specifier.endsWith("?raw");
  return isInside(contracts, target) || target === editorial || isLegalText;
}

/** Rules 2 and 3: the target must be in a lower layer, or in the same slice of the same layer. */
function isAllowedLayerDependency(from: Location, to: Location): boolean {
  if (!isLayer(to.layer)) return false;
  if (LAYERS.indexOf(to.layer) > LAYERS.indexOf(from.layer)) return false;
  const sameLayer = to.layer === from.layer;
  if (sameLayer && !LAYERS_WITHOUT_SLICE_ISOLATION.includes(to.layer) && to.slice !== from.slice) return false;
  return true;
}

/** What is wrong with one module path (a message without the file prefix), or null. */
function dependencyProblem(root: string, file: string, sourceNode: AstNode | undefined): string | null {
  const specifier = literalSpecifier(sourceNode);
  if (specifier === null) return "Computed module path cannot be checked; use literal imports";
  if (!specifier.startsWith(".")) {
    return isUnsupportedBareSpecifier(specifier) ? `Unsupported module path ${specifier}` : null;
  }
  const pathWithoutQuery = specifier.split(/[?#]/)[0];
  const target = resolve(dirname(file), pathWithoutQuery);
  if (!isInside(root, target)) {
    return isAllowedOutsideFrontend(root, target, specifier) ? null : `Outside frontend contracts: ${specifier}`;
  }
  if (isAllowedLayerDependency(locate(root, file), locate(root, target))) return null;
  return `Invalid dependency → ${relative(root, target)}`;
}

function isRequireCall(node: AstNode): boolean {
  const callee = node.callee as AstNode | undefined;
  return node.type === "CallExpression" && callee?.type === "Identifier" && callee.name === "require";
}

/** A module reference found in the tree; `source` is the node holding its path, if there is one. */
interface ModuleReference {
  source: AstNode | undefined;
}

/** The module reference that `node` is, or null when it is not one. */
function asModuleReference(node: AstNode): ModuleReference | null {
  if (DEPENDENCY_DECLARATIONS.includes(node.type ?? "") && node.source) return { source: node.source as AstNode };
  if (node.type === "TSImportType") return { source: node.argument as AstNode | undefined };
  if (node.type === "TSExternalModuleReference") return { source: node.expression as AstNode | undefined };
  if (isRequireCall(node)) return { source: (node.arguments as AstNode[])[0] };
  return null;
}

/** Calls `onReference` for every module reference in the tree, in source order. */
function visitModuleReferences(node: unknown, onReference: (reference: ModuleReference) => void): void {
  if (!node || typeof node !== "object") return;
  const astNode = node as AstNode;
  const reference = asModuleReference(astNode);
  if (reference) onReference(reference);
  for (const [key, value] of Object.entries(astNode)) {
    if (SKIPPED_AST_KEYS.includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => visitModuleReferences(child, onReference));
    else if (value && typeof value === "object") visitModuleReferences(value, onReference);
  }
}

/** Checks one module of the frontend. Returns failures as "path/in/src: message". */
export function checkSource(file: string, source: string, root: string): string[] {
  if (!isLayer(locate(root, file).layer)) return [];
  const failures: string[] = [];
  const fail = (message: string) => failures.push(`${relative(root, file)}: ${message}`);

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(file, source);
  } catch {
    fail("Cannot parse module");
    return failures;
  }
  if (parsed.errors.length) {
    fail("Invalid module syntax");
    return failures;
  }

  visitModuleReferences(parsed.program, (reference) => {
    const problem = dependencyProblem(root, file, reference.source);
    if (problem) fail(problem);
  });
  return failures;
}

/** Checks every module under `root`; `checked` counts the modules that belong to a layer. */
export function checkTree(root: string): { checked: number; failures: string[] } {
  let checked = 0;
  const failures: string[] = [];

  function checkFile(file: string) {
    const path = relative(root, file);
    if (isLayer(path.split(sep)[0])) {
      checked++;
      failures.push(...checkSource(file, readFileSync(file, "utf8"), root));
    } else if (!ROOT_FILES_OUTSIDE_LAYERS.includes(path)) {
      failures.push(`${path}: Module must belong to a frontend layer`);
    }
  }

  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (MODULE_FILE.test(entry.name)) checkFile(path);
    }
  }

  walk(root);
  return { checked, failures };
}

function main() {
  const { checked, failures } = checkTree(resolve("apps/web/src"));
  if (failures.length) {
    console.error("Invalid frontend layer dependencies:\n" + failures.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Frontend layers: ${checked} migrated modules checked (syntax, static/dynamic/type imports). Only mount/dev entries and Vite declarations are allowed outside layers.`,
  );
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isRunDirectly) main();
