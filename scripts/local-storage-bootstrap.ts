import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "../apps/server/config.ts";
import { prepareBucket, s3 } from "../apps/server/storage.ts";
import { runLocalStorageBootstrap } from "./local-storage-bootstrap-lib.ts";

if (!process.argv.includes("--confirm-local-bootstrap"))
  throw new Error(
    "Pass --confirm-local-bootstrap to provision generated local storage",
  );

const checkScript = fileURLToPath(
  new URL("./storage-check.ts", import.meta.url),
);
await runLocalStorageBootstrap(
  {
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
  },
  {
    async provision() {
      try {
        await prepareBucket();
      } finally {
        s3.destroy();
      }
      console.log(
        "Local versioned storage provisioned; running capability check.",
      );
    },
    async check() {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", checkScript, "--confirm-bootstrap"],
          {
            env: process.env,
            stdio: "inherit",
          },
        );
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal)
            reject(new Error("Local storage capability check interrupted"));
          else resolve(code ?? 1);
        });
      });
      if (exitCode !== 0)
        throw new Error("Local storage capability check failed");
    },
  },
);
