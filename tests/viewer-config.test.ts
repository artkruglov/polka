import test from "node:test";
import assert from "node:assert/strict";
import {
  isLiveRevisionEligible,
  parseViewerConfig,
  type ViewerConfigInput,
} from "../apps/server/viewer-config.ts";

const allowed = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const base: ViewerConfigInput = {
  APP_ORIGIN: "http://127.0.0.1:4390",
  VIEWER_ORIGIN: "http://localhost:4391",
  HOST: "127.0.0.1",
  PORT: 4390,
  VIEWER_HOST: "localhost",
  VIEWER_PORT: 4391,
  COOKIE_SECURE: "false",
};

const staging = (patch: Partial<ViewerConfigInput> = {}) =>
  parseViewerConfig({
    ...base,
    HTML_LIVE_MODE: "staging",
    APP_ORIGIN: "https://app.example.com",
    VIEWER_ORIGIN: "https://viewer.example.net",
    COOKIE_SECURE: "true",
    HTML_LIVE_STAGING_REVISION_IDS: allowed,
    ...patch,
  });

test("viewer mode defaults disabled and preserves the legacy local opt-in", () => {
  const disabled = parseViewerConfig(base);
  assert.equal(disabled.HTML_LIVE_MODE, "disabled");
  assert.equal(disabled.HTML_LIVE_ENABLED, false);

  const local = parseViewerConfig({ ...base, HTML_LIVE_ENABLED: "true" });
  assert.equal(local.HTML_LIVE_MODE, "local");
  assert.equal(local.HTML_LIVE_ENABLED, true);
  assert.equal(local.VIEWER_UPSTREAM_HOST, "localhost:4391");
  assert.equal(
    parseViewerConfig({
      ...base,
      HTML_LIVE_MODE: "local",
      VIEWER_ORIGIN: "http://localhost",
      VIEWER_PORT: 80,
    }).VIEWER_UPSTREAM_HOST,
    "localhost",
  );
  assert.throws(
    () =>
      parseViewerConfig({
        ...base,
        HTML_LIVE_MODE: "staging",
        HTML_LIVE_ENABLED: "true",
        HTML_LIVE_STAGING_REVISION_IDS: allowed,
      }),
    /conflicts/,
  );
  assert.throws(
    () =>
      staging({
        HTML_LIVE_ENABLED: "false",
      }),
    /conflicts/,
  );
  assert.throws(
    () =>
      parseViewerConfig({
        ...base,
        HTML_LIVE_MODE: "local",
        HTML_LIVE_ENABLED: "false",
      }),
    /conflicts/,
  );
});

test("local mode retains opposite loopback origins and matching public ports", () => {
  assert.throws(
    () =>
      parseViewerConfig({
        ...base,
        HTML_LIVE_MODE: "local",
        VIEWER_ORIGIN: "http://127.0.0.1:4391",
      }),
    /opposite loopback/,
  );
  assert.throws(
    () => parseViewerConfig({ ...base, HTML_LIVE_MODE: "local", PORT: 4400 }),
    /port must match/,
  );
});

test("staging requires canonical HTTPS origins on distinct PSL domains", () => {
  const result = staging();
  assert.equal(result.HTML_LIVE_MODE, "staging");
  assert.equal(result.VIEWER_UPSTREAM_HOST, "localhost:4391");

  for (const patch of [
    { APP_ORIGIN: "http://app.example.com" },
    { APP_ORIGIN: "https://APP.example.com" },
    { APP_ORIGIN: "https://app.example.com:443" },
    { APP_ORIGIN: "https://app.example.com/path" },
  ])
    assert.throws(() => staging(patch), /canonical HTTPS/);
  assert.throws(
    () => staging({ VIEWER_ORIGIN: "https://viewer.example.com" }),
    /different registrable domains/,
  );
  assert.throws(() => staging({ COOKIE_SECURE: "false" }), /secure cookies/);
  assert.throws(() => staging({ HOST: "0.0.0.0" }), /bind to loopback/);
  assert.throws(() => staging({ VIEWER_PORT: 4390 }), /different ports/);
});

test("private PSL suffixes do not collapse to a last-two-label heuristic", () => {
  assert.throws(
    () =>
      staging({
        APP_ORIGIN: "https://app.team.github.io",
        VIEWER_ORIGIN: "https://viewer.team.github.io",
      }),
    /different registrable domains/,
  );
  assert.equal(
    staging({
      APP_ORIGIN: "https://app.team.github.io",
      VIEWER_ORIGIN: "https://viewer.other.github.io",
    }).HTML_LIVE_ENABLED,
    true,
  );
});

test("staging allowlist is required, bounded, unique and revision-specific", () => {
  assert.throws(
    () => staging({ HTML_LIVE_STAGING_REVISION_IDS: "" }),
    /non-empty/,
  );
  assert.throws(
    () => staging({ HTML_LIVE_STAGING_REVISION_IDS: "not-a-uuid" }),
    /invalid UUID/,
  );
  assert.throws(
    () => staging({ HTML_LIVE_STAGING_REVISION_IDS: `${allowed},${allowed}` }),
    /duplicates/,
  );
  assert.throws(
    () =>
      staging({
        HTML_LIVE_STAGING_REVISION_IDS: Array.from(
          { length: 101 },
          (_, index) =>
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ).join(","),
      }),
    /limited to 100/,
  );
  assert.throws(
    () =>
      parseViewerConfig({
        ...base,
        HTML_LIVE_STAGING_REVISION_IDS: allowed,
      }),
    /only valid in staging/,
  );

  const viewer = staging({
    HTML_LIVE_STAGING_REVISION_IDS: `${allowed},${other}`,
  });
  assert.equal(isLiveRevisionEligible(viewer, allowed), true);
  assert.equal(isLiveRevisionEligible(viewer, other), true);
  assert.equal(
    isLiveRevisionEligible(viewer, "33333333-3333-4333-8333-333333333333"),
    false,
  );
  assert.ok(Object.isFrozen(viewer.HTML_LIVE_STAGING_REVISION_IDS));
});
