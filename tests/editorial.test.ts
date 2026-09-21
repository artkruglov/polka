import assert from "node:assert/strict";
import test from "node:test";
import {
  editorialPublicationManifestSchema,
  toEditorialPublicMetadata,
  validateEditorialPublication,
} from "../packages/editorial.ts";

const sourceSha = "a".repeat(64);
const manifestSha = "b".repeat(64);
const derivativeSha = "c".repeat(64);
const ids = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  artifactId: "00000000-0000-4000-8000-000000000002",
  revisionId: "00000000-0000-4000-8000-000000000003",
  shareId: "00000000-0000-4000-8000-000000000004",
  derivativeId: "00000000-0000-4000-8000-000000000005",
};

function valid(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    public: {
      slug: "fractions",
      title: "Доли на практике",
      topic: "Обучение",
      task: "Разобраться с долями на коротких примерах.",
      action: "Ответить на пять вопросов и прочитать объяснение.",
      author: "Редакция Полки",
      license: "Apache-2.0",
      notices: "Оригинальный синтетический материал редакции.",
    },
    source: {
      path: "content/editorial/fractions/index.html",
      commit: "d".repeat(40),
      sha256: sourceSha,
    },
    runtimeProof: {
      originalRevisionId: ids.revisionId,
      originalSha256: sourceSha,
      originalManifestSha256: manifestSha,
      derivative: {
        id: ids.derivativeId,
        sha256: derivativeSha,
        runtimeProfile: "bundle-inline-experimental-v1",
        builderVersion: "bundle-inline-v2",
      },
      checkedAt: "2026-09-21T12:30:00+03:00",
      evidencePath: "docs/reviews/2026-09-21-editorial-runtime/results.json",
    },
    binding: {
      tenantId: ids.tenantId,
      artifactId: ids.artifactId,
      revisionId: ids.revisionId,
      shareId: ids.shareId,
      sourceSha256: sourceSha,
      manifestSha256: manifestSha,
      derivativeId: ids.derivativeId,
      derivativeSha256: derivativeSha,
      builderVersion: "bundle-inline-v2",
      runtimeProfile: "bundle-inline-experimental-v1",
    },
    ...overrides,
  };
}

test("accepts a complete immutable publication and exposes only explicit public metadata", () => {
  const parsed = validateEditorialPublication(valid());
  assert.equal(parsed.public.slug, "fractions");
  assert.deepEqual(toEditorialPublicMetadata(parsed), parsed.public);
  assert.equal("artifactId" in toEditorialPublicMetadata(parsed), false);
});

test("rejects unknown fields and missing explicit public recipient URL", () => {
  assert.equal(editorialPublicationManifestSchema.safeParse({ ...valid(), extra: true }).success, false);
  const value = valid();
  (value.public as Record<string, unknown>).recipientUrl = "https://viewer.example.test/s#opaque-token";
  assert.equal(editorialPublicationManifestSchema.safeParse(value).success, false);
});

test("rejects source path traversal, bad commit and non-HTTPS-or-HTTP recipient URL", () => {
  const pathCase = valid();
  pathCase.source.path = "../outside/index.html";
  assert.equal(editorialPublicationManifestSchema.safeParse(pathCase).success, false);
  const commitCase = valid();
  commitCase.source.commit = "not-a-commit";
  assert.equal(editorialPublicationManifestSchema.safeParse(commitCase).success, false);
  const nullCommit: any = valid();
  nullCommit.source.commit = null;
  assert.equal(editorialPublicationManifestSchema.safeParse(nullCommit).success, true);
});

test("rejects source, binding and runtime hash mismatches", () => {
  const sourceCase = valid();
  sourceCase.source.sha256 = "e".repeat(64);
  assert.equal(editorialPublicationManifestSchema.safeParse(sourceCase).success, false);
  const bindingCase = valid();
  bindingCase.binding.sourceSha256 = "e".repeat(64);
  assert.equal(editorialPublicationManifestSchema.safeParse(bindingCase).success, false);
  const runtimeCase = valid();
  runtimeCase.binding.derivativeId = "00000000-0000-4000-8000-000000000006";
  assert.equal(editorialPublicationManifestSchema.safeParse(runtimeCase).success, false);
});

test("requires complete derivative binding when a bundle proof is present", () => {
  const missing: any = valid();
  missing.binding.runtimeProfile = null;
  assert.equal(editorialPublicationManifestSchema.safeParse(missing).success, false);
  const single: any = valid();
  single.runtimeProof.derivative = null;
  single.binding.manifestSha256 = manifestSha;
  single.binding.derivativeId = null;
  single.binding.derivativeSha256 = null;
  single.binding.builderVersion = null;
  single.binding.runtimeProfile = null;
  assert.equal(editorialPublicationManifestSchema.safeParse(single).success, true);
});

test("keeps source/runtime proof and public metadata separate", () => {
  const parsed = validateEditorialPublication(valid());
  assert.equal("source" in parsed.public, false);
  assert.equal("runtimeProof" in parsed.public, false);
  assert.equal("binding" in parsed.public, false);
});
