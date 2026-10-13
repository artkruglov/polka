import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { startPoolWatchdog } from "../apps/server/watchdog.ts";
import { eventLoopDelayWindow } from "../apps/server/runtime-stats.ts";

const fixture = fileURLToPath(new URL("./fixtures/watchdog-blocked-loop.ts", import.meta.url));

function run(limitMs: number, blockMs: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, String(limitMs), String(blockMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code, signal) => resolve({ code, signal, out }));
  });
}

test("a process whose event loop stays blocked past the limit is killed, with a log line", async () => {
  const { signal, out } = await run(700, 30_000);
  assert.equal(signal, "SIGKILL", out);
  const line = JSON.parse(out.split("\n").find((entry) => entry.includes("watchdog.event_loop_blocked"))!);
  assert.equal(line.level, "fatal");
  assert.equal(line.limitMs, 700);
  assert.ok(line.blockedMs > 700);
  assert.doesNotMatch(out, /survived/);
});

test("a short block under the limit is left alone", async () => {
  const { code, signal, out } = await run(3_000, 300);
  assert.equal(signal, null, out);
  assert.equal(code, 0, out);
  assert.match(out, /survived/);
});

class FakePool extends EventEmitter {
  options = { max: 2 };
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
}

function watch(pool: FakePool, limitMs: number) {
  let time = 0;
  const stalls: number[] = [];
  const stop = startPoolWatchdog({
    pool: pool as never,
    limitMs,
    onStall: () => stalls.push(time),
    checkMs: 1_000_000,
    now: () => time,
  });
  return { stalls, stop, at: (ms: number) => (time = ms) };
}

test("the pool watchdog fires once when the pool is full, requests wait and nothing moves", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pool = new FakePool();
  const { stalls, stop, at } = watch(pool, 10_000);
  const check = () => t.mock.timers.tick(1_000_000);
  // Busy but moving: checkouts keep happening.
  Object.assign(pool, { totalCount: 2, idleCount: 0, waitingCount: 3 });
  at(1_000);
  check();
  at(9_000);
  pool.emit("release");
  at(15_000);
  check();
  assert.deepEqual(stalls, []);
  // Waiting stops being a stall when a connection frees up.
  Object.assign(pool, { idleCount: 1, waitingCount: 0 });
  at(40_000);
  check();
  assert.deepEqual(stalls, []);
  // Full, waiting, no progress: measured from when the stall was first seen.
  Object.assign(pool, { idleCount: 0, waitingCount: 1 });
  at(50_000);
  check();
  at(59_000);
  check();
  assert.deepEqual(stalls, []);
  at(61_000);
  check();
  at(90_000);
  check();
  assert.deepEqual(stalls, [61_000]);
  stop();
});

test("a database that is down does not count as a stall: its connections leave the pool", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pool = new FakePool();
  const { stalls, at } = watch(pool, 1_000);
  Object.assign(pool, { totalCount: 0, idleCount: 0, waitingCount: 5 });
  for (const ms of [1_000, 10_000, 100_000]) {
    at(ms);
    t.mock.timers.tick(1_000_000);
  }
  assert.deepEqual(stalls, []);
});

test("event-loop delay excludes the sampling period", async () => {
  const window = eventLoopDelayWindow();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const idle = window.read();
  // An idle loop used to read as the histogram's resolution (20 ms): at
  // least one turn of an idle loop is now close to no delay at all.
  assert.ok(idle.min < 3, `idle min ${idle.min} ms`);
  assert.ok(idle.mean <= idle.p99 && idle.p99 <= idle.max, JSON.stringify(idle));
  // After a read the histogram needs one turn to start measuring again.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const end = Date.now() + 120;
  while (Date.now() < end);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const busy = window.read();
  assert.ok(busy.max >= 80, JSON.stringify(busy));
});
