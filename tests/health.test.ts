import { test } from "node:test";
import assert from "node:assert/strict";
import { createHealthCoordinator } from "../apps/server/health.ts";
const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("readiness shares concurrent checks and caches only complete success", async () => {
  const database = deferred(),
    storage = deferred();
  let calls = 0;
  const health = createHealthCoordinator({
    database: () => {
      calls++;
      return database.promise;
    },
    storage: () => storage.promise,
  });
  const first = health.ready();
  assert.equal(health.ready(), first);
  database.resolve(true);
  storage.resolve(true);
  assert.equal(await first, true);
  assert.equal(await health.ready(), true);
  assert.equal(calls, 1);
  health.stop();
  assert.equal(health.alive(), false);
  assert.equal(await health.ready(), false);
});

test("timeout aborts both probes, refuses overlap and cannot accept late success", async () => {
  const database = deferred(),
    storage = deferred();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const health = createHealthCoordinator({
    deadlineMs: 15,
    cacheMs: 5000,
    database: (signal) => {
      signals.push(signal);
      calls++;
      return database.promise;
    },
    storage: (signal) => {
      signals.push(signal);
      return storage.promise;
    },
  });
  assert.equal(await health.ready(), false);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(await health.ready(), false);
  assert.equal(calls, 1);
  database.resolve(true);
  storage.resolve(true);
  // Let the I/O finish after timeout: the cached outcome must remain failed.
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(await health.ready(), false);
  assert.equal(calls, 1);
  health.stop();
});

test("failed dependencies do not expose errors; stopping settles in-flight requests", async () => {
  const failure = createHealthCoordinator({
    database: async () => {
      throw new Error("private provider error");
    },
    storage: async () => true,
  });
  assert.equal(await failure.ready(), false);
  assert.equal(failure.alive(), true);
  failure.stop();
  const delayed = deferred();
  const health = createHealthCoordinator({
    database: () => delayed.promise,
    storage: () => delayed.promise,
  });
  const pending = health.ready();
  health.stop();
  assert.equal(await pending, false);
  delayed.resolve(true);
  assert.equal(await health.ready(), false);
});

test("immediate shutdown prevents deferred adapters from starting", async () => {
  let calls = 0;
  const probe = async () => {
    calls++;
    return true;
  };
  const health = createHealthCoordinator({ database: probe, storage: probe });
  const pending = health.ready();
  health.stop();
  assert.equal(await pending, false);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(calls, 0);
});

test("elapsed deadline is enforced even before delayed timer callback runs", async () => {
  const health = createHealthCoordinator({
    deadlineMs: 5,
    database: async () => {
      const until = performance.now() + 10;
      while (performance.now() < until) {
        /* simulate bounded event-loop work */
      }
      return true;
    },
    storage: async () => true,
  });
  assert.equal(await health.ready(), false);
  health.stop();
});
