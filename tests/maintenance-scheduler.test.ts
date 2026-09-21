import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  runMaintenanceScheduler,
  type MaintenanceChild,
} from "../scripts/maintenance-scheduler.ts";

function pendingChild() {
  let resolve!: (value: { code: number | null }) => void;
  const kills: string[] = [];
  const child: MaintenanceChild = {
    exited: new Promise((done) => {
      resolve = done;
    }),
    terminate: (signal) => {
      kills.push(signal);
    },
  };
  return { child, kills, finish: (code = 0) => resolve({ code }) };
}

test("scheduler never overlaps and measures the interval after child exit", async () => {
  const controller = new AbortController();
  const first = pendingChild();
  let starts = 0;
  const run = runMaintenanceScheduler({
    signal: controller.signal,
    intervalMs: 25,
    deadlineMs: 1000,
    start: () => {
      starts++;
      return first.child;
    },
    onEvent: (event) => {
      if (event.event === "completed") controller.abort();
    },
  });
  await delay(45);
  assert.equal(starts, 1);
  first.finish();
  await run;
  assert.equal(starts, 1);
  assert.deepEqual(first.kills, []);
});

test("deadline sends TERM then KILL and cannot restart until actual exit", async () => {
  const controller = new AbortController();
  const first = pendingChild();
  const events: unknown[] = [];
  let starts = 0;
  const run = runMaintenanceScheduler({
    signal: controller.signal,
    intervalMs: 5,
    deadlineMs: 10,
    graceMs: 10,
    start: () => {
      starts++;
      return first.child;
    },
    onEvent: (e) => events.push(e),
  });
  await delay(50);
  assert.deepEqual(first.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(starts, 1);
  controller.abort();
  first.finish(1);
  await run;
  assert.deepEqual(events, [
    { event: "started" },
    { event: "failed", reason: "deadline" },
  ]);
});

test("stop cancels waiting; pre-aborted scheduler never spawns", async () => {
  const controller = new AbortController();
  controller.abort();
  let starts = 0;
  await runMaintenanceScheduler({
    signal: controller.signal,
    start: () => {
      starts++;
      return pendingChild().child;
    },
  });
  assert.equal(starts, 0);
  const active = new AbortController();
  const child = pendingChild();
  const run = runMaintenanceScheduler({
    signal: active.signal,
    start: () => child.child,
  });
  active.abort();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.finish(1);
  await run;
});

test("failed run waits before retry; stop prevents retry", async () => {
  const controller = new AbortController();
  let starts = 0;
  const run = runMaintenanceScheduler({
    signal: controller.signal,
    intervalMs: 1000,
    start: () => {
      starts++;
      throw new Error("private operator detail");
    },
  });
  await delay(10);
  controller.abort();
  await run;
  assert.equal(starts, 1);
});

test("throwing event sink cannot abandon a live child", async () => {
  const controller = new AbortController();
  const child = pendingChild();
  const run = runMaintenanceScheduler({
    signal: controller.signal,
    start: () => child.child,
    onEvent: () => {
      throw new Error("sink failure");
    },
  });
  controller.abort();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.finish(1);
  await run;
});

test("failed termination still escalates and waits for authoritative exit", async () => {
  const controller = new AbortController();
  const child = pendingChild();
  const calls: string[] = [];
  let starts = 0;
  const run = runMaintenanceScheduler({
    signal: controller.signal,
    deadlineMs: 5,
    graceMs: 5,
    intervalMs: 5,
    start: () => {
      starts++;
      return {
        ...child.child,
        terminate: (signal) => {
          calls.push(signal);
          throw new Error("kill failed");
        },
      };
    },
  });
  await delay(35);
  assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
  assert.equal(starts, 1);
  controller.abort();
  child.finish(1);
  await run;
});
