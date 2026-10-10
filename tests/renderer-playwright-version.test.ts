import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The renderer image ships one Chromium build, and playwright-core launches
// only the build of its own version: a bot that moves one without the other
// leaves a renderer that restarts in a loop (0.14.0, Dependabot #49).
test("the renderer image and playwright-core are the same Playwright version", () => {
  const dockerfile = readFileSync("apps/renderer/Dockerfile", "utf8");
  const image = dockerfile.match(/^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/m)?.[1];
  assert.ok(image, "apps/renderer/Dockerfile starts FROM the official Playwright image");
  for (const file of ["package.json", "apps/renderer/package.json"]) {
    const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(file, "utf8"));
    const version = dependencies["playwright-core"] ?? devDependencies["playwright-core"];
    assert.equal(version, image, `${file}: playwright-core ${version}, the renderer image ${image}`);
  }
});
