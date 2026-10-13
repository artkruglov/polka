// A server-like process for tests/shutdown.test.ts: it commits a transaction
// whose after-commit work takes <work ms> and needs the pool, prints "ready",
// and stops on SIGTERM through the server's shutdown (shutdown.ts) with a
// deadline of <deadline ms>. argv: <work ms> <deadline ms>.
import { afterCommit, db, settled, transaction } from "../../apps/server/db.ts";
import { installShutdown } from "../../apps/server/shutdown.ts";

const [workMs, deadlineMs] = process.argv.slice(2).map(Number);
installShutdown({
  steps: { intake: async () => undefined, drain: settled, close: () => db.end() },
  deadlineMs: deadlineMs!,
});
await transaction(async (c) => {
  await c.query("SELECT 1");
  afterCommit(c, async () => {
    await new Promise((resolve) => setTimeout(resolve, workMs));
    // The pool is still open: closing waits for the drain.
    await db.query("SELECT 1");
    console.log("after-commit done");
  });
});
console.log("ready");
// Keep the loop alive the way the server's listener does.
setInterval(() => undefined, 60_000);
