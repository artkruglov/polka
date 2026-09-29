// deploy/uptime-function/index.js: what a run does with the last result and
// this one. A letter goes out when the set of failing checks changes, and
// again when the same failure has gone on for six hours.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REMIND_AFTER_MS, decide } from "../deploy/uptime-function/index.js";

const at = (ms: number) => new Date(ms).toISOString();
const now = Date.parse("2026-09-29T12:00:00Z");

test("a change in the failing set is mailed, in both directions", () => {
  assert.equal(decide({ failing: [], alertedAt: null }, ["app health"], now), "changed");
  assert.equal(decide({ failing: ["app health"], alertedAt: at(now) }, [], now), "changed");
  assert.equal(decide({ failing: ["app health"], alertedAt: at(now) }, ["app health", "certificate"], now), "changed");
});

test("nothing failing and nothing changed says nothing, however long", () => {
  assert.equal(decide({ failing: [], alertedAt: at(now - 10 * REMIND_AFTER_MS) }, [], now), "none");
});

test("the same failure is quiet at first and mailed again after six hours", () => {
  const failing = ["operator status"];
  assert.equal(decide({ failing, alertedAt: at(now - 5 * 60_000) }, failing, now), "none");
  assert.equal(decide({ failing, alertedAt: at(now - REMIND_AFTER_MS + 1000) }, failing, now), "none");
  assert.equal(decide({ failing, alertedAt: at(now - REMIND_AFTER_MS) }, failing, now), "reminder");
});

test("a state without a time never reminds, it only reacts to change", () => {
  assert.equal(decide({ failing: ["x"], alertedAt: null }, ["x"], now), "none");
});
