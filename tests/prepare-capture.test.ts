import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareCapture } from "../scripts/prepare-capture.ts";

test("prepares only selected files and preserves binary bytes without claiming autonomy", async () => {
  const root = "tests/fixtures/bundle-corpus/team-report";
  const selected = [
    "index.html",
    "assets/report.js",
    "assets/report.css",
    "assets/mark.svg",
  ];
  const result = await prepareCapture(root, "index.html", selected);
  assert.equal(result.manifest.dependencies.status, "unknown");
  for (const f of result.files)
    assert.deepEqual(
      Buffer.from(f.data, "base64"),
      await readFile(path.join(root, f.path)),
    );
  assert.equal(result.files.length, 4);
});

test("rejects path escape, duplicate names and symlinks without reading their contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "polka-capture-"));
  try {
    await writeFile(path.join(root, "index.html"), "<h1>Example</h1>");
    await symlink("index.html", path.join(root, "link.html"));
    await assert.rejects(prepareCapture(root, "index.html", ["../index.html"]));
    await assert.rejects(
      prepareCapture(root, "index.html", ["index.html", "index.html"]),
    );
    await assert.rejects(prepareCapture(root, "link.html", ["link.html"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
