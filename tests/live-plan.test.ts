import { test } from "node:test";
import assert from "node:assert/strict";
import type { Revision } from "../packages/contracts/index.ts";
import {
  liveKind,
  nextLiveSteps,
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

const buildState = (state: "ready" | "pending" | "failed" | "unsupported") => ({
  state,
  runtimeProfile: state === "ready" ? ("react-runtime-v1" as const) : null,
  reason: null,
  path: null,
});

test("scripted pages run directly or after a build", () => {
  assert.equal(liveKind(page({ htmlProfile: "limited" })), "direct");
  // A page the static view cannot show (CDN React/Babel/Tailwind) waits
  // for its build; the upload itself would not run offline.
  assert.equal(liveKind(page({ htmlProfile: "unsupported" })), "build");
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

test("a link recipient runs only the interactive version the link is bound to", () => {
  const limited = page({ htmlProfile: "limited" });
  assert.equal(liveKind(limited, true), "none");
  assert.equal(liveKind(page({ htmlProfile: "unsupported" }), true), "none");
  assert.equal(
    liveKind(
      {
        ...limited,
        inlineBuild: {
          state: "ready",
          runtimeProfile: "bundle-inline-experimental-v1",
          reason: null,
          path: null,
        },
      },
      true,
    ),
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
  assert.deepEqual(nextLiveSteps(base), ["launch"]);
  assert.deepEqual(nextLiveSteps({ ...base, owner: false }), ["launch"]);
  assert.deepEqual(
    nextLiveSteps({ ...base, requiresBuild: true, build: "ready" }),
    ["launch"],
  );
  assert.deepEqual(nextLiveSteps({ ...base, launched: true }), []);
  assert.deepEqual(nextLiveSteps({ ...base, stopped: true }), []);
  for (const capability of ["loading", "disabled", "error"] as const)
    assert.deepEqual(nextLiveSteps({ ...base, capability }), []);
});

test("only the owner's unprepared page is prepared without a click", () => {
  const needsBuild = { ...base, requiresBuild: true };
  assert.deepEqual(nextLiveSteps(needsBuild), ["prepare"]);
  assert.deepEqual(nextLiveSteps({ ...needsBuild, owner: false }), []);
  assert.deepEqual(nextLiveSteps({ ...needsBuild, prepared: true }), []);
  for (const build of ["pending", "failed", "unsupported"] as const)
    assert.deepEqual(nextLiveSteps({ ...needsBuild, build }), []);
});

test("a single page the static view cannot show runs and is built for its link", () => {
  const forLink = { ...base, buildForLink: true };
  assert.deepEqual(nextLiveSteps(forLink), ["launch", "prepare"]);
  assert.deepEqual(nextLiveSteps({ ...forLink, launched: true }), ["prepare"]);
  assert.deepEqual(nextLiveSteps({ ...forLink, build: "failed" }), ["launch"]);
  assert.deepEqual(nextLiveSteps({ ...forLink, owner: false }), ["launch"]);
});

test("the owner of a single upload sees the built version once it is ready", () => {
  for (const htmlProfile of ["limited", "unsupported"] as const) {
    assert.equal(liveKind(page({ htmlProfile, inlineBuild: buildState("ready") })), "build");
    // A refused build leaves the owner the upload as it is.
    assert.equal(liveKind(page({ htmlProfile, inlineBuild: buildState("unsupported") })), "direct");
    assert.equal(liveKind(page({ htmlProfile, inlineBuild: buildState("failed") })), "direct");
  }
  assert.equal(liveKind(page({ htmlProfile: "limited", inlineBuild: buildState("pending") })), "direct");
  assert.equal(liveKind(page({ htmlProfile: "unsupported", inlineBuild: buildState("pending") })), "build");
  assert.equal(liveKind(page({ inlineBuild: buildState("ready") })), "none");
});
