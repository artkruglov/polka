import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/shutdown-drain.ts", import.meta.url));

/** Start the fixture, SIGTERM it once it is ready; its exit code, time to exit and output. */
function stopAfterReady(workMs: number, deadlineMs: number) {
  return new Promise<{ code: number | null; stoppedInMs: number; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, String(workMs), String(deadlineMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let signalled = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture did not stop: ${out}`));
    }, 20_000);
    const read = (chunk: Buffer) => {
      out += chunk;
      if (!signalled && out.includes("ready\n")) {
        signalled = Date.now();
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stoppedInMs: Date.now() - signalled, out });
    });
  });
}

test("SIGTERM waits for pending after-commit work, then closes the pool and exits 0", async () => {
  const { code, stoppedInMs, out } = await stopAfterReady(800, 10_000);
  assert.equal(code, 0, out);
  const done = out.indexOf("after-commit done");
  const stopped = out.indexOf('"event":"server.stopped"');
  assert.ok(done >= 0, out);
  // The work ran to the end, with the pool still open, before the stop.
  assert.ok(stopped > done, out);
  assert.match(out, /"event":"server.stopped","drained":true,"closed":true/);
  assert.doesNotMatch(out, /after_commit_failed/);
  assert.ok(stoppedInMs >= 500, `stopped after ${stoppedInMs} ms`);
});

test("SIGTERM gives up on work that outlives the deadline and still exits", async () => {
  const { code, stoppedInMs, out } = await stopAfterReady(15_000, 500);
  assert.equal(code, 0, out);
  assert.match(out, /"event":"server.stop_deadline"/);
  assert.match(out, /"event":"server.stopped","drained":false/);
  assert.doesNotMatch(out, /after-commit done/);
  assert.ok(stoppedInMs < 8_000, `stopped after ${stoppedInMs} ms`);
});
