import { parentPort } from "node:worker_threads";
import type { BundleManifest } from "../../packages/contracts/bundle.ts";
import { buildInlineBundle } from "./bundle-inline.ts";

type Request = {
  manifest: BundleManifest;
  files: Array<{ path: string; bytes: Uint8Array }>;
};

if (!parentPort) throw new Error("Bundle build worker needs a parent port");

parentPort.once("message", (request: Request) => {
  try {
    const result = buildInlineBundle(
      request.manifest,
      new Map(
        request.files.map((file) => [file.path, Buffer.from(file.bytes)]),
      ),
    );
    parentPort!.postMessage(result);
  } catch {
    parentPort!.postMessage({
      ok: false,
      failed: true,
      reason: "Не удалось безопасно собрать страницу.",
    });
  }
});
