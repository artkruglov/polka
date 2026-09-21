import { fileURLToPath } from "node:url";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  createMaintenanceLogFilter,
  type SafeMaintenanceLog,
} from "./maintenance-log-filter.ts";
import type { MaintenanceChild } from "./maintenance-scheduler.ts";

export type MaintenanceSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type MaintenanceChildOptions = {
  scriptPath?: string;
  spawnProcess?: MaintenanceSpawn;
  onLog?: (event: SafeMaintenanceLog) => void;
};

/**
 * Start one bounded maintenance run. The scheduler owns the deadline; this
 * adapter only translates ChildProcess close/kill semantics to its contract.
 */
export function startMaintenanceChild(
  options: MaintenanceChildOptions = {},
): MaintenanceChild {
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("./maintenance.ts", import.meta.url));
  const start = options.spawnProcess ?? spawn;
  const child = start(process.execPath, ["--import", "tsx", scriptPath], {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let forwardedBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const filter = createMaintenanceLogFilter((event) => {
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (forwardedBytes + bytes > 65536) return;
      forwardedBytes += bytes;
      options.onLog?.(event);
    });
    stream.on("data", (chunk: Buffer) => filter.push(chunk));
    stream.on("end", () => filter.end());
    stream.on("error", () => undefined);
  }
  let created = false;
  let exited = false;
  let resolveExit!: (result: {
    code: number | null;
    signal?: string | null;
  }) => void;
  let rejectExit!: (reason: Error) => void;
  const exit = new Promise<{ code: number | null; signal?: string | null }>(
    (resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    },
  );
  child.once("spawn", () => {
    created = true;
  });
  child.on("error", () => {
    if (created || exited) return;
    exited = true;
    rejectExit(new Error("maintenance child failed to start"));
  });
  child.once("close", (code, signal) => {
    if (exited) return;
    exited = true;
    resolveExit({ code, signal });
  });
  return {
    exited: exit,
    terminate(signal) {
      if (exited) return;
      try {
        child.kill(signal);
      } catch {
        // A failed kill is not evidence of exit; the close event remains authoritative.
      }
    },
  };
}
