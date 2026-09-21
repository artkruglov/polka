import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startMaintenanceChild } from "../scripts/maintenance-child.ts";

class FakeChild extends EventEmitter {
  readonly kills: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    return false;
  }
}

function fakeStart(
  child: FakeChild,
  seen: { command?: string; args?: string[]; options?: unknown },
) {
  return (command: string, args: string[], options: unknown) => {
    seen.command = command;
    seen.args = args;
    seen.options = options;
    return child as never;
  };
}

test("child adapter starts the exact local maintenance command without a shell", async () => {
  const child = new FakeChild();
  const seen: { command?: string; args?: string[]; options?: unknown } = {};
  const adapter = startMaintenanceChild({
    scriptPath: "/srv/polka/scripts/maintenance.ts",
    spawnProcess: fakeStart(child, seen),
  });
  assert.equal(seen.command, process.execPath);
  assert.deepEqual(seen.args, [
    "--import",
    "tsx",
    "/srv/polka/scripts/maintenance.ts",
  ]);
  assert.deepEqual(seen.options, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.emit("spawn");
  child.emit("close", 0, null);
  assert.deepEqual(await adapter.exited, { code: 0, signal: null });
});

test("post-spawn errors and false kill results do not settle before close", async () => {
  const child = new FakeChild();
  const adapter = startMaintenanceChild({ spawnProcess: fakeStart(child, {}) });
  child.emit("spawn");
  child.emit("error", new Error("private endpoint and token"));
  child.emit("error", new Error("second private provider detail"));
  adapter.terminate("SIGTERM");
  adapter.terminate("SIGKILL");
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  let settled = false;
  void adapter.exited.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("close", 137, "SIGKILL");
  assert.deepEqual(await adapter.exited, { code: 137, signal: "SIGKILL" });
  adapter.terminate("SIGTERM");
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("spawn failure rejects with a sanitized error and does not expose env details", async () => {
  const child = new FakeChild();
  const adapter = startMaintenanceChild({ spawnProcess: fakeStart(child, {}) });
  child.emit("error", new Error("SECRET_DATABASE_URL=postgres://private"));
  await assert.rejects(adapter.exited, (error: Error) => {
    assert.equal(error.message, "maintenance child failed to start");
    assert.equal(error.message.includes("postgres"), false);
    return true;
  });
  child.emit("close", 1, null);
});

test("child streams forward only safe events while draining raw diagnostics", async () => {
  const child = new FakeChild();
  const logs: unknown[] = [];
  const adapter = startMaintenanceChild({
    spawnProcess: fakeStart(child, {}),
    onLog: (e) => logs.push(e),
  });
  child.emit("spawn");
  child.stderr.emit("data", Buffer.from("postgres://private:secret@host\n"));
  child.stdout.emit(
    "data",
    Buffer.from(
      '{"event":"maintenance.skipped","reason":"busy","password":"secret"}\n',
    ),
  );
  child.stderr.emit("error", new Error("private stream error"));
  child.stdout.emit("end");
  child.stderr.emit("end");
  child.emit("close", 0, null);
  await adapter.exited;
  assert.deepEqual(logs, [{ event: "maintenance.skipped", reason: "busy" }]);
});

test("real benign Node child filters output and exits on TERM", async () => {
  const { fileURLToPath } = await import("node:url");
  const logs: Array<{ event: string; reason?: string }> = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const adapter = startMaintenanceChild({
    scriptPath: fileURLToPath(
      new URL("./fixtures/maintenance-child-smoke.ts", import.meta.url),
    ),
    onLog: (event) => {
      logs.push(event);
      if (event.event === "maintenance.started") started();
    },
  });
  const timeout = setTimeout(() => adapter.terminate("SIGKILL"), 5000);
  try {
    await Promise.race([
      ready,
      adapter.exited.then(() => {
        throw new Error("Child exited before ready");
      }),
    ]);
    adapter.terminate("SIGTERM");
    assert.deepEqual(await adapter.exited, { code: 0, signal: null });
    assert.deepEqual(logs, [
      { event: "maintenance.started" },
      { event: "maintenance.failed", reason: "stopping", durationMs: 1 },
    ]);
  } finally {
    clearTimeout(timeout);
    adapter.terminate("SIGKILL");
  }
});
