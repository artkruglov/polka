import { parentPort } from "node:worker_threads";
import type { BundleManifest } from "../../packages/contracts/bundle.ts";
import { BUILD_FAILURE_MESSAGES } from "./bundle-runtime-contract.ts";
import { buildDerivative, needsRuntimeBuild } from "./react-runtime.ts";

type Request = {
  manifest: BundleManifest;
  files: Array<{ path: string; bytes: Uint8Array }>;
};

if (!parentPort) throw new Error("Bundle build worker needs a parent port");
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
    port.postMessage({ type: "result", result });
  } catch {
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
