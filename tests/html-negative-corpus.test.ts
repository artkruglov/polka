import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("./fixtures/html-negative-corpus/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as {
  schemaVersion: number;
  items: Array<{
    id: string;
    file: string;
    sha256: string;
    bytes: number;
    threat: string;
    expectedSandboxResult: string;
    origin: string;
    license: string;
    dependencies: string[];
    liveAcceptance: string;
  }>;
};

test("negative corpus manifest has nine unique bounded cases", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.items.length, 9);
  assert.equal(new Set(manifest.items.map((item) => item.id)).size, 9);
  assert.equal(new Set(manifest.items.map((item) => item.threat)).size, 9);
  assert.deepEqual(
    new Set(manifest.items.map((item) => item.threat)),
    new Set([
      "fetch egress",
      "image beacon",
      "parent DOM access",
      "top navigation",
      "popup",
      "storage access",
      "external script",
      "form submission",
      "self navigation",
    ]),
  );
});

test("negative corpus fixtures match manifest integrity and safety constraints", () => {
  for (const item of manifest.items) {
    assert.match(item.file, /^[a-z-]+\.html$/);
    const bytes = readFileSync(new URL(item.file, root));
    const html = bytes.toString("utf8");
    assert.equal(bytes.length, item.bytes, item.id);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.id);
    assert.ok(html.includes("<!doctype html>"), item.id);
    assert.equal(item.origin, "Original Polka synthetic test fixture", item.id);
    assert.equal(item.license, "Apache-2.0", item.id);
    assert.deepEqual(item.dependencies, [], item.id);
    assert.ok(item.expectedSandboxResult.length > 20, item.id);
    assert.equal(item.liveAcceptance, "not-tested", item.id);
    assert.doesNotMatch(html, /https?:\/\/(?![^\s"']+\.invalid\b)[^\s"']+/i, item.id);
    assert.doesNotMatch(html, /while\s*\(|for\s*\(\s*;\s*;/i, item.id);
    assert.doesNotMatch(html, /setInterval|setTimeout|Worker\s*\(/i, item.id);
  }
});
