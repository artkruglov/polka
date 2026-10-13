// The first chunk every page loads (the landing, a recipient's link, the
// feed) holds the router and the account check only: zod, the workspace and
// its dialogs, the comments rail and the page stylesheets come with the lazy
// chunks that use them (apps/web/src/app/routing/lazy-pages.tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import { relative } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Rollup } from "vite";

type Output = Rollup.OutputChunk | Rollup.OutputAsset;

const built = (async () => {
  const result = await build({
    configFile: "apps/web/vite.config.ts",
    logLevel: "silent",
    build: { write: false },
  });
  return (Array.isArray(result) ? result : [result]).flatMap(
    (item) => (item as Rollup.RollupOutput).output as Output[],
  );
})();

const source = (id: string) => relative(process.cwd(), id).replaceAll("\\", "/");

test("the entry chunk keeps zod, the workspace and its features out", { timeout: 120_000 }, async () => {
  const output = await built;
  const entry = output.find((item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry);
  assert.ok(entry, "an entry chunk");
  const modules = Object.keys(entry.modules).map(source);
  const forbidden = [
    /node_modules\/zod\//,
    /^packages\/contracts\/(index|webhooks|comments)\.ts$/,
    /^packages\/editorial\.ts$/,
    /^apps\/web\/src\/app\/workspace\/index\.tsx$/,
    /^apps\/web\/src\/pages\/(?!.*\.css$)/,
    /^apps\/web\/src\/features\/(?!upload-artifact\/styles\.css$)/,
    /^apps\/web\/src\/widgets\/(comments|artifact-reader|shelf-card|trash)\/(?!.*\.css$)/,
    /^apps\/web\/src\/widgets\/artifact-preview\/.*\.tsx$/,
  ];
  const leaks = modules.filter((id) => forbidden.some((pattern) => pattern.test(id)));
  assert.deepEqual(leaks, [], `modules that belong in lazy chunks: ${leaks.join(", ")}`);
  // 551 kB / 167 kB gzip before the split (13.10.2026); about 243 / 77 after.
  const gzip = gzipSync(entry.code).length;
  assert.ok(gzip < 95_000, `entry chunk is ${gzip} bytes gzipped`);
});

test("the global stylesheet holds the shared layer, not page styles", { timeout: 120_000 }, async () => {
  const output = await built;
  const entry = output.find((item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry)!;
  const css = [...(entry.viteMetadata?.importedCss ?? [])];
  assert.equal(css.length, 1, "one global stylesheet");
  const sheet = output.find((item) => item.fileName === css[0]) as Rollup.OutputAsset;
  const text = String(sheet.source);
  for (const pageOnly of [
    ".agent-connections",
    ".agent-hero",
    ".first-run",
    ".trash-panel",
    ".editorial-catalog",
    ".webhooks-",
  ])
    assert.ok(!text.includes(pageOnly), `${pageOnly} is in the global stylesheet`);
  // 120 kB before (13.10.2026).
  assert.ok(text.length < 60_000, `global stylesheet is ${text.length} bytes`);
});

test("pages that Node tests import get their stylesheets from the route chunk", async () => {
  const output = await built;
  for (const name of ["styled-agents", "styled-claim"]) {
    const chunk = output.find(
      (item): item is Rollup.OutputChunk => item.type === "chunk" && item.fileName.includes(`/${name}-`),
    );
    assert.ok(chunk, `${name} is its own chunk`);
    assert.ok((chunk.viteMetadata?.importedCss.size ?? 0) > 0, `${name} brings its stylesheet`);
  }
});
