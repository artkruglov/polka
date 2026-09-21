import assert from "node:assert/strict";
import test from "node:test";
import {
  createMaintenanceObjectStore,
} from "../scripts/maintenance-adapters.ts";
import { MaintenanceStorageFailure } from "../scripts/maintenance-cleanup.ts";

const storage = (response: unknown) =>
  createMaintenanceObjectStore(
    {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      accessKey: "test",
      secretKey: "test-secret-0000",
      bucket: "test-bucket",
    },
    {
      createClient: () => ({
        async send() { return response; },
        destroy() {},
      }),
    },
  );

test("maintenance object listing requires an explicit complete/truncated result", async () => {
  const signal = new AbortController().signal;
  for (const malformed of [
    {},
    { IsTruncated: null },
    { IsTruncated: false, Versions: null },
    { IsTruncated: false, DeleteMarkers: {} },
    { IsTruncated: false, Versions: [{}] },
    { IsTruncated: false, DeleteMarkers: [{ Key: "key", VersionId: "null" }] },
  ]) {
    const client = storage(malformed);
    await assert.rejects(
      client.listVersions({ prefix: "tenant/", maxKeys: 100 }, signal),
      MaintenanceStorageFailure,
    );
    client.close();
  }
  const valid = storage({ IsTruncated: false });
  assert.deepEqual(
    await valid.listVersions({ prefix: "tenant/", maxKeys: 100 }, signal),
    {
      versions: [],
      deleteMarkers: [],
      truncated: false,
      nextKeyMarker: undefined,
      nextVersionIdMarker: undefined,
    },
  );
  valid.close();
});
