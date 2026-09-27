// Failures nobody awaits are still told (db.ts afterCommit, main.ts process
// handlers), and background work can be awaited (settled) instead of slept on.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { afterCommit, db, DATABASE_SESSION, errorFacts, settled, transaction } from "../apps/server/db.ts";
import { installProcessErrorHandlers } from "../apps/server/process-errors.ts";

after(async () => {
  await db.end();
});

async function capture(run: () => Promise<void>) {
  const lines: string[] = [];
  const logged = console.error;
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    await run();
  } finally {
    console.error = logged;
  }
  return lines.map((line) => JSON.parse(line));
}

test("work after a commit that fails is logged with its name, code and message", async () => {
  const lines = await capture(async () => {
    await transaction(async (c) => {
      afterCommit(c, async () => {
        throw Object.assign(new TypeError("mail server refused"), { code: "EAUTH" });
      });
    });
    await settled();
  });
  assert.deepEqual(lines, [
    { event: "database.after_commit_failed", name: "TypeError", code: "EAUTH", message: "mail server refused" },
  ]);
});

test("settled() waits for work after a commit, and for the work it starts", async () => {
  const done: string[] = [];
  await transaction(async (c) => {
    afterCommit(c, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      done.push("letter");
      afterCommit(c, async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        done.push("follow-up");
      });
    });
  });
  await settled();
  assert.deepEqual(done, ["letter", "follow-up"]);
});

test("the app's connections carry its session limits", async () => {
  const {
    rows: [row],
  } = await db.query(
    "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle",
  );
  assert.deepEqual(DATABASE_SESSION, { statement_timeout: 15_000, idle_in_transaction_session_timeout: 60_000 });
  assert.deepEqual(row, { statement: "15s", idle: "1min" });
  // DATABASE_POOL_MAX, 20 unless the operator sets it (it was a fixed 8).
  assert.equal((db as unknown as { options: { max: number } }).options.max, process.env.DATABASE_POOL_MAX ? Number(process.env.DATABASE_POOL_MAX) : 20);
});

test("an unhandled rejection is logged and survived; an uncaught exception is logged and exits", async () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  installProcessErrorHandlers(target as unknown as NodeJS.Process, (code) => exits.push(code));
  const lines = await capture(async () => {
    target.emit("unhandledRejection", Object.assign(new Error("lost letter"), { code: "ETIMEDOUT" }));
    assert.deepEqual(exits, []);
    target.emit("uncaughtException", new RangeError("broken state"));
  });
  assert.deepEqual(exits, [1]);
  assert.deepEqual(lines, [
    { event: "process.unhandled_rejection", name: "Error", code: "ETIMEDOUT", message: "lost letter" },
    { event: "process.uncaught_exception", name: "RangeError", message: "broken state" },
  ]);
  assert.deepEqual(errorFacts("text"), { name: "string", code: undefined, message: undefined });
});
