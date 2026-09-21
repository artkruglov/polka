import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertLocalStorageBootstrapTarget,
  runLocalStorageBootstrap,
} from "../scripts/local-storage-bootstrap-lib.ts";

const generatedTarget = {
  endpoint: "http://127.0.0.1:9038",
  bucket: "polka-local",
  accessKey: "polka-local",
};

test("local storage bootstrap accepts only the generated loopback target", () => {
  assert.doesNotThrow(() => assertLocalStorageBootstrapTarget(generatedTarget));
  assert.doesNotThrow(() =>
    assertLocalStorageBootstrapTarget({
      ...generatedTarget,
      endpoint: "http://localhost:9038",
    }),
  );

  for (const target of [
    { ...generatedTarget, endpoint: "https://storage.example:9038" },
    { ...generatedTarget, endpoint: "http://127.0.0.1:9000" },
    { ...generatedTarget, endpoint: "http://127.0.0.1:9038/path" },
    { ...generatedTarget, endpoint: "http://127.0.0.1:9038?host=remote" },
    { ...generatedTarget, bucket: "production" },
    { ...generatedTarget, accessKey: "production" },
  ])
    assert.throws(
      () => assertLocalStorageBootstrapTarget(target),
      /generated loopback target/,
    );
});

test("local bootstrap provisions storage before running its capability check", async () => {
  const calls: string[] = [];
  await runLocalStorageBootstrap(generatedTarget, {
    provision: async () => {
      calls.push("provision");
    },
    check: async () => {
      calls.push("check");
    },
  });
  assert.deepEqual(calls, ["provision", "check"]);

  await assert.rejects(
    runLocalStorageBootstrap(generatedTarget, {
      provision: async () => {
        throw new Error("provision failed");
      },
      check: async () => {
        calls.push("unexpected check");
      },
    }),
    /provision failed/,
  );
  assert.doesNotMatch(calls.join(","), /unexpected/);
});

test("database migrator has no storage provisioning dependency", async () => {
  const source = await readFile(
    new URL("../scripts/migrate.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /prepareBucket|storage\.ts|\bS3_/);
  assert.match(source, /SCHEMA_MIGRATIONS/);
});
