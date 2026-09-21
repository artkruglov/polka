import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BYTES } from "../packages/contracts/index.ts";
import {
  bundleManifestSchema,
  canonicalizeManifest,
  type BundleManifest,
} from "../packages/contracts/bundle.ts";

const file = (path: string, overrides: Record<string, unknown> = {}) => ({
  path,
  mime: "text/html",
  size: 1,
  sha256: "a".repeat(64),
  ...overrides,
}) as BundleManifest["files"][number];

const valid = (overrides: Record<string, unknown> = {}): BundleManifest => ({
  version: 1,
  entrypoint: "index.html",
  runtime: "static-sandbox-v1",
  files: [file("index.html")],
  provenance: {
    kind: "file",
    sourceUrl: null,
    capturedAt: "2026-09-20T10:20:30Z",
    attribution: "Original fixture",
    license: "Apache-2.0",
  },
  dependencies: { status: "self-contained", unresolved: [] },
  ...overrides,
});

test("canonicalizeManifest sorts files deterministically and preserves fixed field order", () => {
  const result = canonicalizeManifest(
    valid({
      files: [file("z.txt", { mime: "text/plain" }), file("index.html"), file("A.css", { mime: "text/css" })],
    }),
  );
  assert.deepEqual(result.files.map(({ path }) => path), ["A.css", "index.html", "z.txt"]);
  assert.deepEqual(Object.keys(result), ["version", "entrypoint", "runtime", "files", "provenance", "dependencies"]);
  assert.deepEqual(Object.keys(result.files[0]), ["path", "mime", "size", "sha256"]);
  assert.deepEqual(Object.keys(result.provenance), ["kind", "sourceUrl", "capturedAt", "attribution", "license"]);
  assert.deepEqual(Object.keys(result.dependencies), ["status", "unresolved"]);
  const reordered = canonicalizeManifest(valid({ files: [...result.files].reverse() }));
  assert.deepEqual(reordered, result);
  assert.equal(
    canonicalizeManifest(valid({ provenance: { ...valid().provenance, capturedAt: "2026-09-20T10:20:30+03:00" } })).provenance.capturedAt,
    "2026-09-20T10:20:30+03:00",
  );
});

test("rejects traversal, URL-like, encoded, query, fragment, backslash, and case-colliding paths", () => {
  for (const path of [
    "../index.html",
    "a/../../index.html",
    "/index.html",
    "https://evil.invalid/index.html",
    "C:index.html",
    "index%2ehtml",
    "index.html?x=1",
    "index.html#x",
    "index\\html",
    "index.html/",
    "Index.html",
  ]) {
    const candidate = path === "Index.html" ? valid({ files: [file("index.html"), file(path)] }) : valid({ entrypoint: path, files: [file(path)] });
    assert.equal(bundleManifestSchema.safeParse(candidate).success, false, path);
  }
});

test("enforces entrypoint, file, total, and dependency limits", () => {
  assert.equal(bundleManifestSchema.safeParse(valid({ entrypoint: "missing.html" })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html", { mime: "text/plain" })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html", { size: 0 })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html", { size: MAX_BYTES + 1 })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html", { size: 0 }), file("data.txt", { mime: "text/plain", size: 0 })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html"), ...Array.from({ length: 64 }, (_, i) => file(`data-${i}.txt`, { mime: "text/plain" }))] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html", { size: MAX_BYTES - 1 }), file("data.txt", { mime: "text/plain", size: 2 })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html", { sha256: "A".repeat(64) })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html"), file("a/b/c/d/e/f/g/h/i.txt", { mime: "text/plain" })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ files: [file("index.html"), file("data.txt.", { mime: "text/plain" })] })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ dependencies: { status: "self-contained", unresolved: ["x"] } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ dependencies: { status: "incomplete", unresolved: [] } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ dependencies: { status: "incomplete", unresolved: ["x"] } })).success, true);
});

test("rejects unknown fields and invalid provenance URLs/timestamps", () => {
  assert.equal(bundleManifestSchema.safeParse(valid({ extra: true })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, sourceUrl: "http://example.com" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, sourceUrl: "https://user:pass@example.com/a" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, sourceUrl: "https://example.com/a?token=secret" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, sourceUrl: "https://example.com/a#fragment" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, sourceUrl: "https://example.com\\evil" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, sourceUrl: "https://example.com/ a" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, capturedAt: "2026-09-20T10:20:30" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, capturedAt: "2026-02-30T10:20:30Z" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, capturedAt: "2026-09-20T25:20:30Z" } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, extra: true } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ dependencies: { status: "unknown", unresolved: [], extra: true } })).success, false);
  assert.equal(bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, license: "" } })).success, false);
});

test("rejects line terminators after path, hash, and RFC3339 values", () => {
  for (const suffix of ["\n", "\r", "\r\n"]) {
    const path = `index.html${suffix}`;
    assert.equal(
      bundleManifestSchema.safeParse(valid({ entrypoint: path, files: [file(path)] })).success,
      false,
      `path ${JSON.stringify(suffix)}`,
    );
    assert.equal(
      bundleManifestSchema.safeParse(valid({ files: [file("index.html", { sha256: `${"a".repeat(64)}${suffix}` })] })).success,
      false,
      `sha256 ${JSON.stringify(suffix)}`,
    );
    assert.equal(
      bundleManifestSchema.safeParse(valid({ provenance: { ...valid().provenance, capturedAt: `2026-09-20T10:20:30Z${suffix}` } })).success,
      false,
      `capturedAt ${JSON.stringify(suffix)}`,
    );
  }
});
