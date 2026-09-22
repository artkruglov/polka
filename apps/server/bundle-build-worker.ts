import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import { stop as stopEsbuild } from "esbuild";
import type { BundleManifest } from "../../packages/contracts/bundle.ts";
import { BUILD_FAILURE_MESSAGES } from "./bundle-runtime-contract.ts";
import { buildDerivative, needsRuntimeBuild } from "./react-runtime.ts";

type Request = {
  manifest: BundleManifest;
  files: Array<{ path: string; bytes: Uint8Array }>;
};

if (!parentPort) throw new Error("Bundle build worker needs a parent port");

// esbuild starts its service with child_process.spawn and unrefs it, so this
// thread could end before that child's exit is reaped, leaving a zombie of
// the server process for every build. Keep the handles this worker spawns
// (esbuild is the only caller here) so reap() can wait for them.
const children: ChildProcess[] = [];
const childProcess = createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");
const spawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const child = (spawn as (...a: unknown[]) => ChildProcess)(...args);
  children.push(child);
  return child;
}) as typeof spawn;
const port = parentPort;

/**
 * Protocol: the parent sends one request. A page the runtime builds
 * (esbuild) first asks for the process-wide runtime slot with
 * {type:"runtime"} and waits for true/false; the page is classified here,
 * off the server's main thread. The answer is {type:"result"}.
 */
port.once("message", async (request: Request) => {
  try {
    const files = new Map(
      request.files.map((file) => [file.path, Buffer.from(file.bytes)]),
    );
    const runtime = needsRuntimeBuild(request.manifest, files);
    if (runtime) {
      const granted = await new Promise<unknown>((resolve) => {
        port.once("message", resolve);
        port.postMessage({ type: "runtime" });
      });
      if (granted !== true) {
        port.postMessage({
          type: "result",
          result: {
            ok: false,
            busy: true,
            reason: "runtime build slot is busy",
          },
        });
        return;
      }
    }
    const result = await buildDerivative(request.manifest, files, {
      allowRuntime: runtime,
    });
    await reap();
    port.postMessage({ type: "result", result });
  } catch {
    await reap();
    port.postMessage({
      type: "result",
      result: {
        ok: false,
        failed: true,
        category: "crash",
        reason: BUILD_FAILURE_MESSAGES.crash,
      },
    });
  }
});

/**
 * Stop the esbuild service and wait until its process has exited and been
 * reaped before answering; the parent ends this worker after the answer.
 */
async function reap() {
  try {
    await stopEsbuild();
  } catch {
    // No service was started (a page that needed no runtime build).
  }
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? undefined
        : new Promise<void>((done) => {
            child.ref();
            child.once("exit", () => done());
          }),
    ),
  );
}
