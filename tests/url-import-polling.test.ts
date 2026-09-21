import { test } from "node:test";
import assert from "node:assert/strict";
import { pollImport } from "../apps/web/src/features/import-url/polling.ts";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("stopping polling rejects late success and errors, so cancellation remains authoritative", async () => {
  for (const reject of [false, true]) {
    let settle!: (value: any) => void;
    const seen: unknown[] = [];
    const pending = new Promise((resolve, fail) => {
      settle = reject ? fail : resolve;
    });
    const stop = pollImport({
      read: () => pending,
      onValue: (v) => {
        seen.push(v);
        return 1500;
      },
      onError: (e) => {
        seen.push(e);
        return 5000;
      },
      schedule: () => {
        assert.fail("stopped poller scheduled another request");
      },
    });
    stop();
    settle(reject ? new Error("late network failure") : { state: "fetching" });
    await flush();
    assert.deepEqual(seen, []);
  }
});
test("temporary failure retries the same job, terminal response stops polling", async () => {
  let reads = 0;
  let next: () => void = () => assert.fail("not scheduled");
  const delays: number[] = [];
  const values: string[] = [];
  const stop = pollImport({
    read: async () => {
      if (++reads === 1) throw Error("offline");
      return "ready";
    },
    onError: () => 5000,
    onValue: (v) => {
      values.push(v);
      return null;
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      next = fn;
      return () => {};
    },
  });
  await flush();
  assert.deepEqual(delays, [5000]);
  next();
  await flush();
  assert.equal(reads, 2);
  assert.deepEqual(values, ["ready"]);
  assert.deepEqual(delays, [5000]);
  stop();
});
test("stopping cancels a scheduled retry; access denial can stop without retry", async () => {
  let cancelled = false;
  const stop = pollImport({
    read: async () => 1,
    onValue: () => 1500,
    onError: () => null,
    schedule: () => () => {
      cancelled = true;
    },
  });
  await flush();
  stop();
  assert.equal(cancelled, true);
  pollImport({
    read: async () => {
      throw Error("denied");
    },
    onValue: () => null,
    onError: () => null,
    schedule: () => {
      assert.fail("denial should not retry");
    },
  });
  await flush();
});
