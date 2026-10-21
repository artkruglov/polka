// The packs' timers (schedule.mjs, fin.mjs due): a slot runs once, a missed
// week runs once, a failed step is tried again, letters go first.
// node --test deploy/finance-stand/specs/*.spec.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { due, lastSlot, timedPacks } from "../schedule.mjs";

const at = (s) => new Date(s);
const names = (run) => run.map((p) => p.process);

test("the stand's packs: inbox, match, chase, remind in a working day's order; recon stays manual", async () => {
  const packs = await timedPacks();
  assert.deepEqual(names(packs), ["fin.inbox", "fin.match", "fin.chase", "fin.remind"]);
  assert.deepEqual(
    packs.map((p) => p.timer),
    ["every", "daily 09:00", "daily 09:30", "mon 10:00"],
  );
});

test("a slot is the last one at or before the moment", () => {
  // 2026-10-21 is a Wednesday.
  assert.equal(lastSlot("daily 09:00", at("2026-10-21T08:59:00")).getDate(), 20);
  assert.equal(lastSlot("daily 09:00", at("2026-10-21T09:00:00")).getDate(), 21);
  assert.equal(lastSlot("mon 10:00", at("2026-10-21T12:00:00")).getDate(), 19);
  assert.equal(lastSlot("mon 10:00", at("2026-10-19T09:00:00")).getDate(), 12);
  assert.equal(lastSlot("every", at("2026-10-21T12:00:00")), null);
  assert.throws(() => lastSlot("daily 9", at("2026-10-21T12:00:00")), /расписание/);
});

test("what ran in its slot waits for the next one; the inbox runs on every pass", async () => {
  const packs = await timedPacks();
  const now = at("2026-10-21T09:40:00");
  const first = due(packs, {}, now);
  assert.deepEqual(names(first), ["fin.inbox", "fin.match", "fin.chase", "fin.remind"]);
  const last = Object.fromEntries(first.filter((p) => p.slot).map((p) => [p.process, p.slot.toISOString()]));
  assert.deepEqual(names(due(packs, last, at("2026-10-21T09:45:00"))), ["fin.inbox"]);
  assert.deepEqual(names(due(packs, last, at("2026-10-22T09:05:00"))), ["fin.inbox", "fin.match"]);
  assert.deepEqual(names(due(packs, last, at("2026-10-26T10:00:00"))), [
    "fin.inbox",
    "fin.match",
    "fin.chase",
    "fin.remind",
  ]);
});

test("a stand off for a week runs each missed step once; a failed step is due again", async () => {
  const packs = await timedPacks();
  const last = { "fin.match": "2026-10-12T09:00:00", "fin.chase": "2026-10-12T09:30:00" };
  const run = due(packs, last, at("2026-10-21T09:40:00"));
  assert.equal(run.filter((p) => p.process === "fin.match").length, 1);
  // match failed: its slot is not recorded, the next pass takes it again.
  const after = { ...last, "fin.chase": run.find((p) => p.process === "fin.chase").slot.toISOString() };
  assert.ok(names(due(packs, after, at("2026-10-21T09:45:00"))).includes("fin.match"));
});
