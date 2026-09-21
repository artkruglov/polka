import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  runMaintenanceGuard,
  type MaintenanceClient,
} from "../scripts/maintenance-guard.ts";

function fakeClient(options: {
  locked?: boolean;
  failOn?: string;
  calls?: string[];
}) {
  const calls = options.calls ?? [];
  let ended = false;
  const client: MaintenanceClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: options.locked ?? true }] };
      if (options.failOn && sql === options.failOn)
        throw new Error("connection lost");
      return { rows: [] };
    },
    release() {
      calls.push("RELEASE");
    },
    end() {
      ended = true;
    },
  };
  return { client, calls, ended: () => ended };
}

test("busy guard skips work and closes the dedicated client", async () => {
  const current = fakeClient({ locked: false });
  let ran = false;
  const result = await runMaintenanceGuard({
    client: current.client,
    signal: new AbortController().signal,
    run: async () => {
      ran = true;
      return 1;
    },
  });
  assert.deepEqual(result, { state: "busy" });
  assert.equal(ran, false);
  assert.deepEqual(current.calls, [
    "SELECT pg_try_advisory_lock($1) AS locked",
    "RELEASE",
  ]);
  assert.equal(current.calls.includes("RELEASE"), true);
});

test("transactions are sequential and commit only while active", async () => {
  const current = fakeClient({});
  const result = await runMaintenanceGuard({
    client: current.client,
    signal: new AbortController().signal,
    run: async ({ transaction }) => {
      await transaction(async (client) => {
        await client.query("SELECT candidate_one");
      });
      await transaction(async (client) => {
        await client.query("SELECT candidate_two");
      });
      return "ok";
    },
  });
  assert.deepEqual(result, { state: "completed", value: "ok" });
  assert.deepEqual(current.calls, [
    "SELECT pg_try_advisory_lock($1) AS locked",
    "BEGIN",
    "SELECT candidate_one",
    "COMMIT",
    "BEGIN",
    "SELECT candidate_two",
    "COMMIT",
    "SELECT pg_advisory_unlock($1)",
    "RELEASE",
  ]);
});

test("guard loss rolls back and prevents a later transaction or commit", async () => {
  const current = fakeClient({ failOn: "SELECT candidate" });
  let secondStarted = false;
  const result = await runMaintenanceGuard({
    client: current.client,
    signal: new AbortController().signal,
    run: async ({ transaction }) => {
      await transaction(async (client) => {
        await client.query("SELECT candidate");
      });
      secondStarted = true;
      await transaction(async () => {});
      return null;
    },
  });
  assert.deepEqual(result, { state: "guard_lost" });
  assert.equal(secondStarted, false);
  assert.equal(current.calls.includes("COMMIT"), false);
});

test("abort before commit rolls back without a business commit", async () => {
  const current = fakeClient({});
  const controller = new AbortController();
  const result = await runMaintenanceGuard({
    client: current.client,
    signal: controller.signal,
    run: async ({ transaction }) =>
      transaction(async () => {
        controller.abort();
        return "late";
      }),
  });
  assert.deepEqual(result, { state: "aborted" });
  assert.equal(current.calls.includes("COMMIT"), false);
  assert.equal(current.calls.includes("ROLLBACK"), true);
});

test("pre-aborted guard does not query or run work", async () => {
  const current = fakeClient({});
  const controller = new AbortController();
  controller.abort();
  const result = await runMaintenanceGuard({
    client: current.client,
    signal: controller.signal,
    run: async () => {
      throw new Error("must not run");
    },
  });
  assert.deepEqual(result, { state: "aborted" });
  assert.deepEqual(current.calls, ["RELEASE"]);
});

test("connection loss aborts an outside wait and rejects subsequent SQL", async () => {
  const events = new EventEmitter();
  const calls: string[] = [];
  const client: MaintenanceClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: true }] };
      return { rows: [] };
    },
    on(event, listener) {
      events.on(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
    },
    release() {
      calls.push("RELEASE");
    },
  };
  const result = await runMaintenanceGuard({
    client,
    signal: new AbortController().signal,
    run: async ({ signal, transaction }) => {
      await new Promise((resolve) => {
        setTimeout(() => {
          events.emit("error", new Error("connection lost"));
          events.emit("error", new Error("repeated connection lost"));
          resolve(undefined);
        }, 5);
      });
      assert.equal(signal.aborted, true);
      await transaction(async () => undefined);
      return "unreachable";
    },
  });
  assert.deepEqual(result, { state: "guard_lost" });
  assert.equal(calls.includes("COMMIT"), false);
});

test("external abort destroys a deferred query before it can continue", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let queryStarted = false;
  let destroyed = false;
  let releaseQuery!: () => void;
  const client: MaintenanceClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: true }] };
      if (sql === "SELECT deferred") {
        queryStarted = true;
        await new Promise<void>((resolve) => {
          releaseQuery = resolve;
        });
      }
      return { rows: [] };
    },
    release(force) {
      destroyed ||= force === true;
    },
  };
  const pending = runMaintenanceGuard({
    client,
    signal: controller.signal,
    run: ({ transaction }) =>
      transaction(async (tx) => {
        await tx.query("SELECT deferred");
        await tx.query("SELECT must-not-run");
        return null;
      }),
  });
  while (!queryStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  assert.equal(destroyed, true);
  releaseQuery();
  const result = await pending;
  assert.deepEqual(result, { state: "aborted" });
  assert.equal(calls.includes("SELECT must-not-run"), false);
  assert.equal(calls.includes("COMMIT"), false);
});

test("a deferred rollback keeps the transaction active and timeout destroys the session", async () => {
  const calls: string[] = [];
  let rollbackStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    rollbackStarted = resolve;
  });
  let destroyed = false;
  const client: MaintenanceClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: true }] };
      if (sql === "ROLLBACK") {
        rollbackStarted();
        await new Promise(() => undefined);
      }
      return { rows: [] };
    },
    release(force) {
      destroyed ||= force === true;
    },
  };
  let secondOperationRan = false;
  const result = await runMaintenanceGuard({
    client,
    signal: new AbortController().signal,
    run: async ({ signal, transaction }) => {
      const first = transaction(async () => {
        throw new Error("business failure");
      });
      const firstFailure = assert.rejects(first, /business failure/);
      await started;
      await assert.rejects(
        transaction(async () => {
          secondOperationRan = true;
        }),
        /transactions must be sequential/,
      );
      await firstFailure;
      assert.equal(signal.aborted, true);
      await transaction(async () => {
        secondOperationRan = true;
      });
      return "unreachable";
    },
  });
  assert.deepEqual(result, { state: "aborted" });
  assert.equal(secondOperationRan, false);
  assert.equal(destroyed, true);
  assert.equal(calls.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.equal(calls.includes("COMMIT"), false);
});

test("a late connection error stays harmless after bounded close times out", async () => {
  const events = new EventEmitter();
  let closeStarted = false;
  let finishClose!: () => void;
  const closeFinished = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const client: MaintenanceClient = {
    async query(sql) {
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: false }] };
      return { rows: [] };
    },
    on(event, listener) {
      events.on(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
    },
    end() {
      closeStarted = true;
      return closeFinished;
    },
  };
  const result = await runMaintenanceGuard({
    client,
    signal: new AbortController().signal,
    run: async () => "unreachable",
  });
  assert.deepEqual(result, { state: "busy" });
  assert.equal(closeStarted, true);
  assert.doesNotThrow(() =>
    events.emit("error", new Error("late socket failure")),
  );
  finishClose();
});
