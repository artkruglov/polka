import { test } from "node:test";
import assert from "node:assert/strict";
import type { Revision } from "../packages/contracts/index.ts";
import {
  liveKind,
  nextLiveStep,
} from "../apps/web/src/widgets/artifact-preview/live-plan.ts";

const page = (overrides: Partial<Revision>): Revision => ({
  id: "00000000-0000-4000-8000-000000000001",
  number: 1,
  filename: "index.html",
  mime: "text/html",
  size: 10,
  sha256: "0".repeat(64),
  storageKind: "single",
  totalSize: 10,
  htmlProfile: "static",
  inlineBuild: null,
  createdAt: "2026-09-22T10:00:00Z",
  ...overrides,
});

const singleFile = {
  version: 1,
  entrypoint: "index.html",
  files: [{ path: "index.html" }],
} as unknown as Revision["manifest"];

test("a script-free page gets no interactive controls", () => {
  assert.equal(liveKind(page({})), "none");
  assert.equal(
    liveKind(page({ storageKind: "bundle", manifest: singleFile })),
    "none",
  );
  assert.equal(liveKind(page({ mime: "image/png", htmlProfile: null })), "none");
});

test("scripted pages run directly or after a build", () => {
  assert.equal(liveKind(page({ htmlProfile: "limited" })), "direct");
  assert.equal(liveKind(page({ htmlProfile: "unsupported" })), "direct");
  for (const htmlProfile of ["limited", "unsupported"] as const)
    assert.equal(
      liveKind(page({ storageKind: "bundle", manifest: singleFile, htmlProfile })),
      "build",
    );
  const multi = {
    ...singleFile,
    files: [{ path: "index.html" }, { path: "app.css" }],
  } as unknown as Revision["manifest"];
  assert.equal(
    liveKind(page({ storageKind: "bundle", manifest: multi })),
    "build",
  );
});

const base = {
  capability: "production" as const,
  requiresBuild: false,
  build: null,
  owner: true,
  stopped: false,
  launched: false,
  prepared: false,
};

test("the interactive version opens by itself once", () => {
  assert.equal(nextLiveStep(base), "launch");
  assert.equal(nextLiveStep({ ...base, owner: false }), "launch");
  assert.equal(
    nextLiveStep({ ...base, requiresBuild: true, build: "ready" }),
    "launch",
  );
  assert.equal(nextLiveStep({ ...base, launched: true }), null);
  assert.equal(nextLiveStep({ ...base, stopped: true }), null);
  for (const capability of ["loading", "disabled", "error"] as const)
    assert.equal(nextLiveStep({ ...base, capability }), null);
});

test("only the owner's unprepared page is prepared without a click", () => {
  const needsBuild = { ...base, requiresBuild: true };
  assert.equal(nextLiveStep(needsBuild), "prepare");
  assert.equal(nextLiveStep({ ...needsBuild, owner: false }), null);
  assert.equal(nextLiveStep({ ...needsBuild, prepared: true }), null);
  for (const build of ["pending", "failed", "unsupported"] as const)
    assert.equal(nextLiveStep({ ...needsBuild, build }), null);
});
