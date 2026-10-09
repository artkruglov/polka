// Every test file runs somewhere: in the default suite, the live suite, or a
// dedicated runner that needs its own infrastructure (database role grants,
// the URL-import runtime). A new file that nothing runs fails here instead of
// silently never running.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = (path: string): string[] => JSON.parse(read(path));

/** Runners with their own setup; each names the files it runs. */
const DEDICATED = [
  "scripts/test-runtime-grants-isolated.ts",
  "scripts/test-url-import-runtime.ts",
  "scripts/test-account-deletion-isolated.ts",
];

test("every tests/*.test.ts is run by a suite or a dedicated runner", () => {
  const files = readdirSync(new URL("./", import.meta.url))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `tests/${name}`);
  const suites = new Set([...manifest("tests/default-suite.json"), ...manifest("tests/live-suite.json")]);
  const runners = DEDICATED.map(read).join("\n");
  const orphans = files.filter((file) => !suites.has(file) && !runners.includes(file.slice("tests/".length)));
  assert.deepEqual(orphans, [], "add these to tests/default-suite.json, tests/live-suite.json or a dedicated runner");
  // And the manifests name only files that exist.
  for (const listed of suites) assert.ok(files.includes(listed), `${listed} is listed but missing`);
});
