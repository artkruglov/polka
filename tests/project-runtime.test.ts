// The check of a project's runtime pages after a save (apps/server/project-runtime.ts):
// a busy builder ends it at once instead of holding the agent's answer for
// every page, and «busy» is never reported as a page that does not build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { BundleManifest } from "../packages/contracts/bundle.ts";
import { BUILD_LIMITS } from "../apps/server/bundle-runtime-contract.ts";
import {
  RUNTIME_ADMISSION,
  SAVE_CHECK,
  admitInputs,
  checkProjectRuntimePages,
} from "../apps/server/project-runtime.ts";

const page = Buffer.from(
  `<!doctype html><html><head><script src="https://unpkg.com/react@18/umd/react.production.min.js"></script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script><script src="https://unpkg.com/@babel/standalone/babel.min.js"></script></head><body><div id="root"></div><script type="text/babel">ReactDOM.createRoot(document.getElementById("root")).render(<h1>Полка</h1>);</script></body></html>`,
);
const paths = ["a.html", "b.html", "c.html"];
const manifest = {
  version: 1,
  entrypoint: "a.html",
  runtime: "project-v1",
  files: paths.map((path) => ({
    path,
    mime: "text/html",
    size: page.length,
    sha256: createHash("sha256").update(page).digest("hex"),
  })),
  provenance: {
    kind: "file",
    sourceUrl: null,
    capturedAt: new Date().toISOString(),
    attribution: "unknown",
    license: "unknown",
  },
  dependencies: { status: "unknown", unresolved: [] },
} as unknown as BundleManifest;

test("a busy builder ends the save-time check after one wait and reports no page", async () => {
  const held = [];
  for (let i = 0; i < BUILD_LIMITS.workers; i++) held.push((await admitInputs(0))!);
  const wait = RUNTIME_ADMISSION.waitMs;
  RUNTIME_ADMISSION.waitMs = 200;
  const read: string[] = [];
  try {
    const started = Date.now();
    const problems = await checkProjectRuntimePages(randomUUID(), manifest, async (path) => {
      read.push(path);
      return page;
    });
    assert.deepEqual(problems, []);
    // One admission wait, not one per page.
    assert.deepEqual(read, ["a.html"]);
    assert.ok(Date.now() - started < 2_000, String(Date.now() - started));
  } finally {
    RUNTIME_ADMISSION.waitMs = wait;
    for (const release of held) release();
  }
});

test("the save-time check stops at its time budget", async () => {
  const budget = SAVE_CHECK.budgetMs;
  SAVE_CHECK.budgetMs = 0;
  const read: string[] = [];
  try {
    const problems = await checkProjectRuntimePages(randomUUID(), manifest, async (path) => {
      read.push(path);
      return page;
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(read, []);
  } finally {
    SAVE_CHECK.budgetMs = budget;
  }
});
